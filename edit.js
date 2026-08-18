const { PDFDocument, StandardFonts, rgb, LineCapStyle, BlendMode, PDFName, PDFArray, PDFRawStream } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const DISPLAY_WIDTH = 760; // fixed CSS px width pages are rendered at
const HIGHLIGHT_OPACITY = 0.4;
const MAX_HISTORY = 60;

const editorUpload = document.getElementById('editorUpload');
const editorFileInput = document.getElementById('editorFileInput');
const editorWorkspace = document.getElementById('editorWorkspace');
const pagesContainer = document.getElementById('pagesContainer');
const editorStatus = document.getElementById('editorStatus');

const toolButtons = Array.from(document.querySelectorAll('.tool-btn[data-tool]'));
const PLACE_ON_CLICK = new Set(['text', 'date', 'checkmark', 'cross', 'formtext', 'formcheckbox']);
const DRAG_TO_CREATE = new Set(['whiteout', 'highlight', 'draw', 'line', 'arrow']);
const MODAL_TOOLS = new Set(['signature', 'initials']);

const modeTabs = Array.from(document.querySelectorAll('.mode-tab[data-mode]'));
const canvasToolbar = document.getElementById('canvasToolbar');
const toolbarModeGroups = Array.from(document.querySelectorAll('.toolbar-group[data-modes]'));
const deletePagesView = document.getElementById('deletePagesView');
const deletePagesGrid = document.getElementById('deletePagesGrid');
const deletePagesCount = document.getElementById('deletePagesCount');
const deletePagesBtn = document.getElementById('deletePagesBtn');

const MODE_DEFAULT_TOOL = { edit: 'select', fillsign: 'select', forms: 'select', deletepages: 'select' };

const fontFamilyField = document.getElementById('fontFamilyField');
const fontSizeField = document.getElementById('fontSizeField');
const fontStyleField = document.getElementById('fontStyleField');
const strokeWidthField = document.getElementById('strokeWidthField');
const colorField = document.getElementById('colorField');
const dateFormatField = document.getElementById('dateFormatField');
const fontFamilyInput = document.getElementById('fontFamilyInput');
const fontSizeInput = document.getElementById('fontSizeInput');
const boldToggleBtn = document.getElementById('boldToggleBtn');
const italicToggleBtn = document.getElementById('italicToggleBtn');
const strokeWidthInput = document.getElementById('strokeWidthInput');
const colorInput = document.getElementById('colorInput');
const dateFormatInput = document.getElementById('dateFormatInput');

// Maps our 3 supported families to pdf-lib's standard-14 font variants, and to a matching
// CSS font stack so the on-screen editable box looks like the exported PDF text too.
const FONT_VARIANTS = {
  helvetica: { regular: 'Helvetica', bold: 'HelveticaBold', italic: 'HelveticaOblique', boldItalic: 'HelveticaBoldOblique' },
  times: { regular: 'TimesRoman', bold: 'TimesRomanBold', italic: 'TimesRomanItalic', boldItalic: 'TimesRomanBoldItalic' },
  courier: { regular: 'Courier', bold: 'CourierBold', italic: 'CourierOblique', boldItalic: 'CourierBoldOblique' },
};
const FONT_CSS_STACK = {
  helvetica: 'Helvetica, Arial, sans-serif',
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
};

function classifyFontFamily(cssFontFamily) {
  const f = (cssFontFamily || '').toLowerCase();
  if (f.includes('monospace') || f.includes('courier') || f.includes('consolas')) return 'courier';
  if (f.includes('sans-serif') || f.includes('helvetica') || f.includes('arial')) return 'helvetica';
  if (f.includes('serif') || f.includes('times') || f.includes('georgia') || f.includes('garamond')) return 'times';
  return 'helvetica';
}

const deleteObjectBtn = document.getElementById('deleteObjectBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const editorClearBtn = document.getElementById('editorClearBtn');
const editorDownloadBtn = document.getElementById('editorDownloadBtn');
const imageFileInput = document.getElementById('imageFileInput');

const toolDefaults = {
  text: { color: '#1f2430', fontSize: 16, fontFamily: 'helvetica', bold: false, italic: false },
  date: { color: '#1f2430', fontSize: 14, fontFamily: 'helvetica', bold: false, italic: false },
  whiteout: { color: '#ffffff' },
  highlight: { color: '#ffeb3b' },
  draw: { color: '#1f2430', strokeWidth: 3 },
  line: { color: '#1f2430', strokeWidth: 3 },
  arrow: { color: '#1f2430', strokeWidth: 3 },
  checkmark: { color: '#16a34a' },
  cross: { color: '#dc2626' },
  formtext: { color: '#2563eb' },
  formcheckbox: { color: '#2563eb' },
};

const CHECK_SEGMENTS = [[{ x: 18, y: 52 }, { x: 40, y: 74 }, { x: 84, y: 22 }]];
const CROSS_SEGMENTS = [[{ x: 22, y: 22 }, { x: 78, y: 78 }], [{ x: 78, y: 22 }, { x: 22, y: 78 }]];

let file = null;
let pdfjsDoc = null;
let pages = []; // { pageNum, pdfWidth, pdfHeight, displayScale, overlayEl, wrapEl }
let objects = []; // see createObject() for shape
let objectCounter = 0;
let selectedId = null;
let currentTool = 'select';
let currentDateFormat = 'MM/DD/YYYY';
let currentMode = 'edit';
let pagesMarkedForDeletion = new Set();
let lastMouseDownInfo = null; // { objId, time } — drives manual double-click detection, see attachObjectHandlers

let historyStack = [];
let historyIndex = -1;
let suppressHistory = false;

// ---------- Upload ----------

editorUpload.addEventListener('click', () => editorFileInput.click());

editorUpload.addEventListener('dragover', (e) => {
  e.preventDefault();
  editorUpload.classList.add('dragover');
});

editorUpload.addEventListener('dragleave', () => {
  editorUpload.classList.remove('dragover');
});

editorUpload.addEventListener('drop', (e) => {
  e.preventDefault();
  editorUpload.classList.remove('dragover');
  const dropped = Array.from(e.dataTransfer.files).find(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (dropped) loadFile(dropped);
  else setStatus('Please drop a PDF file.', true);
});

editorFileInput.addEventListener('change', () => {
  const f = editorFileInput.files[0];
  if (f) loadFile(f);
  editorFileInput.value = '';
});

async function loadFile(f) {
  file = f;
  setStatus('Loading...');
  try {
    const buf = await f.arrayBuffer();
    pdfjsDoc = await pdfjsLib.getDocument({ data: buf }).promise;
  } catch (err) {
    console.error(err);
    setStatus('Failed to open this PDF. It may be corrupted.', true);
    return;
  }

  editorUpload.hidden = true;
  editorWorkspace.hidden = false;
  setStatus('');
  await renderAllPages();
  currentMode = 'edit';
  modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === 'edit'));
  applyModeVisibility();
  currentTool = 'select';
  updateToolButtons();
  resetHistory();
}

async function renderAllPages() {
  pagesContainer.innerHTML = '';
  pages = [];
  for (let i = 1; i <= pdfjsDoc.numPages; i++) {
    await renderPage(i);
  }
}

async function renderPage(pageNum) {
  const page = await pdfjsDoc.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const displayScale = DISPLAY_WIDTH / baseViewport.width;
  const cssHeight = baseViewport.height * displayScale;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const renderViewport = page.getViewport({ scale: displayScale * dpr });

  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';
  wrap.style.width = DISPLAY_WIDTH + 'px';
  wrap.style.height = cssHeight + 'px';

  const tag = document.createElement('span');
  tag.className = 'page-number-tag';
  tag.textContent = `Page ${pageNum}`;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(renderViewport.width);
  canvas.height = Math.round(renderViewport.height);
  canvas.style.width = DISPLAY_WIDTH + 'px';
  canvas.style.height = cssHeight + 'px';
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderViewport }).promise;

  const textLayer = document.createElement('div');
  textLayer.className = 'text-layer';

  const overlay = document.createElement('div');
  overlay.className = 'page-overlay';

  wrap.appendChild(tag);
  wrap.appendChild(canvas);
  wrap.appendChild(textLayer);
  wrap.appendChild(overlay);
  pagesContainer.appendChild(wrap);

  pages.push({
    pageNum,
    pdfWidth: baseViewport.width,
    pdfHeight: baseViewport.height,
    displayScale,
    overlayEl: overlay,
    wrapEl: wrap,
    canvasEl: canvas,
    textLayerEl: textLayer,
  });

  overlay.addEventListener('mousedown', (e) => handleOverlayMouseDown(e, pageNum, overlay));

  const textViewport = page.getViewport({ scale: displayScale });
  textLayer.style.setProperty('--scale-factor', String(displayScale));
  try {
    const textContent = await page.getTextContent();
    await pdfjsLib.renderTextLayer({ textContentSource: textContent, container: textLayer, viewport: textViewport }).promise;
  } catch (err) {
    console.error('Text layer render failed', err);
  }

  textLayer.addEventListener('click', (e) => handleTextLayerClick(e, pageNum, overlay, textLayer));
}

// ---------- Tool switching ----------

toolButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;
    if (MODAL_TOOLS.has(tool)) {
      openSignModal(tool);
      return;
    }
    if (tool === 'image') {
      imageFileInput.click();
      return;
    }
    currentTool = tool;
    updateToolButtons();
    deselectAll();
  });
});

imageFileInput.addEventListener('change', async () => {
  const f = imageFileInput.files[0];
  imageFileInput.value = '';
  if (!f) return;
  const dataUrl = await fileToDataUrl(f);
  const dims = await imageDataUrlSize(dataUrl);
  placeImageObject('image', dataUrl, dims.width, dims.height);
  currentTool = 'select';
  updateToolButtons();
});

// ---------- Mode switching (Edit / Fill & Sign / Create Forms / Delete Pages) ----------

modeTabs.forEach(tab => {
  tab.addEventListener('click', () => switchMode(tab.dataset.mode));
});
applyModeVisibility();

function switchMode(mode) {
  if (mode === currentMode) return;
  currentMode = mode;
  modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  currentTool = 'select';
  deselectAll();
  applyModeVisibility();
  updateToolButtons();
  if (mode === 'deletepages') renderDeletePagesGrid();
}

function applyModeVisibility() {
  const showCanvas = currentMode !== 'deletepages';
  // .editor-toolbar/.pages-container set `display: flex` as an author style, which beats the
  // UA [hidden] rule regardless of specificity — so the `hidden` attribute alone does nothing
  // here. Toggle `display` directly instead (see also dateFormatField's fix for the same issue).
  canvasToolbar.style.display = showCanvas ? '' : 'none';
  pagesContainer.style.display = showCanvas ? '' : 'none';
  deletePagesView.hidden = showCanvas;
  toolbarModeGroups.forEach(g => {
    g.classList.toggle('mode-active', (g.dataset.modes || '').split(' ').includes(currentMode));
  });
}

// ---------- Delete Pages mode ----------

