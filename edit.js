const { PDFDocument, StandardFonts, rgb, LineCapStyle, BlendMode } = PDFLib;
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
const PLACE_ON_CLICK = new Set(['text', 'date', 'checkmark', 'cross']);
const DRAG_TO_CREATE = new Set(['whiteout', 'highlight', 'draw', 'line', 'arrow']);
const MODAL_TOOLS = new Set(['signature', 'initials']);

const fontSizeField = document.getElementById('fontSizeField');
const strokeWidthField = document.getElementById('strokeWidthField');
const colorField = document.getElementById('colorField');
const dateFormatField = document.getElementById('dateFormatField');
const fontSizeInput = document.getElementById('fontSizeInput');
const strokeWidthInput = document.getElementById('strokeWidthInput');
const colorInput = document.getElementById('colorInput');
const dateFormatInput = document.getElementById('dateFormatInput');

const deleteObjectBtn = document.getElementById('deleteObjectBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const editorClearBtn = document.getElementById('editorClearBtn');
const editorDownloadBtn = document.getElementById('editorDownloadBtn');
const imageFileInput = document.getElementById('imageFileInput');

const toolDefaults = {
  text: { color: '#1f2430', fontSize: 16 },
  date: { color: '#1f2430', fontSize: 14 },
  whiteout: { color: '#ffffff' },
  highlight: { color: '#ffeb3b' },
  draw: { color: '#1f2430', strokeWidth: 3 },
  line: { color: '#1f2430', strokeWidth: 3 },
  arrow: { color: '#1f2430', strokeWidth: 3 },
  checkmark: { color: '#16a34a' },
  cross: { color: '#dc2626' },
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

  const overlay = document.createElement('div');
  overlay.className = 'page-overlay';

  wrap.appendChild(tag);
  wrap.appendChild(canvas);
  wrap.appendChild(overlay);
  pagesContainer.appendChild(wrap);

  pages.push({
    pageNum,
    pdfWidth: baseViewport.width,
    pdfHeight: baseViewport.height,
    displayScale,
    overlayEl: overlay,
    wrapEl: wrap,
  });

  overlay.addEventListener('mousedown', (e) => handleOverlayMouseDown(e, pageNum, overlay));
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

// ---------- Format panel ----------

fontSizeInput.addEventListener('input', () => {
  const size = Math.max(6, parseInt(fontSizeInput.value, 10) || 16);
  const obj = getSelectedObject();
  if (obj && obj.type in { text: 1, date: 1 }) {
    obj.fontSize = size;
    obj.el.style.fontSize = size + 'px';
  } else {
    toolDefaults[currentTool] && (toolDefaults[currentTool].fontSize = size);
  }
});
fontSizeInput.addEventListener('change', () => pushHistory());

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
    obj.el.textContent = formatDate(new Date(), currentDateFormat);
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
    dateFormat: currentDateFormat,
    el,
  };

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
    const obj = {
      id, pageNum, type,
      x: parseFloat(el.style.left), y: parseFloat(el.style.top),
      width, height, color: defaults.color,
      el,
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
  overlay.appendChild(el);

  const handle = document.createElement('div');
  handle.className = 'resize-handle';
  el.appendChild(handle);

  const obj = {
    id, pageNum, type,
    x: x - size / 2, y: y - size / 2, width: size, height: size,
    color: defaults.color,
    el, svgEl: svg,
  };
  objects.push(obj);
  attachObjectHandlers(obj, handle);
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
  page.overlayEl.appendChild(el);

  const handle = document.createElement('div');
  handle.className = 'resize-handle';
  el.appendChild(handle);

  const obj = {
    id, pageNum: page.pageNum, type,
    x, y, width, height, dataUrl,
    el,
  };
  objects.push(obj);
  attachObjectHandlers(obj, handle);
  selectObject(id);
  pushHistory();
}

// ---------- Generic drag / resize / select ----------

function attachObjectHandlers(obj, resizeHandle) {
  obj.el.addEventListener('mousedown', (e) => {
    if (e.target.classList && (e.target.classList.contains('resize-handle') || e.target.classList.contains('line-handle'))) return;
    e.stopPropagation();
    selectObject(obj.id);
    if ((obj.type === 'text' || obj.type === 'date') && obj.el.isContentEditable) return;
    e.preventDefault();
    startObjectDrag(obj, e);
  });

  if (obj.type === 'text' || obj.type === 'date') {
    obj.el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      obj.el.contentEditable = 'true';
      obj.el.focus();
    });

    obj.el.addEventListener('blur', () => {
      obj.el.contentEditable = 'false';
      if (obj.el.textContent.trim() === '') {
        deleteObject(obj.id);
      }
      pushHistory();
    });
  }

  if (resizeHandle) {
    resizeHandle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      selectObject(obj.id);
      startResize(obj, e);
    });
  }
}