async function renderDeletePagesGrid() {
  pagesMarkedForDeletion = new Set();
  deletePagesGrid.innerHTML = '';
  updateDeletePagesFooter();

  for (let i = 1; i <= pdfjsDoc.numPages; i++) {
    const page = await pdfjsDoc.getPage(i);
    const baseViewport = page.getViewport({ scale: 1 });
    const thumbScale = 150 / baseViewport.width;
    const thumbViewport = page.getViewport({ scale: thumbScale });

    const card = document.createElement('div');
    card.className = 'page-card';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'page-thumb-wrap';
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(thumbViewport.width);
    canvas.height = Math.round(thumbViewport.height);
    thumbWrap.appendChild(canvas);

    const indexTag = document.createElement('span');
    indexTag.className = 'page-index';
    indexTag.textContent = i;

    card.appendChild(thumbWrap);
    card.appendChild(indexTag);
    deletePagesGrid.appendChild(card);

    card.addEventListener('click', () => {
      if (pagesMarkedForDeletion.has(i)) pagesMarkedForDeletion.delete(i);
      else pagesMarkedForDeletion.add(i);
      card.classList.toggle('marked-delete', pagesMarkedForDeletion.has(i));
      updateDeletePagesFooter();
    });

    await page.render({ canvasContext: canvas.getContext('2d'), viewport: thumbViewport }).promise;
  }
}

function updateDeletePagesFooter() {
  const n = pagesMarkedForDeletion.size;
  const total = pdfjsDoc ? pdfjsDoc.numPages : 0;
  if (n === 0) {
    deletePagesCount.textContent = 'No pages selected';
  } else if (n >= total) {
    deletePagesCount.textContent = `${n} selected — can't delete every page`;
  } else {
    deletePagesCount.textContent = `${n} page${n === 1 ? '' : 's'} selected`;
  }
  deletePagesBtn.disabled = n === 0 || n >= total;
}

deletePagesBtn.addEventListener('click', async () => {
  const n = pagesMarkedForDeletion.size;
  if (n === 0) return;
  const proceed = window.confirm(
    `Delete ${n} page${n === 1 ? '' : 's'}? This clears any edits, signatures, or fields you've already placed on this document.`
  );
  if (!proceed) return;

  deletePagesBtn.disabled = true;
  setStatus('Deleting pages...');
  try {
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const indices = Array.from(pagesMarkedForDeletion).map(num => num - 1).sort((a, b) => b - a);
    indices.forEach(idx => doc.removePage(idx));
    const outBytes = await doc.save();

    file = new File([outBytes], file.name || 'document.pdf', { type: 'application/pdf' });
    pdfjsDoc = await pdfjsLib.getDocument({ data: outBytes }).promise;

    objects.forEach(o => { if (o.sourceSpan) delete o.sourceSpan.dataset.covered; });
    objects = [];
    objectCounter = 0;
    selectedId = null;

    await renderAllPages();
    resetHistory();

    currentMode = 'edit';
    modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === 'edit'));
    currentTool = 'select';
    applyModeVisibility();
    updateToolButtons();

    setStatus(`Deleted ${n} page${n === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to delete pages: ${err.message}`, true);
  } finally {
    deletePagesBtn.disabled = false;
  }
});

// ---------- Format panel ----------

fontSizeInput.addEventListener('input', () => {
  const size = Math.max(6, parseInt(fontSizeInput.value, 10) || 16);
  const obj = getSelectedObject();
  if (obj && obj.type in { text: 1, date: 1 }) {
    obj.fontSize = size;
    textTargetEl(obj).style.fontSize = size + 'px';
  } else {
    toolDefaults[currentTool] && (toolDefaults[currentTool].fontSize = size);
  }
});
fontSizeInput.addEventListener('change', () => pushHistory());

fontFamilyInput.addEventListener('change', () => {
  const family = fontFamilyInput.value;
  const obj = getSelectedObject();
  if (obj && obj.type in { text: 1, date: 1 }) {
    obj.fontFamily = family;
    applyTextFontCss(obj);
  } else {
    toolDefaults[currentTool] && (toolDefaults[currentTool].fontFamily = family);
  }
  pushHistory();
});

boldToggleBtn.addEventListener('click', () => {
  const obj = getSelectedObject();
  if (obj && obj.type in { text: 1, date: 1 }) {
    obj.bold = !obj.bold;
    applyTextFontCss(obj);
    boldToggleBtn.classList.toggle('active', obj.bold);
  } else if (toolDefaults[currentTool]) {
    toolDefaults[currentTool].bold = !toolDefaults[currentTool].bold;
    boldToggleBtn.classList.toggle('active', toolDefaults[currentTool].bold);
  }
  pushHistory();
});

italicToggleBtn.addEventListener('click', () => {
  const obj = getSelectedObject();
  if (obj && obj.type in { text: 1, date: 1 }) {
    obj.italic = !obj.italic;
    applyTextFontCss(obj);
    italicToggleBtn.classList.toggle('active', obj.italic);
  } else if (toolDefaults[currentTool]) {
    toolDefaults[currentTool].italic = !toolDefaults[currentTool].italic;
    italicToggleBtn.classList.toggle('active', toolDefaults[currentTool].italic);
  }
  pushHistory();
});

colorInput.addEventListener('input', () => {
  const color = colorInput.value;
  const obj = getSelectedObject();
  if (obj) {
    obj.color = color;
    applyObjectStyle(obj);
  } else if (toolDefaults[currentTool]) {
    toolDefaults[currentTool].color = color;
  }
});
colorInput.addEventListener('change', () => pushHistory());

strokeWidthInput.addEventListener('input', () => {
  const width = Math.max(1, parseInt(strokeWidthInput.value, 10) || 3);
  const obj = getSelectedObject();
  if (obj && 'strokeWidth' in obj) {
    obj.strokeWidth = width;
    applyObjectStyle(obj);
  } else if (toolDefaults[currentTool]) {
    toolDefaults[currentTool].strokeWidth = width;
  }
});
strokeWidthInput.addEventListener('change', () => pushHistory());

dateFormatInput.addEventListener('change', () => {
  currentDateFormat = dateFormatInput.value;
  const obj = getSelectedObject();
  if (obj && obj.type === 'date') {
    obj.dateFormat = currentDateFormat;
    textTargetEl(obj).textContent = formatDate(new Date(), currentDateFormat);
    pushHistory();
  }
});

deleteObjectBtn.addEventListener('click', () => {
  if (selectedId) {
    deleteObject(selectedId);
    pushHistory();
  }
});

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

editorClearBtn.addEventListener('click', () => {
  file = null;
  pdfjsDoc = null;
  pages = [];
  objects = [];
  objectCounter = 0;
  selectedId = null;
  currentTool = 'select';
  currentMode = 'edit';
  pagesMarkedForDeletion = new Set();
  modeTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === 'edit'));
  applyModeVisibility();
  pagesContainer.innerHTML = '';
  updateToolButtons();
  editorWorkspace.hidden = true;
  editorUpload.hidden = false;
  resetHistory();
  setStatus('');
});

editorDownloadBtn.addEventListener('click', exportPdf);

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
    const active = document.activeElement;
    const isEditingText = active && active.isContentEditable;
    if (isEditingText) return;
    e.preventDefault();
    deleteObject(selectedId);
    pushHistory();
    return;
  }
  if (e.key === 'Escape') {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    deselectAll();
  }
  const meta = e.ctrlKey || e.metaKey;
  if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    const active = document.activeElement;
    if (active && active.isContentEditable) return;
    e.preventDefault();
    undo();
  } else if (meta && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    const active = document.activeElement;
    if (active && active.isContentEditable) return;
    e.preventDefault();
    redo();
  }
});

// ---------- Overlay interaction (create objects) ----------

function handleOverlayMouseDown(e, pageNum, overlay) {
  const rect = overlay.getBoundingClientRect();
  const startX = e.clientX - rect.left;
  const startY = e.clientY - rect.top;

  if (currentTool === 'text' || currentTool === 'date') {
    e.preventDefault();
    const obj = createTextObject(pageNum, overlay, startX, startY, currentTool === 'date');
    selectObject(obj.id);
    currentTool = 'select';
    updateToolButtons();
    pushHistory();
    return;
  }

  if (currentTool === 'checkmark' || currentTool === 'cross') {
    e.preventDefault();
    const obj = createIconObject(pageNum, overlay, startX, startY, currentTool);
    selectObject(obj.id);
    currentTool = 'select';
    updateToolButtons();
    pushHistory();
    return;
  }

  if (currentTool === 'formtext' || currentTool === 'formcheckbox') {
    e.preventDefault();
    const obj = createFormFieldObject(pageNum, overlay, startX, startY, currentTool);
    selectObject(obj.id);
    currentTool = 'select';
    updateToolButtons();
    pushHistory();
    return;
  }

  if (currentTool === 'whiteout' || currentTool === 'highlight') {
    e.preventDefault();
    startBoxDrag(pageNum, overlay, startX, startY, currentTool);
    return;
  }

  if (currentTool === 'draw') {
    e.preventDefault();
    startFreehandDraw(pageNum, overlay, e);
    return;
  }

  if (currentTool === 'line' || currentTool === 'arrow') {
    e.preventDefault();
    startLineDrag(pageNum, overlay, startX, startY, currentTool);
    return;
  }

  deselectAll();
}

// ---------- Text / Date ----------

// A text-edit object's resize handle lives as a sibling of the contentEditable region
// (see startTextEdit) rather than inside it — nesting it inside was tried first, but
// Chromium's native "select all + retype" treats the handle as ordinary editable content
// and deletes it. `obj.el` is always the positioned/sized/draggable box; `textTargetEl`
// resolves to whichever element actually holds the editable text within it.
function textTargetEl(obj) {
  return (obj.isTextEdit && obj.textEl) ? obj.textEl : obj.el;
}

function applyTextFontCss(obj) {
  const target = textTargetEl(obj);
  target.style.fontFamily = FONT_CSS_STACK[obj.fontFamily] || FONT_CSS_STACK.helvetica;
  target.style.fontWeight = obj.bold ? '700' : '400';
  target.style.fontStyle = obj.italic ? 'italic' : 'normal';
}

function createTextObject(pageNum, overlay, x, y, isDate) {
  const id = 'obj-' + (++objectCounter);
  const defaults = toolDefaults[isDate ? 'date' : 'text'];
  const el = document.createElement('div');
  el.className = 'edit-object edit-text';
  el.contentEditable = 'true';
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.fontSize = defaults.fontSize + 'px';
  el.style.color = defaults.color;
  el.dataset.id = id;
  overlay.appendChild(el);

  const obj = {
    id, pageNum, type: isDate ? 'date' : 'text',
    x, y, fontSize: defaults.fontSize, color: defaults.color,
    fontFamily: defaults.fontFamily, bold: defaults.bold, italic: defaults.italic,
    dateFormat: currentDateFormat,
    el,
  };
  applyTextFontCss(obj);

  if (isDate) {
    el.textContent = formatDate(new Date(), currentDateFormat);
    el.contentEditable = 'false';
  }

  objects.push(obj);
  attachObjectHandlers(obj);

  if (!isDate) requestAnimationFrame(() => el.focus());

  return obj;
}

function formatDate(d, fmt) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  switch (fmt) {
    case 'DD/MM/YYYY': return `${dd}/${mm}/${yyyy}`;
    case 'YYYY-MM-DD': return `${yyyy}-${mm}-${dd}`;
    case 'Month D, YYYY': return `${monthNames[d.getMonth()]} ${d.getDate()}, ${yyyy}`;
    default: return `${mm}/${dd}/${yyyy}`;
  }
}

// ---------- Existing-text editing (click text detected by pdf.js) ----------

function handleTextLayerClick(e, pageNum, overlay, textLayer) {
  if (currentMode !== 'edit' || currentTool !== 'select') return;
  const span = e.target.closest('span');
  if (!span || !textLayer.contains(span)) return;
  if (!span.textContent || !span.textContent.trim()) return;
  if (span.dataset.covered === 'true') return;
  startTextEdit(span, pageNum, overlay);
}

function sampleBackgroundColor(pageInfo, overlayX, overlayY) {
  try {
    const canvas = pageInfo.canvasEl;
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    const px = Math.max(0, Math.min(canvas.width - 1, Math.round(overlayX * scaleX)));
    const py = Math.max(0, Math.min(canvas.height - 1, Math.round(overlayY * scaleY)));
    const data = canvas.getContext('2d').getImageData(px, py, 1, 1).data;
    return `#${[data[0], data[1], data[2]].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  } catch (err) {
    return '#ffffff';
  }
}

// Picks the pixel within the text's bounding box that differs most from the sampled
// background — a decent proxy for the glyph ink color without needing true OCR/vector data.
function sampleInkColor(pageInfo, overlayX, overlayY, width, height, bgColorHex) {
  try {
    const canvas = pageInfo.canvasEl;
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    const px0 = Math.max(0, Math.round(overlayX * scaleX));
    const py0 = Math.max(0, Math.round(overlayY * scaleY));
    const pw = Math.max(1, Math.min(canvas.width - px0, Math.round(width * scaleX)));
    const ph = Math.max(1, Math.min(canvas.height - py0, Math.round(height * scaleY)));
    const data = canvas.getContext('2d').getImageData(px0, py0, pw, ph).data;
    const bg = [
      parseInt(bgColorHex.slice(1, 3), 16),
      parseInt(bgColorHex.slice(3, 5), 16),
      parseInt(bgColorHex.slice(5, 7), 16),
    ];
    let best = null;
    let bestDist = -1;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const dist = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);
      if (dist > bestDist) { bestDist = dist; best = [r, g, b]; }
    }
    if (!best || bestDist < 40) return '#000000';
    return `#${best.map(v => v.toString(16).padStart(2, '0')).join('')}`;
  } catch (err) {
    return '#000000';
  }
}