function startObjectDrag(obj, e) {
  const startMouseX = e.clientX;
  const startMouseY = e.clientY;
  const startX = obj.x;
  const startY = obj.y;
  const isLine = obj.type === 'line' || obj.type === 'arrow';
  const startX1 = obj.x1, startY1 = obj.y1, startX2 = obj.x2, startY2 = obj.y2;
  let moved = false;

  function onMove(ev) {
    moved = true;
    const dx = ev.clientX - startMouseX;
    const dy = ev.clientY - startMouseY;
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
    if (moved) pushHistory();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function startResize(obj, e) {
  const startMouseX = e.clientX;
  const startMouseY = e.clientY;
  const startW = obj.width;
  const startH = obj.height;

  function onMove(ev) {
    obj.width = Math.max(10, startW + (ev.clientX - startMouseX));
    obj.height = Math.max(10, startH + (ev.clientY - startMouseY));
    obj.el.style.width = obj.width + 'px';
    obj.el.style.height = obj.height + 'px';
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
  const showStroke = type === 'draw' || type === 'line' || type === 'arrow';
  const showColor = type && type !== 'image' && type !== 'signature' && type !== 'initials';
  const showDateFormat = type === 'date';

  fontSizeField.style.display = showFontSize ? '' : 'none';
  strokeWidthField.style.display = showStroke ? '' : 'none';
  colorField.style.display = showColor ? '' : 'none';
  dateFormatField.style.display = showDateFormat ? '' : 'none';

  fontSizeInput.disabled = !showFontSize;
  strokeWidthInput.disabled = !showStroke;
  colorInput.disabled = !showColor;

  if (obj) {
    if (showFontSize) fontSizeInput.value = obj.fontSize;
    if (showStroke) strokeWidthInput.value = obj.strokeWidth;
    if (showColor) colorInput.value = obj.color;
    if (showDateFormat) dateFormatInput.value = obj.dateFormat;
  } else if (type && toolDefaults[type]) {
    const d = toolDefaults[type];
    if (showFontSize) fontSizeInput.value = d.fontSize;
    if (showStroke) strokeWidthInput.value = d.strokeWidth;
    if (showColor) colorInput.value = d.color;
    if (showDateFormat) dateFormatInput.value = currentDateFormat;
  }
}

function deleteObject(id) {
  const idx = objects.findIndex(o => o.id === id);
  if (idx === -1) return;
  objects[idx].el.remove();
  objects.splice(idx, 1);
  if (selectedId === id) {
    selectedId = null;
    updateToolbarForSelection();
  }
}

function updateToolButtons() {
  toolButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tool === currentTool));
  pagesContainer.className = 'pages-container tool-' + currentTool;
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
function getSavedSignatures() {
  try {
    return JSON.parse(localStorage.getItem(savedSigStorageKey()) || '[]');
  } catch { return []; }
}
function setSavedSignatures(list) {
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
    if (k === 'el' || k === 'svgEl' || k === 'pathEl' || k === 'handleStart' || k === 'handleEnd') continue;
    copy[k] = obj[k];
  }
  if (obj.type === 'text' || obj.type === 'date') copy.text = obj.el.textContent;
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
    el.className = 'edit-object edit-text';
    el.contentEditable = 'false';
    el.style.left = data.x + 'px';
    el.style.top = data.y + 'px';
    el.style.fontSize = data.fontSize + 'px';
    el.style.color = data.color;
    el.textContent = data.text || '';
    el.dataset.id = data.id;
    overlay.appendChild(el);
    const obj = Object.assign({}, data, { el });
    objects.push(obj);
    attachObjectHandlers(obj);
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
    overlay.appendChild(el);
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    el.appendChild(handle);
    const obj = Object.assign({}, data, { el });
    objects.push(obj);
    attachObjectHandlers(obj, handle);
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
    overlay.appendChild(el);
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    el.appendChild(handle);
    const obj = Object.assign({}, data, { el, svgEl: svg });
    objects.push(obj);
    attachObjectHandlers(obj, handle);
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
    overlay.appendChild(el);
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    el.appendChild(handle);
    const obj = Object.assign({}, data, { el });
    objects.push(obj);
    attachObjectHandlers(obj, handle);
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

    const font = await workDoc.embedFont(StandardFonts.Helvetica);
    const pdfPages = workDoc.getPages();
    const imageCache = new Map();

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
        const text = (obj.el.textContent || '').replace(/\n+$/, '');
        if (!text.trim()) continue;
        const fontSizePdf = obj.fontSize / scale;
        const lineHeight = fontSizePdf * 1.25;
        const x = obj.x / scale;
        const topY = obj.y / scale;
        text.split('\n').forEach((line, i) => {
          pdfPage.drawText(line, {
            x,
            y: pageInfo.pdfHeight - topY - fontSizePdf * 0.9 - i * lineHeight,
            size: fontSizePdf,
            font,
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