function startTextEdit(span, pageNum, overlay) {
  const pageInfo = pages.find(p => p.pageNum === pageNum);
  if (!pageInfo) return;

  const overlayRect = overlay.getBoundingClientRect();
  const spanRect = span.getBoundingClientRect();
  const x = spanRect.left - overlayRect.left;
  const y = spanRect.top - overlayRect.top;
  const width = Math.max(20, spanRect.width);
  const height = Math.max(12, spanRect.height);
  const computed = getComputedStyle(span);
  const fontSize = Math.round(parseFloat(computed.fontSize)) || 14;
  const fontFamily = classifyFontFamily(computed.fontFamily);
  const originalText = span.textContent;

  const coverColor = sampleBackgroundColor(pageInfo, x + 1, y + 1);
  const color = sampleInkColor(pageInfo, x, y, width, height, coverColor);

  span.dataset.covered = 'true';

  const id = 'obj-' + (++objectCounter);

  // The visible/editable box is freely draggable and resizable (see startResize) so you can
  // nudge it if the detected position isn't quite right — but the ORIGINAL text must stay
  // hidden no matter where that box ends up. So a separate, fixed, non-interactive backdrop
  // sits behind it at the original text's exact position and never moves; the draggable box
  // is just what carries the replacement text on top of it.
  const coverEl = document.createElement('div');
  coverEl.className = 'text-edit-cover';
  coverEl.style.left = x + 'px';
  coverEl.style.top = y + 'px';
  coverEl.style.width = width + 'px';
  coverEl.style.height = height + 'px';
  coverEl.style.background = coverColor;
  overlay.appendChild(coverEl);

  // The resize handles must NOT live inside the contentEditable region (see textTargetEl's
  // comment), so they're siblings of the text content div, both inside a plain (non-editable)
  // positioned wrapper.
  const el = document.createElement('div');
  el.className = 'edit-object edit-text text-edit';
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = width + 'px';
  el.style.minHeight = height + 'px';
  el.style.background = coverColor;
  el.dataset.id = id;

  const textEl = document.createElement('div');
  textEl.className = 'text-edit-content';
  textEl.contentEditable = 'true';
  textEl.style.fontSize = fontSize + 'px';
  textEl.style.color = color;
  textEl.textContent = originalText;
  el.appendChild(textEl);

  addResizeHandles(el);
  overlay.appendChild(el);

  const obj = {
    id, pageNum, type: 'text',
    x, y, width, height, fontSize, color,
    coverX: x, coverY: y, coverWidth: width, coverHeight: height,
    fontFamily, bold: false, italic: false,
    isTextEdit: true, coverColor, sourceSpan: span, originalText,
    el, textEl, coverEl,
  };
  applyTextFontCss(obj);
  objects.push(obj);
  attachObjectHandlers(obj, true);
  selectObject(id);
  pushHistory();

  requestAnimationFrame(() => {
    textEl.focus();
    const range = document.createRange();
    range.selectNodeContents(textEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

// ---------- Whiteout / Highlight (drag rectangle) ----------

function startBoxDrag(pageNum, overlay, startX, startY, type) {
  const defaults = toolDefaults[type];
  const el = document.createElement('div');
  el.className = 'edit-object edit-' + type;
  el.style.left = startX + 'px';
  el.style.top = startY + 'px';
  el.style.width = '0px';
  el.style.height = '0px';
  el.style.background = defaults.color;
  if (type === 'highlight') {
    el.style.opacity = HIGHLIGHT_OPACITY;
    el.style.mixBlendMode = 'multiply';
  }
  overlay.appendChild(el);

  function onMove(ev) {
    const rect = overlay.getBoundingClientRect();
    const curX = ev.clientX - rect.left;
    const curY = ev.clientY - rect.top;
    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    const width = parseFloat(el.style.width);
    const height = parseFloat(el.style.height);

    if (width < 4 || height < 4) {
      el.remove();
      currentTool = 'select';
      updateToolButtons();
      return;
    }

    const id = 'obj-' + (++objectCounter);
    el.dataset.id = id;
    addResizeHandles(el);
    const obj = {
      id, pageNum, type,
      x: parseFloat(el.style.left), y: parseFloat(el.style.top),
      width, height, color: defaults.color,
      el,
    };
    objects.push(obj);
    attachObjectHandlers(obj, true);
    selectObject(id);

    currentTool = 'select';
    updateToolButtons();
    pushHistory();
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ---------- Checkmark / Cross ----------

function createIconObject(pageNum, overlay, x, y, type) {
  const id = 'obj-' + (++objectCounter);
  const defaults = toolDefaults[type];
  const size = 34;
  const el = document.createElement('div');
  el.className = 'edit-object edit-icon';
  el.style.left = (x - size / 2) + 'px';
  el.style.top = (y - size / 2) + 'px';
  el.style.width = size + 'px';
  el.style.height = size + 'px';
  el.dataset.id = id;

  const svg = buildIconSvg(type, defaults.color);
  el.appendChild(svg);
  addResizeHandles(el);
  overlay.appendChild(el);

  const obj = {
    id, pageNum, type,
    x: x - size / 2, y: y - size / 2, width: size, height: size,
    color: defaults.color,
    el, svgEl: svg,
  };
  objects.push(obj);
  attachObjectHandlers(obj, true);
  return obj;
}

function buildIconSvg(type, color) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('icon-svg');
  const segments = type === 'checkmark' ? CHECK_SEGMENTS : CROSS_SEGMENTS;
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', segments.map(seg => 'M' + seg.map(p => `${p.x},${p.y}`).join(' L')).join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '12');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

// ---------- Create Forms: fillable field placeholders ----------

function createFormFieldObject(pageNum, overlay, x, y, type) {
  const id = 'obj-' + (++objectCounter);
  const defaults = toolDefaults[type];
  const isCheckbox = type === 'formcheckbox';
  const width = isCheckbox ? 24 : 170;
  const height = isCheckbox ? 24 : 30;

  const el = document.createElement('div');
  el.className = 'edit-object edit-formfield ' + (isCheckbox ? 'edit-formcheckbox' : 'edit-formtext');
  el.style.left = (x - width / 2) + 'px';
  el.style.top = (y - height / 2) + 'px';
  el.style.width = width + 'px';
  el.style.height = height + 'px';
  el.style.borderColor = defaults.color;
  el.style.background = hexToRgba(defaults.color, 0.08);
  el.dataset.id = id;

  const label = document.createElement('span');
  label.className = 'formfield-label';
  label.style.color = defaults.color;
  label.textContent = isCheckbox ? '' : 'Text Field';
  el.appendChild(label);
  addResizeHandles(el);
  el.querySelectorAll('.resize-handle').forEach(h => { h.style.background = defaults.color; });
  overlay.appendChild(el);

  const obj = {
    id, pageNum, type,
    x: x - width / 2, y: y - height / 2, width, height,
    color: defaults.color, fieldName: (isCheckbox ? 'Checkbox_' : 'TextField_') + id,
    el, labelEl: label,
  };
  objects.push(obj);
  attachObjectHandlers(obj, true);
  return obj;
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------- Freehand draw ----------

function startFreehandDraw(pageNum, overlay, downEvent) {
  const defaults = toolDefaults.draw;
  const rect = overlay.getBoundingClientRect();
  const points = [{ x: downEvent.clientX - rect.left, y: downEvent.clientY - rect.top }];

  const svgNS = 'http://www.w3.org/2000/svg';
  const previewSvg = document.createElementNS(svgNS, 'svg');
  previewSvg.classList.add('draw-preview');
  previewSvg.style.position = 'absolute';
  previewSvg.style.inset = '0';
  previewSvg.style.width = '100%';
  previewSvg.style.height = '100%';
  previewSvg.style.pointerEvents = 'none';
  const previewPath = document.createElementNS(svgNS, 'path');
  previewPath.setAttribute('fill', 'none');
  previewPath.setAttribute('stroke', defaults.color);
  previewPath.setAttribute('stroke-width', String(defaults.strokeWidth));
  previewPath.setAttribute('stroke-linecap', 'round');
  previewPath.setAttribute('stroke-linejoin', 'round');
  previewSvg.appendChild(previewPath);
  overlay.appendChild(previewSvg);

  function pathD() {
    return 'M' + points.map(p => `${p.x},${p.y}`).join(' L');
  }
  previewPath.setAttribute('d', pathD());

  function onMove(ev) {
    const r = overlay.getBoundingClientRect();
    points.push({ x: ev.clientX - r.left, y: ev.clientY - r.top });
    previewPath.setAttribute('d', pathD());
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    previewSvg.remove();

    if (points.length < 2) {
      currentTool = 'select';
      updateToolButtons();
      return;
    }

    const pad = defaults.strokeWidth + 4;
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
    const width = maxX - minX, height = maxY - minY;
    const localPoints = points.map(p => ({ x: p.x - minX, y: p.y - minY }));

    const id = 'obj-' + (++objectCounter);
    const el = document.createElement('div');
    el.className = 'edit-object edit-draw';
    el.style.left = minX + 'px';
    el.style.top = minY + 'px';
    el.style.width = width + 'px';
    el.style.height = height + 'px';
    el.dataset.id = id;

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.classList.add('vector-svg');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M' + localPoints.map(p => `${p.x},${p.y}`).join(' L'));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', defaults.color);
    path.setAttribute('stroke-width', String(defaults.strokeWidth));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    el.appendChild(svg);
    overlay.appendChild(el);

    const obj = {
      id, pageNum, type: 'draw',
      x: minX, y: minY, width, height,
      color: defaults.color, strokeWidth: defaults.strokeWidth,
      points: localPoints,
      el, svgEl: svg, pathEl: path,
    };
    objects.push(obj);
    attachObjectHandlers(obj);
    selectObject(id);

    currentTool = 'select';
    updateToolButtons();
    pushHistory();
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ---------- Line / Arrow ----------

function startLineDrag(pageNum, overlay, startX, startY, type) {
  const defaults = toolDefaults[type];
  const svgNS = 'http://www.w3.org/2000/svg';
  const previewSvg = document.createElementNS(svgNS, 'svg');
  previewSvg.style.position = 'absolute';
  previewSvg.style.inset = '0';
  previewSvg.style.width = '100%';
  previewSvg.style.height = '100%';
  previewSvg.style.pointerEvents = 'none';
  const previewLine = document.createElementNS(svgNS, 'path');
  previewLine.setAttribute('fill', 'none');
  previewLine.setAttribute('stroke', defaults.color);
  previewLine.setAttribute('stroke-width', String(defaults.strokeWidth));
  previewLine.setAttribute('stroke-linecap', 'round');
  previewSvg.appendChild(previewLine);
  overlay.appendChild(previewSvg);

  let curX = startX, curY = startY;

  function render() {
    previewLine.setAttribute('d', buildLinePathD(startX, startY, curX, curY, type, defaults.strokeWidth));
  }
  render();

  function onMove(ev) {
    const r = overlay.getBoundingClientRect();
    curX = ev.clientX - r.left;
    curY = ev.clientY - r.top;
    render();
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    previewSvg.remove();

    const dist = Math.hypot(curX - startX, curY - startY);
    if (dist < 4) {
      currentTool = 'select';
      updateToolButtons();
      return;
    }

    const obj = createLineObject(pageNum, overlay, startX, startY, curX, curY, type, defaults.color, defaults.strokeWidth);
    selectObject(obj.id);
    currentTool = 'select';
    updateToolButtons();
    pushHistory();
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function createLineObject(pageNum, overlay, x1, y1, x2, y2, type, color, strokeWidth) {
  const id = 'obj-' + (++objectCounter);
  const el = document.createElement('div');
  el.className = 'edit-object edit-line';
  el.dataset.id = id;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('vector-svg');
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', String(strokeWidth));
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  el.appendChild(svg);

  const h1 = document.createElement('div');
  h1.className = 'line-handle line-handle-start';
  const h2 = document.createElement('div');
  h2.className = 'line-handle line-handle-end';
  el.appendChild(h1);
  el.appendChild(h2);

  overlay.appendChild(el);

  const obj = {
    id, pageNum, type,
    x1, y1, x2, y2,
    color, strokeWidth,
    el, svgEl: svg, pathEl: path, handleStart: h1, handleEnd: h2,
  };

  layoutLineObject(obj);
  objects.push(obj);
  attachObjectHandlers(obj);
  attachLineHandle(obj, h1, true);
  attachLineHandle(obj, h2, false);

  return obj;
}

function buildLinePathD(x1, y1, x2, y2, type, strokeWidth) {
  let d = `M${x1},${y1} L${x2},${y2}`;
  if (type === 'arrow') {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = Math.max(10, strokeWidth * 3);
    const spread = 0.5;
    const ax1 = x2 - headLen * Math.cos(angle - spread);
    const ay1 = y2 - headLen * Math.sin(angle - spread);
    const ax2 = x2 - headLen * Math.cos(angle + spread);
    const ay2 = y2 - headLen * Math.sin(angle + spread);
    d += ` M${x2},${y2} L${ax1},${ay1} M${x2},${y2} L${ax2},${ay2}`;
  }
  return d;
}

function layoutLineObject(obj) {
  const pad = obj.strokeWidth + (obj.type === 'arrow' ? Math.max(10, obj.strokeWidth * 3) : 4) + 4;
  const minX = Math.min(obj.x1, obj.x2) - pad;
  const minY = Math.min(obj.y1, obj.y2) - pad;
  const maxX = Math.max(obj.x1, obj.x2) + pad;
  const maxY = Math.max(obj.y1, obj.y2) + pad;
  const width = maxX - minX;
  const height = maxY - minY;

  obj.x = minX;
  obj.y = minY;
  obj.width = width;
  obj.height = height;

  obj.el.style.left = minX + 'px';
  obj.el.style.top = minY + 'px';
  obj.el.style.width = width + 'px';
  obj.el.style.height = height + 'px';
  obj.svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const localX1 = obj.x1 - minX, localY1 = obj.y1 - minY;
  const localX2 = obj.x2 - minX, localY2 = obj.y2 - minY;
  obj.pathEl.setAttribute('d', buildLinePathD(localX1, localY1, localX2, localY2, obj.type, obj.strokeWidth));

  obj.handleStart.style.left = localX1 + 'px';
  obj.handleStart.style.top = localY1 + 'px';
  obj.handleEnd.style.left = localX2 + 'px';
  obj.handleEnd.style.top = localY2 + 'px';
}

function attachLineHandle(obj, handleEl, isStart) {
  handleEl.addEventListener('mousedown', (e) => {
    if (currentTool !== 'select') return;
    e.stopPropagation();
    selectObject(obj.id);
    const overlay = pages.find(p => p.pageNum === obj.pageNum).overlayEl;

    function onMove(ev) {
      const r = overlay.getBoundingClientRect();
      const x = ev.clientX - r.left;
      const y = ev.clientY - r.top;
      if (isStart) { obj.x1 = x; obj.y1 = y; } else { obj.x2 = x; obj.y2 = y; }
      layoutLineObject(obj);
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      pushHistory();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ---------- Image / Signature / Initials placement ----------

function fileToDataUrl(f) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(f);
  });
}

function imageDataUrlSize(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.src = dataUrl;
  });
}

function pickTargetPage() {
  if (!pages.length) return null;
  const containerRect = pagesContainer.getBoundingClientRect();
  const centerY = containerRect.top + containerRect.height / 2;
  let best = pages[0];
  let bestDist = Infinity;
  for (const p of pages) {
    const r = p.wrapEl.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    const dist = Math.abs(mid - centerY);
    if (dist < bestDist) { bestDist = dist; best = p; }
  }
  return best;
}

function placeImageObject(type, dataUrl, naturalWidth, naturalHeight) {
  const page = pickTargetPage();
  if (!page) return;

  const maxDisplayWidth = type === 'image' ? 220 : 180;
  const aspect = naturalHeight / naturalWidth || 0.4;
  let width = Math.min(maxDisplayWidth, page.pdfWidth * page.displayScale * 0.6);
  let height = width * aspect;
  const maxHeight = 160;
  if (height > maxHeight) { height = maxHeight; width = height / aspect; }

  const x = (DISPLAY_WIDTH - width) / 2;
  const y = 60;

  const id = 'obj-' + (++objectCounter);
  const el = document.createElement('div');
  el.className = 'edit-object edit-image';
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = width + 'px';
  el.style.height = height + 'px';
  el.dataset.id = id;

  const img = document.createElement('img');
  img.src = dataUrl;
  img.draggable = false;
  el.appendChild(img);
  addResizeHandles(el);
  page.overlayEl.appendChild(el);

  const obj = {
    id, pageNum: page.pageNum, type,
    x, y, width, height, dataUrl,
    el,
  };
  objects.push(obj);
  attachObjectHandlers(obj, true);
  selectObject(id);
  pushHistory();
}

// ---------- Generic drag / resize / select ----------

// Every resizable object gets the same 8 handles (4 corners + 4 edges), Sejda-style, so it
// can be resized from any side. `dir` (e.g. "se", "n") tells startResize which edges move.
const RESIZE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function addResizeHandles(container) {
  RESIZE_DIRS.forEach(dir => {
    const h = document.createElement('div');
    h.className = 'resize-handle';
    h.dataset.dir = dir;
    container.appendChild(h);
  });
}

function attachObjectHandlers(obj, resizable) {
  obj.el.addEventListener('mousedown', (e) => {
    // While a placement/drawing tool is active, existing objects must not swallow the click —
    // otherwise clicking on top of something already on the page silently selects/drags it
    // instead of placing the new item the active tool intends. Only the Select tool interacts
    // with existing objects; other tools let the click bubble up to handleOverlayMouseDown.
    if (currentTool !== 'select') return;
    if (e.target.classList && (e.target.classList.contains('resize-handle') || e.target.classList.contains('line-handle'))) return;
    e.stopPropagation();

    // Native 'dblclick' detection is unreliable here: selecting a text object can reveal
    // format-panel fields synchronously, reflowing the page mid-gesture so a fast second
    // click lands on a different screen position and the browser never pairs it with the
    // first. Track "two mousedowns on the same object within a beat" ourselves instead —
    // mousedown always fires reliably regardless of any reflow in between. The decision of
    // what a double-click actually MEANS is deferred to mouseup (see startObjectDrag): if
    // the mouse moves, it's a drag (even if it started within the double-click window,
    // e.g. select-then-immediately-drag); only a genuine no-movement second click enters
    // edit mode.
    const isDoubleClick = lastMouseDownInfo
      && lastMouseDownInfo.objId === obj.id
      && Date.now() - lastMouseDownInfo.time < 400;
    lastMouseDownInfo = { objId: obj.id, time: Date.now() };

    selectObject(obj.id);

    if ((obj.type === 'text' || obj.type === 'date') && textTargetEl(obj).isContentEditable) return;
    // A text edit's box is fully draggable/resizable so you can nudge it back into place —
    // the original text stays safely hidden regardless, because that's handled by a
    // separate, fixed backdrop (obj.coverEl) that never moves. See startTextEdit.
    e.preventDefault();
    startObjectDrag(obj, e, isDoubleClick);
  });

  if (obj.type === 'text' || obj.type === 'date') {
    const textEl = textTargetEl(obj);

    textEl.addEventListener('blur', () => {
      textEl.contentEditable = 'false';
      if (!obj.isTextEdit && textEl.textContent.trim() === '') {
        deleteObject(obj.id);
      }
      pushHistory();
    });
  }

  if (resizable) {
    obj.el.querySelectorAll('.resize-handle').forEach(handle => {
      handle.addEventListener('mousedown', (e) => {
        if (currentTool !== 'select') return;
        e.stopPropagation();
        e.preventDefault();
        selectObject(obj.id);
        startResize(obj, e, handle.dataset.dir);
      });
    });
  }
}

function startObjectDrag(obj, e, isDoubleClick) {
  const startMouseX = e.clientX;
  const startMouseY = e.clientY;
  const startX = obj.x;
  const startY = obj.y;
  const isLine = obj.type === 'line' || obj.type === 'arrow';
  const startX1 = obj.x1, startY1 = obj.y1, startX2 = obj.x2, startY2 = obj.y2;
  let moved = false;

  function onMove(ev) {
    const dx = ev.clientX - startMouseX;
    const dy = ev.clientY - startMouseY;
    // A few pixels of jitter shouldn't count as a drag — that's what lets a genuine
    // (no-movement) second click still register as a double-click below.
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    if (isLine) {
      obj.x1 = startX1 + dx; obj.y1 = startY1 + dy;
      obj.x2 = startX2 + dx; obj.y2 = startY2 + dy;
      layoutLineObject(obj);
    } else {
      obj.x = startX + dx;
      obj.y = startY + dy;
      obj.el.style.left = obj.x + 'px';
      obj.el.style.top = obj.y + 'px';
    }
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (moved) {
      pushHistory();
    } else if (isDoubleClick && (obj.type === 'text' || obj.type === 'date')) {
      const textEl = textTargetEl(obj);
      textEl.contentEditable = 'true';
      requestAnimationFrame(() => textEl.focus());
    }
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

const RESIZE_MIN_SIZE = 12;

function startResize(obj, e, dir) {
  const startMouseX = e.clientX;
  const startMouseY = e.clientY;
  const startX = obj.x;
  const startY = obj.y;
  const startW = obj.width;
  const startH = obj.height;

  function onMove(ev) {
    const dx = ev.clientX - startMouseX;
    const dy = ev.clientY - startMouseY;
    let x = startX, y = startY, w = startW, h = startH;

    if (dir.includes('e')) w = Math.max(RESIZE_MIN_SIZE, startW + dx);
    if (dir.includes('w')) { w = Math.max(RESIZE_MIN_SIZE, startW - dx); x = startX + (startW - w); }
    if (dir.includes('s')) h = Math.max(RESIZE_MIN_SIZE, startH + dy);
    if (dir.includes('n')) { h = Math.max(RESIZE_MIN_SIZE, startH - dy); y = startY + (startH - h); }

    obj.x = x;
    obj.y = y;
    obj.width = w;
    obj.height = h;
    obj.el.style.left = x + 'px';
    obj.el.style.top = y + 'px';
    obj.el.style.width = w + 'px';
    if (obj.isTextEdit) obj.el.style.minHeight = h + 'px';
    else obj.el.style.height = h + 'px';
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    pushHistory();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function applyObjectStyle(obj) {
  if (obj.type === 'text' || obj.type === 'date') {
    obj.el.style.color = obj.color;
  } else if (obj.type === 'whiteout' || obj.type === 'highlight') {
    obj.el.style.background = obj.color;
  } else if (obj.type === 'checkmark' || obj.type === 'cross') {
    obj.svgEl.querySelector('path').setAttribute('stroke', obj.color);
  } else if (obj.type === 'draw') {
    obj.pathEl.setAttribute('stroke', obj.color);
    obj.pathEl.setAttribute('stroke-width', String(obj.strokeWidth));
  } else if (obj.type === 'line' || obj.type === 'arrow') {
    obj.pathEl.setAttribute('stroke', obj.color);
    obj.pathEl.setAttribute('stroke-width', String(obj.strokeWidth));
    layoutLineObject(obj);
  } else if (obj.type === 'formtext' || obj.type === 'formcheckbox') {
    obj.el.style.borderColor = obj.color;
    obj.el.style.background = hexToRgba(obj.color, 0.08);
    obj.labelEl.style.color = obj.color;
  }
}

function getSelectedObject() {
  return objects.find(o => o.id === selectedId) || null;
}

function selectObject(id) {
  selectedId = id;
  document.querySelectorAll('.edit-object.selected').forEach(el => el.classList.remove('selected'));
  const obj = objects.find(o => o.id === id);
  if (obj) obj.el.classList.add('selected');
  updateToolbarForSelection();
}

function deselectAll() {
  selectedId = null;
  document.querySelectorAll('.edit-object.selected').forEach(el => el.classList.remove('selected'));
  updateToolbarForSelection();
}

function updateToolbarForSelection() {
  const obj = getSelectedObject();
  deleteObjectBtn.disabled = !obj;

  const type = obj ? obj.type : (PLACE_ON_CLICK.has(currentTool) || DRAG_TO_CREATE.has(currentTool) ? currentTool : null);

  const showFontSize = type === 'text' || type === 'date';
  const showFontStyle = type === 'text' || type === 'date';
  const showStroke = type === 'draw' || type === 'line' || type === 'arrow';
  const showColor = type && type !== 'image' && type !== 'signature' && type !== 'initials';
  const showDateFormat = type === 'date';

  // visibility, not display: hiding these by removing them from layout would change the
  // toolbar's width/wrap and shift the whole page underneath an in-progress click (e.g. the
  // second click of a double-click on a just-selected text edit would then miss its target
  // entirely). visibility:hidden keeps the same space reserved either way.
  fontFamilyField.style.visibility = showFontSize ? '' : 'hidden';
  fontSizeField.style.visibility = showFontSize ? '' : 'hidden';
  fontStyleField.style.visibility = showFontStyle ? '' : 'hidden';
  strokeWidthField.style.visibility = showStroke ? '' : 'hidden';
  colorField.style.visibility = showColor ? '' : 'hidden';
  dateFormatField.style.visibility = showDateFormat ? '' : 'hidden';

  fontFamilyInput.disabled = !showFontSize;
  fontSizeInput.disabled = !showFontSize;
  boldToggleBtn.disabled = !showFontStyle;
  italicToggleBtn.disabled = !showFontStyle;
  strokeWidthInput.disabled = !showStroke;
  colorInput.disabled = !showColor;

  if (obj) {
    if (showFontSize) { fontFamilyInput.value = obj.fontFamily || 'helvetica'; fontSizeInput.value = obj.fontSize; }
    if (showFontStyle) { boldToggleBtn.classList.toggle('active', !!obj.bold); italicToggleBtn.classList.toggle('active', !!obj.italic); }
    if (showStroke) strokeWidthInput.value = obj.strokeWidth;
    if (showColor) colorInput.value = obj.color;
    if (showDateFormat) dateFormatInput.value = obj.dateFormat;
  } else if (type && toolDefaults[type]) {
    const d = toolDefaults[type];
    if (showFontSize) { fontFamilyInput.value = d.fontFamily || 'helvetica'; fontSizeInput.value = d.fontSize; }
    if (showFontStyle) { boldToggleBtn.classList.toggle('active', !!d.bold); italicToggleBtn.classList.toggle('active', !!d.italic); }
    if (showStroke) strokeWidthInput.value = d.strokeWidth;
    if (showColor) colorInput.value = d.color;
    if (showDateFormat) dateFormatInput.value = currentDateFormat;
  }
}

function deleteObject(id) {
  const idx = objects.findIndex(o => o.id === id);
  if (idx === -1) return;
  if (objects[idx].sourceSpan) delete objects[idx].sourceSpan.dataset.covered;
  if (objects[idx].coverEl) objects[idx].coverEl.remove();
  objects[idx].el.remove();
  objects.splice(idx, 1);
  if (selectedId === id) {
    selectedId = null;
    updateToolbarForSelection();
  }
}

function updateToolButtons() {
  toolButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tool === currentTool));
  pagesContainer.className = 'pages-container mode-' + currentMode + ' tool-' + currentTool;
  updateToolbarForSelection();
}

// ---------- Sign / Initials modal ----------

const signModal = document.getElementById('signModal');
const signModalTitle = document.getElementById('signModalTitle');
const signModalCloseBtn = document.getElementById('signModalCloseBtn');
const signModalCancelBtn = document.getElementById('signModalCancelBtn');
const signModalInsertBtn = document.getElementById('signModalInsertBtn');
const signTabs = Array.from(document.querySelectorAll('.sign-tab'));
const signPanels = Array.from(document.querySelectorAll('.sign-panel'));
const signDrawCanvas = document.getElementById('signDrawCanvas');
const signDrawColor = document.getElementById('signDrawColor');
const signDrawClearBtn = document.getElementById('signDrawClearBtn');
const signTypeInput = document.getElementById('signTypeInput');
const signTypeColor = document.getElementById('signTypeColor');
const signTypePreview = document.getElementById('signTypePreview');
const signFontBtns = Array.from(document.querySelectorAll('.sign-font-btn'));
const signUploadDrop = document.getElementById('signUploadDrop');
const signUploadInput = document.getElementById('signUploadInput');
const signUploadPreview = document.getElementById('signUploadPreview');
const saveSignatureCheck = document.getElementById('saveSignatureCheck');
const savedSignaturesBox = document.getElementById('savedSignatures');
const savedSignaturesList = document.getElementById('savedSignaturesList');

let signModalMode = 'signature';
let signActiveTab = 'draw';
let signSelectedFont = signFontBtns[0].dataset.font;
let signUploadDataUrl = null;
let drawCtx = signDrawCanvas.getContext('2d');
let drawing = false;
let lastPt = null;

function openSignModal(mode) {
  signModalMode = mode;
  signModalTitle.textContent = mode === 'signature' ? 'Add your signature' : 'Add your initials';
  signActiveTab = 'draw';
  signTabs.forEach(t => t.classList.toggle('active', t.dataset.tab === 'draw'));
  signPanels.forEach(p => p.hidden = p.dataset.panel !== 'draw');
  clearDrawCanvas();
  signTypeInput.value = '';
  signTypePreview.textContent = '';
  signUploadDataUrl = null;
  signUploadPreview.hidden = true;
  signUploadPreview.src = '';

  const canSave = hasStorageConsent();
  saveSignatureCheck.checked = canSave;
  saveSignatureCheck.disabled = !canSave;
  saveSignatureCheck.closest('label').title = canSave
    ? ''
    : "You've declined local storage in the cookie notice, so this won't be saved for reuse.";

  renderSavedSignatures();
  signModal.hidden = false;
}

function closeSignModal() {
  signModal.hidden = true;
}

signModalCloseBtn.addEventListener('click', closeSignModal);
signModalCancelBtn.addEventListener('click', closeSignModal);
signModal.addEventListener('click', (e) => { if (e.target === signModal) closeSignModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !signModal.hidden) closeSignModal();
});

signTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    signActiveTab = tab.dataset.tab;
    signTabs.forEach(t => t.classList.toggle('active', t === tab));
    signPanels.forEach(p => p.hidden = p.dataset.panel !== signActiveTab);
  });
});

// Draw tab
function getCanvasPoint(e) {
  const rect = signDrawCanvas.getBoundingClientRect();
  const scaleX = signDrawCanvas.width / rect.width;
  const scaleY = signDrawCanvas.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

function clearDrawCanvas() {
  drawCtx.clearRect(0, 0, signDrawCanvas.width, signDrawCanvas.height);
}

signDrawCanvas.addEventListener('pointerdown', (e) => {
  drawing = true;
  signDrawCanvas.setPointerCapture(e.pointerId);
  lastPt = getCanvasPoint(e);
});
signDrawCanvas.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const pt = getCanvasPoint(e);
  drawCtx.strokeStyle = signDrawColor.value;
  drawCtx.lineWidth = 3;
  drawCtx.lineCap = 'round';
  drawCtx.lineJoin = 'round';
  drawCtx.beginPath();
  drawCtx.moveTo(lastPt.x, lastPt.y);
  drawCtx.lineTo(pt.x, pt.y);
  drawCtx.stroke();
  lastPt = pt;
});
signDrawCanvas.addEventListener('pointerup', () => { drawing = false; });
signDrawCanvas.addEventListener('pointerleave', () => { drawing = false; });
signDrawClearBtn.addEventListener('click', clearDrawCanvas);

// Type tab
signFontBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    signFontBtns.forEach(b => b.classList.toggle('active', b === btn));
    signSelectedFont = btn.dataset.font;
    signTypePreview.style.fontFamily = signSelectedFont;
  });
});
function updateTypePreview() {
  signTypePreview.textContent = signTypeInput.value;
  signTypePreview.style.fontFamily = signSelectedFont;
  signTypePreview.style.color = signTypeColor.value;
}
signTypeInput.addEventListener('input', updateTypePreview);
signTypeColor.addEventListener('input', updateTypePreview);
signTypePreview.style.fontFamily = signSelectedFont;

// Upload tab
signUploadDrop.addEventListener('click', () => signUploadInput.click());
signUploadDrop.addEventListener('dragover', (e) => { e.preventDefault(); signUploadDrop.classList.add('dragover'); });
signUploadDrop.addEventListener('dragleave', () => signUploadDrop.classList.remove('dragover'));
signUploadDrop.addEventListener('drop', async (e) => {
  e.preventDefault();
  signUploadDrop.classList.remove('dragover');
  const f = Array.from(e.dataTransfer.files).find(f => f.type === 'image/png' || f.type === 'image/jpeg');
  if (f) await handleSignUploadFile(f);
});
signUploadInput.addEventListener('change', async () => {
  const f = signUploadInput.files[0];
  signUploadInput.value = '';
  if (f) await handleSignUploadFile(f);
});
async function handleSignUploadFile(f) {
  signUploadDataUrl = await fileToDataUrl(f);
  signUploadPreview.src = signUploadDataUrl;
  signUploadPreview.hidden = false;
}

// Saved signatures (localStorage)
function savedSigStorageKey() {
  return 'inkbind.saved.' + signModalMode;
}
function hasStorageConsent() {
  return typeof window.inkbindHasStorageConsent !== 'function' || window.inkbindHasStorageConsent();
}
function getSavedSignatures() {
  if (!hasStorageConsent()) return [];
  try {
    return JSON.parse(localStorage.getItem(savedSigStorageKey()) || '[]');
  } catch { return []; }
}
function setSavedSignatures(list) {
  if (!hasStorageConsent()) return;
  try { localStorage.setItem(savedSigStorageKey(), JSON.stringify(list.slice(0, 6))); } catch {}
}
function addSavedSignature(dataUrl) {
  const list = getSavedSignatures();
  list.unshift({ id: 'sig-' + Date.now(), dataUrl });
  setSavedSignatures(list);
}
function renderSavedSignatures() {
  const list = getSavedSignatures();
  savedSignaturesBox.hidden = list.length === 0;
  savedSignaturesList.innerHTML = '';
  list.forEach(item => {
    const thumb = document.createElement('div');
    thumb.className = 'saved-sig-thumb';
    const img = document.createElement('img');
    img.src = item.dataUrl;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'saved-sig-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setSavedSignatures(getSavedSignatures().filter(i => i.id !== item.id));
      renderSavedSignatures();
    });
    thumb.appendChild(img);
    thumb.appendChild(removeBtn);
    thumb.addEventListener('click', async () => {
      const dims = await imageDataUrlSize(item.dataUrl);
      placeImageObject(signModalMode, item.dataUrl, dims.width, dims.height);
      closeSignModal();
    });
    savedSignaturesList.appendChild(thumb);
  });
}

signModalInsertBtn.addEventListener('click', async () => {
  let dataUrl = null;

  if (signActiveTab === 'draw') {
    dataUrl = trimCanvasToDataUrl(signDrawCanvas);
    if (!dataUrl) { setStatus('Draw something first.', true); return; }
  } else if (signActiveTab === 'type') {
    const text = signTypeInput.value.trim();
    if (!text) { setStatus('Type something first.', true); return; }
    dataUrl = renderTypedTextToDataUrl(text, signSelectedFont, signTypeColor.value);
  } else if (signActiveTab === 'upload') {
    if (!signUploadDataUrl) { setStatus('Choose an image first.', true); return; }
    dataUrl = signUploadDataUrl;
  }

  if (!dataUrl) return;

  if (saveSignatureCheck.checked) addSavedSignature(dataUrl);

  const dims = await imageDataUrlSize(dataUrl);
  placeImageObject(signModalMode, dataUrl, dims.width, dims.height);
  closeSignModal();
});

function trimCanvasToDataUrl(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d').drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
  return out.toDataURL('image/png');
}

function renderTypedTextToDataUrl(text, fontFamily, color) {
  const fontSize = 64;
  const measureCanvas = document.createElement('canvas');
  const mctx = measureCanvas.getContext('2d');
  mctx.font = `${fontSize}px ${fontFamily}`;
  const metrics = mctx.measureText(text);
  const width = Math.ceil(metrics.width) + 24;
  const height = Math.ceil(fontSize * 1.5);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, height / 2);
  return canvas.toDataURL('image/png');
}

// ---------- History (undo / redo) ----------

function serializeObject(obj) {
  const copy = {};
  for (const k in obj) {
    if (k === 'el' || k === 'textEl' || k === 'coverEl' || k === 'svgEl' || k === 'pathEl' || k === 'handleStart' || k === 'handleEnd') continue;
    copy[k] = obj[k];
  }
  if (obj.type === 'text' || obj.type === 'date') copy.text = textTargetEl(obj).textContent;
  if (obj.type === 'draw') copy.points = obj.points.map(p => ({ x: p.x, y: p.y }));
  return copy;
}

function snapshotState() {
  return {
    objects: objects.map(serializeObject),
    counter: objectCounter,
  };
}

function resetHistory() {
  historyStack = [snapshotState()];
  historyIndex = 0;
  updateUndoRedoButtons();
}

function pushHistory() {
  if (suppressHistory) return;
  const snap = snapshotState();
  historyStack = historyStack.slice(0, historyIndex + 1);
  historyStack.push(snap);
  if (historyStack.length > MAX_HISTORY) historyStack.shift();
  historyIndex = historyStack.length - 1;
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  undoBtn.disabled = historyIndex <= 0;
  redoBtn.disabled = historyIndex >= historyStack.length - 1;
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  restoreSnapshot(historyStack[historyIndex]);
}

function redo() {
  if (historyIndex >= historyStack.length - 1) return;
  historyIndex++;
  restoreSnapshot(historyStack[historyIndex]);
}

function restoreSnapshot(snap) {
  suppressHistory = true;
  selectedId = null;
  document.querySelectorAll('.page-overlay').forEach(o => { o.innerHTML = ''; });
  objects = [];
  objectCounter = snap.counter;

  for (const data of snap.objects) {
    rebuildObject(data);
  }

  updateToolbarForSelection();
  updateUndoRedoButtons();
  suppressHistory = false;
}

function rebuildObject(data) {
  const page = pages.find(p => p.pageNum === data.pageNum);
  if (!page) return;
  const overlay = page.overlayEl;

  if (data.type === 'text' || data.type === 'date') {
    const el = document.createElement('div');
    el.className = 'edit-object edit-text' + (data.isTextEdit ? ' text-edit' : '');
    el.style.left = data.x + 'px';
    el.style.top = data.y + 'px';
    el.dataset.id = data.id;

    let obj;

    if (data.isTextEdit) {
      // Same wrapper/inner-content/fixed-cover-backdrop split as startTextEdit.
      el.style.width = data.width + 'px';
      el.style.minHeight = data.height + 'px';
      el.style.background = data.coverColor;
      if (data.sourceSpan) data.sourceSpan.dataset.covered = 'true';

      const coverEl = document.createElement('div');
      coverEl.className = 'text-edit-cover';
      coverEl.style.left = data.coverX + 'px';
      coverEl.style.top = data.coverY + 'px';
      coverEl.style.width = data.coverWidth + 'px';
      coverEl.style.height = data.coverHeight + 'px';
      coverEl.style.background = data.coverColor;
      overlay.appendChild(coverEl);

      const textEl = document.createElement('div');
      textEl.className = 'text-edit-content';
      textEl.contentEditable = 'false';
      textEl.style.fontSize = data.fontSize + 'px';
      textEl.style.color = data.color;
      textEl.textContent = data.text || '';
      el.appendChild(textEl);

      addResizeHandles(el);

      obj = Object.assign({}, data, { el, textEl, coverEl });
    } else {
      el.contentEditable = 'false';
      el.style.fontSize = data.fontSize + 'px';
      el.style.color = data.color;
      el.textContent = data.text || '';
      obj = Object.assign({}, data, { el });
    }

    overlay.appendChild(el);
    applyTextFontCss(obj);
    objects.push(obj);
    attachObjectHandlers(obj, !!data.isTextEdit);
    return;
  }

  if (data.type === 'whiteout' || data.type === 'highlight') {
    const el = document.createElement('div');
    el.className = 'edit-object edit-' + data.type;
    el.style.left = data.x + 'px';
    el.style.top = data.y + 'px';
    el.style.width = data.width + 'px';
    el.style.height = data.height + 'px';
    el.style.background = data.color;
    if (data.type === 'highlight') { el.style.opacity = HIGHLIGHT_OPACITY; el.style.mixBlendMode = 'multiply'; }
    el.dataset.id = data.id;
    addResizeHandles(el);
    overlay.appendChild(el);
    const obj = Object.assign({}, data, { el });
    objects.push(obj);
    attachObjectHandlers(obj, true);
    return;
  }

  if (data.type === 'checkmark' || data.type === 'cross') {
    const el = document.createElement('div');
    el.className = 'edit-object edit-icon';
    el.style.left = data.x + 'px';
    el.style.top = data.y + 'px';
    el.style.width = data.width + 'px';
    el.style.height = data.height + 'px';
    el.dataset.id = data.id;
    const svg = buildIconSvg(data.type, data.color);
    el.appendChild(svg);
    addResizeHandles(el);
    overlay.appendChild(el);
    const obj = Object.assign({}, data, { el, svgEl: svg });
    objects.push(obj);
    attachObjectHandlers(obj, true);
    return;
  }

  if (data.type === 'image' || data.type === 'signature' || data.type === 'initials') {
    const el = document.createElement('div');
    el.className = 'edit-object edit-image';
    el.style.left = data.x + 'px';
    el.style.top = data.y + 'px';
    el.style.width = data.width + 'px';
    el.style.height = data.height + 'px';
    el.dataset.id = data.id;
    const img = document.createElement('img');
    img.src = data.dataUrl;
    img.draggable = false;
    el.appendChild(img);
    addResizeHandles(el);
    overlay.appendChild(el);
    const obj = Object.assign({}, data, { el });
    objects.push(obj);
    attachObjectHandlers(obj, true);
    return;
  }

  if (data.type === 'formtext' || data.type === 'formcheckbox') {
    const isCheckbox = data.type === 'formcheckbox';
    const el = document.createElement('div');
    el.className = 'edit-object edit-formfield ' + (isCheckbox ? 'edit-formcheckbox' : 'edit-formtext');
    el.style.left = data.x + 'px';
    el.style.top = data.y + 'px';
    el.style.width = data.width + 'px';
    el.style.height = data.height + 'px';
    el.style.borderColor = data.color;
    el.style.background = hexToRgba(data.color, 0.08);
    el.dataset.id = data.id;
    const label = document.createElement('span');
    label.className = 'formfield-label';
    label.style.color = data.color;
    label.textContent = isCheckbox ? '' : 'Text Field';
    el.appendChild(label);
    addResizeHandles(el);
    el.querySelectorAll('.resize-handle').forEach(h => { h.style.background = data.color; });
    overlay.appendChild(el);
    const obj = Object.assign({}, data, { el, labelEl: label });
    objects.push(obj);
    attachObjectHandlers(obj, true);
    return;
  }

  if (data.type === 'draw') {
    const el = document.createElement('div');
    el.className = 'edit-object edit-draw';
    el.style.left = data.x + 'px';
    el.style.top = data.y + 'px';
    el.style.width = data.width + 'px';
    el.style.height = data.height + 'px';
    el.dataset.id = data.id;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${data.width} ${data.height}`);
    svg.classList.add('vector-svg');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M' + data.points.map(p => `${p.x},${p.y}`).join(' L'));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', data.color);
    path.setAttribute('stroke-width', String(data.strokeWidth));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    el.appendChild(svg);
    overlay.appendChild(el);
    const obj = Object.assign({}, data, { el, svgEl: svg, pathEl: path });
    objects.push(obj);
    attachObjectHandlers(obj);
    return;
  }

  if (data.type === 'line' || data.type === 'arrow') {
    const el = document.createElement('div');
    el.className = 'edit-object edit-line';
    el.dataset.id = data.id;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.classList.add('vector-svg');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', data.color);
    path.setAttribute('stroke-width', String(data.strokeWidth));
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
    el.appendChild(svg);
    const h1 = document.createElement('div');
    h1.className = 'line-handle line-handle-start';
    const h2 = document.createElement('div');
    h2.className = 'line-handle line-handle-end';
    el.appendChild(h1);
    el.appendChild(h2);
    overlay.appendChild(el);
    const obj = Object.assign({}, data, { el, svgEl: svg, pathEl: path, handleStart: h1, handleEnd: h2 });
    layoutLineObject(obj);
    objects.push(obj);
    attachObjectHandlers(obj);
    attachLineHandle(obj, h1, true);
    attachLineHandle(obj, h2, false);
    return;
  }
}

// ---------- True text removal from content stream (best-effort) ----------
//
// The "edit existing text" flow above covers the original glyphs with a rectangle and
// draws new text on top, like every other browser-based PDF editor — pdf-lib has no API to
// rewrite glyphs in place, and full content-stream text editing is a document-editing-
// engine-level feature. What we CAN do reliably is remove the original Tj/TJ operator that
// drew the covered text from the page's content stream, so nothing of it survives in the
// file — not just visually hidden, but actually gone: unselectable, unextractable. This is
// a best-effort pass: if we can't find an unambiguous match for a given edit (unusual font
// encoding, duplicate text, an unsupported stream filter, no DecompressionStream support),
// that edit silently keeps the cover-rectangle fallback instead — never a guess that could
// corrupt the file.

async function inflateZlib(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function decodeStreamContents(rawStream) {
  const bytes = rawStream.getContents();
  const filterEntry = rawStream.dict.get(PDFName.of('Filter'));
  const filterStr = filterEntry ? String(filterEntry) : '';
  if (filterStr.includes('FlateDecode')) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('DecompressionStream unsupported; cannot read compressed content stream');
    }
    return inflateZlib(bytes);
  }
  if (filterStr) {
    throw new Error('Unsupported content stream filter: ' + filterStr);
  }
  return bytes;
}

async function getPageContentBytes(workDoc, pdfPage) {
  const contentsEntry = pdfPage.node.get(PDFName.of('Contents'));
  const resolved = workDoc.context.lookupMaybe(contentsEntry, PDFArray, PDFRawStream);
  if (!resolved) throw new Error('Page has no readable content stream');

  const chunks = [];
  if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) {
      const stream = workDoc.context.lookup(resolved.get(i));
      chunks.push(await decodeStreamContents(stream));
      chunks.push(new Uint8Array([0x0a]));
    }
  } else {
    chunks.push(await decodeStreamContents(resolved));
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function replacePageContentBytes(workDoc, pdfPage, newBytes) {
  const dict = workDoc.context.obj({ Length: newBytes.length });
  const newStream = PDFRawStream.of(dict, newBytes);
  const ref = workDoc.context.register(newStream);
  pdfPage.node.set(PDFName.of('Contents'), ref);
}

// ---- Minimal content-stream tokenizer ----

const CS_WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const CS_DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function csBytesToLatin1(arr) {
  let s = '';
  for (let k = 0; k < arr.length; k++) s += String.fromCharCode(arr[k]);
  return s;
}

function tokenizeContentStream(bytes) {
  const len = bytes.length;
  const tokens = [];
  let i = 0;

  function skipWs() {
    while (i < len) {
      if (CS_WHITESPACE.has(bytes[i])) { i++; continue; }
      if (bytes[i] === 0x25) { while (i < len && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++; continue; }
      break;
    }
  }

  function readName() {
    const start = i;
    i++;
    const out = [];
    while (i < len && !CS_WHITESPACE.has(bytes[i]) && !CS_DELIMITER.has(bytes[i])) {
      if (bytes[i] === 0x23 && i + 2 < len) {
        const code = parseInt(csBytesToLatin1(bytes.slice(i + 1, i + 3)), 16);
        if (!isNaN(code)) { out.push(code); i += 3; continue; }
      }
      out.push(bytes[i]);
      i++;
    }
    return { type: 'name', value: csBytesToLatin1(out), start, end: i };
  }

  function readNumber() {
    const start = i;
    if (bytes[i] === 0x2b || bytes[i] === 0x2d) i++;
    while (i < len && ((bytes[i] >= 0x30 && bytes[i] <= 0x39) || bytes[i] === 0x2e)) i++;
    return { type: 'number', value: parseFloat(csBytesToLatin1(bytes.slice(start, i))), start, end: i };
  }

  function readLiteralString() {
    const start = i;
    i++;
    let depth = 1;
    const out = [];
    while (i < len && depth > 0) {
      const b = bytes[i];
      if (b === 0x5c) {
        i++;
        if (i >= len) break;
        const esc = bytes[i];
        const map = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (esc in map) { out.push(map[esc]); i++; }
        else if (esc === 0x0a) { i++; }
        else if (esc === 0x0d) { i++; if (bytes[i] === 0x0a) i++; }
        else if (esc >= 0x30 && esc <= 0x37) {
          let oct = ''; let count = 0;
          while (count < 3 && i < len && bytes[i] >= 0x30 && bytes[i] <= 0x37) { oct += String.fromCharCode(bytes[i]); i++; count++; }
          out.push(parseInt(oct, 8) & 0xff);
        } else { out.push(esc); i++; }
      } else if (b === 0x28) { depth++; out.push(b); i++; }
      else if (b === 0x29) { depth--; i++; if (depth > 0) out.push(b); }
      else { out.push(b); i++; }
    }
    return { type: 'string', value: new Uint8Array(out), start, end: i };
  }

  function readHexString() {
    const start = i;
    i++;
    let hex = '';
    while (i < len && bytes[i] !== 0x3e) {
      if (!CS_WHITESPACE.has(bytes[i])) hex += String.fromCharCode(bytes[i]);
      i++;
    }
    i++;
    if (hex.length % 2 === 1) hex += '0';
    const out = new Uint8Array(hex.length / 2);
    for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.substr(k * 2, 2), 16) || 0;
    return { type: 'string', value: out, start, end: i };
  }

  function skipDict() {
    const start = i;
    i += 2;
    let depth = 1;
    while (i < len && depth > 0) {
      if (bytes[i] === 0x3c && bytes[i + 1] === 0x3c) { depth++; i += 2; }
      else if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) { depth--; i += 2; }
      else i++;
    }
    return { type: 'dict', value: null, start, end: i };
  }

  function readArray() {
    const start = i;
    i++;
    const items = [];
    while (true) {
      skipWs();
      if (i >= len) break;
      if (bytes[i] === 0x5d) { i++; break; }
      const tok = readToken();
      if (!tok) break;
      items.push(tok);
    }
    return { type: 'array', value: items, start, end: i };
  }

  function readOperator() {
    const start = i;
    while (i < len && !CS_WHITESPACE.has(bytes[i]) && !CS_DELIMITER.has(bytes[i])) i++;
    if (i === start) i++; // stray delimiter byte; avoid an infinite loop
    return { type: 'operator', value: csBytesToLatin1(bytes.slice(start, i)), start, end: i };
  }

  function readToken() {
    skipWs();
    if (i >= len) return null;
    const b = bytes[i];
    if (b === 0x2f) return readName();
    if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) return readNumber();
    if (b === 0x28) return readLiteralString();
    if (b === 0x3c) return bytes[i + 1] === 0x3c ? skipDict() : readHexString();
    if (b === 0x5b) return readArray();
    if (b === 0x5d || b === 0x3e) { i++; return readToken(); }
    return readOperator();
  }

  while (true) {
    skipWs();
    if (i >= len) break;
    const tok = readToken();
    if (!tok) break;
    tokens.push(tok);
    // Raw-skip inline image data (BI ... ID <binary> EI) so binary bytes never confuse the
    // tokenizer above.
    if (tok.type === 'operator' && tok.value === 'ID') {
      i++; // the single whitespace byte required after ID
      const dataStart = i;
      while (i < len - 1) {
        if (bytes[i] === 0x45 && bytes[i + 1] === 0x49 /* "EI" */
            && (i === dataStart || CS_WHITESPACE.has(bytes[i - 1]))
            && (i + 2 >= len || CS_WHITESPACE.has(bytes[i + 2]))) {
          break;
        }
        i++;
      }
      tokens.push({ type: 'string', value: bytes.slice(dataStart, i), start: dataStart, end: i });
      const eiStart = i;
      i += 2;
      tokens.push({ type: 'operator', value: 'EI', start: eiStart, end: i });
    }
  }
  return tokens;
}

// Groups the flat token list into operator calls: { operator, operands, start, end }
// where start/end bound the ENTIRE call (its operands through the operator keyword) in the
// original byte stream — used later to excise a call byte-for-byte.
function groupOperatorCalls(tokens) {
  const calls = [];
  let pending = [];
  for (const tok of tokens) {
    if (tok.type === 'operator') {
      const start = pending.length ? pending[0].start : tok.start;
      calls.push({ operator: tok.value, operands: pending, start, end: tok.end });
      pending = [];
    } else {
      pending.push(tok);
    }
  }
  return calls;
}

function decodeShowTextBytes(bytes) {
  let s = '';
  for (let k = 0; k < bytes.length; k++) s += String.fromCharCode(bytes[k]);
  return s;
}

function decodeOperandsText(operator, operands) {
  if (operator === 'Tj' || operator === "'" || operator === '"') {
    const strOperand = operands[operands.length - 1];
    if (!strOperand || strOperand.type !== 'string') return null;
    return decodeShowTextBytes(strOperand.value);
  }
  if (operator === 'TJ') {
    const arrOperand = operands[operands.length - 1];
    if (!arrOperand || arrOperand.type !== 'array') return null;
    return arrOperand.value
      .filter(item => item.type === 'string')
      .map(item => decodeShowTextBytes(item.value))
      .join('');
  }
  return null;
}

function normalizeForMatch(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// Finds the single, unambiguous Tj/TJ call whose decoded text exactly matches targetText.
// Returns its {start, end} byte range, or null if zero or multiple candidates were found —
// ambiguity always means "don't touch it," never "guess."
function findRemovableTextOperator(calls, targetText) {
  const target = normalizeForMatch(targetText);
  if (!target) return null;

  const matches = [];
  for (const call of calls) {
    if (call.operator !== 'Tj' && call.operator !== 'TJ' && call.operator !== "'" && call.operator !== '"') continue;
    const decoded = normalizeForMatch(decodeOperandsText(call.operator, call.operands));
    if (decoded && decoded === target) matches.push(call);
  }

  if (matches.length !== 1) return null;
  return { start: matches[0].start, end: matches[0].end };
}

function exciseByteRanges(bytes, ranges) {
  if (!ranges.length) return bytes;
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const parts = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.start < cursor) continue; // overlapping ranges — skip the later one defensively
    parts.push(bytes.slice(cursor, r.start));
    cursor = r.end;
  }
  parts.push(bytes.slice(cursor));
  const total = parts.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of parts) { result.set(c, offset); offset += c.length; }
  return result;
}

// Attempts to remove the original text-showing operators for every text-edit object on a
// page, in one content-stream rewrite. Marks each successfully removed object with
// `__removedFromStream = true` so the draw loop skips its cover rectangle. Never throws —
// any failure just leaves that page's objects using the existing cover+redraw path.
async function tryRemoveOriginalText(workDoc, pdfPages, editObjectsByPage) {
  for (const [pageNum, editObjs] of editObjectsByPage) {
    const pdfPage = pdfPages[pageNum - 1];
    if (!pdfPage) continue;
    try {
      const contentBytes = await getPageContentBytes(workDoc, pdfPage);
      const tokens = tokenizeContentStream(contentBytes);
      const calls = groupOperatorCalls(tokens);

      const ranges = [];
      for (const obj of editObjs) {
        const range = findRemovableTextOperator(calls, obj.originalText);
        if (range) {
          ranges.push(range);
          obj.__removedFromStream = true;
        }
      }

      if (ranges.length) {
        const newBytes = exciseByteRanges(contentBytes, ranges);
        replacePageContentBytes(workDoc, pdfPage, newBytes);
      }
    } catch (err) {
      console.error(`True text removal skipped for page ${pageNum} (falling back to cover):`, err);
    }
  }
}

// ---------- Export ----------

async function exportPdf() {
  editorDownloadBtn.disabled = true;
  setStatus('Preparing your PDF...');

  try {
    const bytes = await file.arrayBuffer();
    const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });

    // pdf-lib can't decrypt existing content streams, so encrypted sources are
    // rebuilt from rendered page images (via pdf.js, which decrypts fine) before
    // edits are drawn on top — otherwise edited pages would come out blank.
    const workDoc = srcDoc.isEncrypted ? await buildRasterDoc() : srcDoc;

    const pdfPages = workDoc.getPages();
    const imageCache = new Map();
    const fontCache = new Map();
    const hasFormFields = objects.some(o => o.type === 'formtext' || o.type === 'formcheckbox');
    const form = hasFormFields ? workDoc.getForm() : null;

    // Best-effort: actually delete the original text this edit covers from the page's
    // content stream, instead of only visually hiding it. See the section above for why
    // this can't be done for every edit, and why that's safe (it just falls back).
    const textEditObjects = objects.filter(o => o.type === 'text' && o.isTextEdit && !srcDoc.isEncrypted);
    if (textEditObjects.length) {
      const editObjectsByPage = new Map();
      for (const obj of textEditObjects) {
        if (!editObjectsByPage.has(obj.pageNum)) editObjectsByPage.set(obj.pageNum, []);
        editObjectsByPage.get(obj.pageNum).push(obj);
      }
      await tryRemoveOriginalText(workDoc, pdfPages, editObjectsByPage);
    }

    async function getFontForObject(obj) {
      const family = obj.fontFamily || 'helvetica';
      const bold = !!obj.bold;
      const italic = !!obj.italic;
      const key = `${family}|${bold}|${italic}`;
      if (fontCache.has(key)) return fontCache.get(key);
      const variants = FONT_VARIANTS[family] || FONT_VARIANTS.helvetica;
      const variantName = bold && italic ? variants.boldItalic : bold ? variants.bold : italic ? variants.italic : variants.regular;
      const embedded = await workDoc.embedFont(StandardFonts[variantName]);
      fontCache.set(key, embedded);
      return embedded;
    }

    for (const obj of objects) {
      const pageInfo = pages.find(p => p.pageNum === obj.pageNum);
      const pdfPage = pdfPages[obj.pageNum - 1];
      if (!pageInfo || !pdfPage) continue;

      const scale = pageInfo.displayScale;

      if (obj.type === 'whiteout') {
        drawScaledRect(pdfPage, pageInfo, obj, { color: hexToRgb(obj.color) });
      } else if (obj.type === 'highlight') {
        drawScaledRect(pdfPage, pageInfo, obj, { color: hexToRgb(obj.color), opacity: HIGHLIGHT_OPACITY, blendMode: BlendMode.Multiply });
      } else if (obj.type === 'text' || obj.type === 'date') {
        if (obj.isTextEdit && !obj.__removedFromStream) {
          // Cover the ORIGINAL text's fixed position, not wherever the (possibly dragged
          // or resized) replacement text box currently sits.
          const coverShim = { x: obj.coverX, y: obj.coverY, width: obj.coverWidth, height: obj.coverHeight };
          drawScaledRect(pdfPage, pageInfo, coverShim, { color: hexToRgb(obj.coverColor) });
        }
        const text = (textTargetEl(obj).textContent || '').replace(/\n+$/, '');
        if (!text.trim()) continue;
        const objFont = await getFontForObject(obj);
        const fontSizePdf = obj.fontSize / scale;
        const lineHeight = fontSizePdf * 1.25;
        const x = obj.x / scale;
        const topY = obj.y / scale;
        text.split('\n').forEach((line, i) => {
          pdfPage.drawText(line, {
            x,
            y: pageInfo.pdfHeight - topY - fontSizePdf * 0.9 - i * lineHeight,
            size: fontSizePdf,
            font: objFont,
            color: hexToRgb(obj.color),
          });
        });
      } else if (obj.type === 'checkmark' || obj.type === 'cross') {
        const segments = obj.type === 'checkmark' ? CHECK_SEGMENTS : CROSS_SEGMENTS;
        const localSegments = segments.map(seg => seg.map(p => ({ x: p.x * (obj.width / 100), y: p.y * (obj.height / 100) })));
        const borderWidthPdf = Math.max(2, Math.round(((obj.width + obj.height) / 2) * 0.12)) / scale;
        drawVectorSegments(pdfPage, pageInfo, obj, localSegments, borderWidthPdf);
      } else if (obj.type === 'draw') {
        drawVectorSegments(pdfPage, pageInfo, obj, [obj.points], obj.strokeWidth / scale);
      } else if (obj.type === 'line' || obj.type === 'arrow') {
        const localX1 = obj.x1 - obj.x, localY1 = obj.y1 - obj.y;
        const localX2 = obj.x2 - obj.x, localY2 = obj.y2 - obj.y;
        const segs = [[{ x: localX1, y: localY1 }, { x: localX2, y: localY2 }]];
        if (obj.type === 'arrow') {
          const angle = Math.atan2(localY2 - localY1, localX2 - localX1);
          const headLen = Math.max(10, obj.strokeWidth * 3);
          const spread = 0.5;
          segs.push([{ x: localX2, y: localY2 }, {
            x: localX2 - headLen * Math.cos(angle - spread),
            y: localY2 - headLen * Math.sin(angle - spread),
          }]);
          segs.push([{ x: localX2, y: localY2 }, {
            x: localX2 - headLen * Math.cos(angle + spread),
            y: localY2 - headLen * Math.sin(angle + spread),
          }]);
        }
        drawVectorSegments(pdfPage, pageInfo, obj, segs, obj.strokeWidth / scale);
      } else if (obj.type === 'image' || obj.type === 'signature' || obj.type === 'initials') {
        let img = imageCache.get(obj.dataUrl);
        if (!img) {
          const isPng = obj.dataUrl.startsWith('data:image/png');
          const imgBytes = dataUrlToUint8Array(obj.dataUrl);
          img = isPng ? await workDoc.embedPng(imgBytes) : await workDoc.embedJpg(imgBytes);
          imageCache.set(obj.dataUrl, img);
        }
        const x = obj.x / scale;
        const w = obj.width / scale;
        const h = obj.height / scale;
        const yTop = obj.y / scale;
        pdfPage.drawImage(img, {
          x,
          y: pageInfo.pdfHeight - yTop - h,
          width: w,
          height: h,
        });
      } else if (obj.type === 'formtext') {
        const x = obj.x / scale, w = obj.width / scale, h = obj.height / scale, yTop = obj.y / scale;
        const tf = form.createTextField(obj.fieldName);
        tf.addToPage(pdfPage, {
          x, y: pageInfo.pdfHeight - yTop - h, width: w, height: h,
          borderWidth: 1,
          borderColor: hexToRgb(obj.color),
          backgroundColor: rgb(1, 1, 1),
        });
        tf.setFontSize(Math.max(8, Math.round(h * 0.55)));
      } else if (obj.type === 'formcheckbox') {
        const x = obj.x / scale, w = obj.width / scale, h = obj.height / scale, yTop = obj.y / scale;
        const cb = form.createCheckBox(obj.fieldName);
        cb.addToPage(pdfPage, {
          x, y: pageInfo.pdfHeight - yTop - h, width: w, height: h,
          borderWidth: 1,
          borderColor: hexToRgb(obj.color),
          backgroundColor: rgb(1, 1, 1),
        });
      }
    }

    const outBytes = await workDoc.save();
    downloadBlob(outBytes, deriveFilename());
    setStatus('Downloaded.');
  } catch (err) {
    console.error(err);
    setStatus(`Failed to export: ${err.message}`, true);
  } finally {
    editorDownloadBtn.disabled = false;
  }
}

function drawScaledRect(pdfPage, pageInfo, obj, extraOpts) {
  const scale = pageInfo.displayScale;
  const x = obj.x / scale;
  const yTop = obj.y / scale;
  const w = obj.width / scale;
  const h = obj.height / scale;
  pdfPage.drawRectangle(Object.assign({
    x,
    y: pageInfo.pdfHeight - yTop - h,
    width: w,
    height: h,
  }, extraOpts));
}

// segments: array of polylines, each an array of {x,y} in div-local px (same units as obj.width/height)
function drawVectorSegments(pdfPage, pageInfo, obj, segments, borderWidthPdf) {
  const scale = pageInfo.displayScale;
  const originX = obj.x / scale;
  const originYTop = obj.y / scale; // distance from page top, in PDF units
  const pathParts = segments
    .filter(seg => seg.length >= 2)
    .map(seg => 'M' + seg.map(p => {
      const px = originX + p.x / scale;
      const pyFromTop = originYTop + p.y / scale;
      return `${px},${pyFromTop}`;
    }).join(' L'));
  if (!pathParts.length) return;
  const pathD = pathParts.join(' ');
  pdfPage.drawSvgPath(pathD, {
    x: 0,
    y: pageInfo.pdfHeight,
    borderColor: hexToRgb(obj.color),
    borderWidth: borderWidthPdf,
    borderLineCap: LineCapStyle.Round,
  });
}

async function buildRasterDoc() {
  const newDoc = await PDFDocument.create();
  for (const p of pages) {
    const page = await pdfjsDoc.getPage(p.pageNum);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const imgBytes = dataUrlToUint8Array(canvas.toDataURL('image/jpeg', 0.92));
    const img = await newDoc.embedJpg(imgBytes);
    const pageViewport1 = page.getViewport({ scale: 1 });
    const newPage = newDoc.addPage([pageViewport1.width, pageViewport1.height]);
    newPage.drawImage(img, { x: 0, y: 0, width: pageViewport1.width, height: pageViewport1.height });
  }
  return newDoc;
}

function dataUrlToUint8Array(dataUrl) {
  const binary = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  return rgb(r, g, b);
}

function deriveFilename() {
  const base = (file.name || 'document.pdf').replace(/\.pdf$/i, '');
  return `${base}-edited.pdf`;
}

function downloadBlob(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function setStatus(message, isError = false) {
  editorStatus.textContent = message;
  editorStatus.classList.toggle('error', isError);
}
