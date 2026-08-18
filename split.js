const { PDFDocument } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const THUMB_WIDTH = 220;
const PREVIEW_WIDTH = 1400;
const MAGNIFIER_ZOOM = 3;
const MAGNIFIER_SIZE = 170;

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const modeTabs = document.querySelectorAll('.mode-tab');
const modeHelpEl = document.getElementById('modeHelp');
const modeOptionsEl = document.getElementById('modeOptions');
const pageGridEl = document.getElementById('pageGrid');
const actionBtn = document.getElementById('actionBtn');
const clearBtn = document.getElementById('clearBtn');
const statusEl = document.getElementById('status');
const previewEmpty = document.getElementById('previewEmpty');
const previewContent = document.getElementById('previewContent');
const previewSpinner = document.getElementById('previewSpinner');
const previewImg = document.getElementById('previewImg');
const previewMeta = document.getElementById('previewMeta');
const magnifierGlass = document.getElementById('magnifierGlass');

const singleResultModal = document.getElementById('singleResultModal');
const singleResultGrid = document.getElementById('singleResultGrid');
const singleModalSubtitle = document.getElementById('singleModalSubtitle');
const singleModalCloseBtn = document.getElementById('singleModalCloseBtn');
const singleModalBackBtn = document.getElementById('singleModalBackBtn');
const singleModalDownloadBtn = document.getElementById('singleModalDownloadBtn');

const multiResultModal = document.getElementById('multiResultModal');
const multiResultList = document.getElementById('multiResultList');
const multiModalSubtitle = document.getElementById('multiModalSubtitle');
const multiModalCloseBtn = document.getElementById('multiModalCloseBtn');
const multiModalBackBtn = document.getElementById('multiModalBackBtn');
const multiModalDownloadBtn = document.getElementById('multiModalDownloadBtn');

const MODE_HELP = {
  extract: 'Pick the pages you want (click a thumbnail, or type page numbers below) to pull them into one new PDF.',
  pages: 'Choose how often to split, or click between pages below to add a custom split point. Each section becomes its own PDF.',
  bookmarks: 'Each checked bookmark starts a new PDF at the page it points to.',
  half: 'Every page is cut in half, doubling the page count — handy for scanned two-page spreads.',
  size: 'The PDF is broken into consecutive files, each kept under the size you set.',
  text: 'Pages containing the text you enter become split points. Multiple files are created around them.',
};

const ACTION_LABEL = {
  extract: 'Extract Pages',
  pages: 'Split PDF',
  bookmarks: 'Split by Bookmarks',
  half: 'Split in Half',
  size: 'Split by Size',
  text: 'Split by Text',
};

let activeMode = 'extract';

let sourceFile = null;
let pdfDoc = null; // pdfjs document
let srcPdfLibDoc = null; // pdf-lib document, cached for building outputs
let isEncrypted = false;
let pageCount = 0;
let pageThumbs = []; // dataUrl per page index
let pagePreviewCache = []; // larger preview dataUrl per page index, lazily filled
let selectedPreviewIndex = null;
let previewToken = 0;

// Extract Pages
let selectedPages = new Set();

// Split by Pages
let pageBoundaries = new Set(); // 0-based index after which a new file starts
let everyN = 1;

// Split by Bookmarks
let bookmarks = []; // { id, title, pageIndex, checked }
let bookmarksLoaded = false;

// Split in Half
let halfDirection = 'vertical'; // 'vertical' (left/right) | 'horizontal' (top/bottom)

// Split by Size
let maxSizeMB = 5;

// Split by Text
let textSearchValue = '';
let textMatchTiming = 'before'; // 'before' (match starts new file) | 'after' (match ends file)
let textCaseSensitive = false;
let matchedPageIndices = new Set();
const pageTextCache = new Map();
let textSearchDebounce = null;

let lastSingleResultBytes = null;
let lastSingleResultFilename = 'result.pdf';
let lastMultiResultFiles = []; // { name, bytes }

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  handleFileSelection(e.dataTransfer.files);
});

fileInput.addEventListener('change', () => {
  handleFileSelection(fileInput.files);
  fileInput.value = '';
});

modeTabs.forEach((btn) => {
  btn.addEventListener('click', () => setActiveMode(btn.dataset.mode));
});

clearBtn.addEventListener('click', resetAll);

actionBtn.addEventListener('click', runAction);

singleModalCloseBtn.addEventListener('click', closeSingleModal);
singleModalBackBtn.addEventListener('click', closeSingleModal);
singleResultModal.addEventListener('click', (e) => {
  if (e.target === singleResultModal) closeSingleModal();
});

singleModalDownloadBtn.addEventListener('click', () => {
  if (lastSingleResultBytes) {
    downloadBlob(lastSingleResultBytes, lastSingleResultFilename);
    setStatus(`Downloaded ${lastSingleResultFilename}.`);
  }
  closeSingleModal();
});

multiModalCloseBtn.addEventListener('click', closeMultiModal);
multiModalBackBtn.addEventListener('click', closeMultiModal);
multiResultModal.addEventListener('click', (e) => {
  if (e.target === multiResultModal) closeMultiModal();
});

multiModalDownloadBtn.addEventListener('click', async () => {
  if (lastMultiResultFiles.length === 0) return;
  multiModalDownloadBtn.disabled = true;
  multiModalDownloadBtn.textContent = 'Zipping…';
  try {
    await downloadZip(lastMultiResultFiles, `${baseNameOf(sourceFile.name)}_split.zip`);
    setStatus(`Downloaded ${lastMultiResultFiles.length} files as a zip.`);
    closeMultiModal();
  } catch (err) {
    console.error(err);
    setStatus(`Failed to build zip: ${err.message}`, true);
  } finally {
    multiModalDownloadBtn.disabled = false;
    multiModalDownloadBtn.textContent = 'Download all (.zip)';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!singleResultModal.hidden) closeSingleModal();
  if (!multiResultModal.hidden) closeMultiModal();
});

previewImg.addEventListener('mouseenter', () => {
  if (!previewImg.src || previewImg.hidden) return;
  magnifierGlass.style.backgroundImage = `url('${previewImg.src}')`;
  magnifierGlass.style.backgroundSize = `${previewImg.width * MAGNIFIER_ZOOM}px ${previewImg.height * MAGNIFIER_ZOOM}px`;
  magnifierGlass.hidden = false;
});
previewImg.addEventListener('mousemove', moveMagnifier);
previewImg.addEventListener('mouseleave', () => { magnifierGlass.hidden = true; });

function moveMagnifier(e) {
  const rect = previewImg.getBoundingClientRect();
  const half = MAGNIFIER_SIZE / 2;
  let x = e.clientX - rect.left;
  let y = e.clientY - rect.top;
  const minX = half / MAGNIFIER_ZOOM;
  const maxX = previewImg.width - half / MAGNIFIER_ZOOM;
  const minY = half / MAGNIFIER_ZOOM;
  const maxY = previewImg.height - half / MAGNIFIER_ZOOM;
  x = Math.min(Math.max(x, minX), maxX);
  y = Math.min(Math.max(y, minY), maxY);
  magnifierGlass.style.left = `${x - half}px`;
  magnifierGlass.style.top = `${y - half}px`;
  magnifierGlass.style.backgroundPosition = `-${x * MAGNIFIER_ZOOM - half}px -${y * MAGNIFIER_ZOOM - half}px`;
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

async function handleFileSelection(fileListArg) {
  const pdfFiles = Array.from(fileListArg).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (pdfFiles.length === 0) {
    setStatus('Please select a PDF file.', true);
    return;
  }
  if (pdfFiles.length > 1) {
    setStatus('Split works on one PDF at a time — using the first file you selected.');
  } else {
    setStatus('');
  }
  await loadFile(pdfFiles[0]);
}

async function loadFile(file) {
  let doc;
  let libDoc;
  let bytes;
  try {
    bytes = await file.arrayBuffer();
    doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    libDoc = await PDFDocument.load(bytes.slice(0), { ignoreEncryption: true });
  } catch (err) {
    console.error(err);
    setStatus(`Failed to open ${file.name}: it may be encrypted or corrupted.`, true);
    return;
  }

  resetAll({ keepFile: false });

  sourceFile = file;
  pdfDoc = doc;
  srcPdfLibDoc = libDoc;
  isEncrypted = !!libDoc.isEncrypted;
  pageCount = doc.numPages;
  pageThumbs = new Array(pageCount).fill(null);
  pagePreviewCache = new Array(pageCount).fill(null);
  everyN = 1;
  recomputeBoundariesFromEveryN();

  setStatus(isEncrypted ? `${file.name} is password-protected — pages will be rendered as images to preserve their content.` : '');

  renderPageGrid();
  updateActionAvailability();

  for (let i = 0; i < pageCount; i++) {
    renderThumbForPage(i);
  }

  if (activeMode === 'bookmarks') await ensureBookmarksLoaded();
  renderModeOptions();
  updateActionAvailability();
}

async function renderThumbForPage(index) {
  try {
    const page = await pdfDoc.getPage(index + 1);
    const viewport = page.getViewport({ scale: 1 });
    const scaledViewport = page.getViewport({ scale: THUMB_WIDTH / viewport.width });
    const canvas = document.createElement('canvas');
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledViewport }).promise;
    pageThumbs[index] = canvas.toDataURL('image/jpeg', 0.85);
    updateThumbInGrid(index);
  } catch (err) {
    console.error(err);
  }
}

function updateThumbInGrid(index) {
  const card = pageGridEl.querySelector(`[data-index="${index}"]`);
  if (!card) return;
  const slot = card.querySelector('.page-thumb-img-slot');
  if (slot && pageThumbs[index]) slot.innerHTML = `<img src="${pageThumbs[index]}" alt="Page ${index + 1}">`;
}

// ---------------------------------------------------------------------------
// Mode switching
// ---------------------------------------------------------------------------

function setActiveMode(mode) {
  activeMode = mode;
  modeTabs.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  modeHelpEl.textContent = MODE_HELP[mode];
  actionBtn.textContent = ACTION_LABEL[mode];
  clearPreview();

  if (mode === 'bookmarks' && pdfDoc) {
    ensureBookmarksLoaded().then(() => {
      renderModeOptions();
      updateActionAvailability();
    });
  }

  renderModeOptions();
  renderPageGrid();
  updateActionAvailability();
}

function renderModeOptions() {
  modeOptionsEl.innerHTML = '';
  modeOptionsEl.hidden = !pdfDoc;
  if (!pdfDoc) return;

  if (activeMode === 'extract') renderExtractOptions();
  else if (activeMode === 'pages') renderPagesOptions();
  else if (activeMode === 'bookmarks') renderBookmarksOptions();
  else if (activeMode === 'half') renderHalfOptions();
  else if (activeMode === 'size') renderSizeOptions();
  else if (activeMode === 'text') renderTextOptions();
}

function updateActionAvailability() {
  clearBtn.disabled = !pdfDoc;

  if (!pdfDoc) {
    actionBtn.disabled = true;
    return;
  }

  if (activeMode === 'extract') {
    actionBtn.disabled = selectedPages.size === 0;
  } else if (activeMode === 'pages') {
    actionBtn.disabled = pageBoundaries.size === 0;
  } else if (activeMode === 'bookmarks') {
    actionBtn.disabled = !bookmarksLoaded || bookmarks.every(b => !b.checked);
  } else if (activeMode === 'half') {
    actionBtn.disabled = pageCount === 0;
  } else if (activeMode === 'size') {
    actionBtn.disabled = !(maxSizeMB > 0);
  } else if (activeMode === 'text') {
    actionBtn.disabled = matchedPageIndices.size === 0;
  }
}

// ---------------------------------------------------------------------------
// Page grid (shared thumbnail viewer, mode-specific interaction layer)
// ---------------------------------------------------------------------------

function renderPageGrid() {
  pageGridEl.innerHTML = '';
  pageGridEl.classList.toggle('divider-mode', activeMode === 'pages' && pageCount > 0);

  if (!pdfDoc) return;

  if (activeMode === 'pages') {
    renderPagesGridWithDividers();
    return;
  }

  for (let i = 0; i < pageCount; i++) {
    pageGridEl.appendChild(buildPageCard(i));
  }
}

function buildPageCard(index) {
  const card = document.createElement('div');
  let className = 'page-card';
  if (activeMode === 'extract' && selectedPages.has(index)) className += ' selected';
  if (activeMode === 'text' && matchedPageIndices.has(index)) className += ' match-highlight';
  if (index === selectedPreviewIndex) className += ' previewing';
  card.className = className;
  card.dataset.index = String(index);

  card.innerHTML = `
    <div class="page-thumb-wrap">
      <div class="page-thumb-img-slot">${pageThumbs[index] ? `<img src="${pageThumbs[index]}" alt="Page ${index + 1}">` : '<div class="spinner"></div>'}</div>
    </div>
    <span class="page-index">${index + 1}</span>
    ${activeMode === 'text' && matchedPageIndices.has(index) ? '<span class="match-badge">match</span>' : ''}
  `;

  card.addEventListener('click', () => {
    if (activeMode === 'extract') {
      toggleExtractPage(index);
    } else {
      showPagePreview(index);
    }
  });

  return card;
}

function renderPagesGridWithDividers() {
  for (let i = 0; i < pageCount; i++) {
    pageGridEl.appendChild(buildPageCard(i));
    if (i < pageCount - 1) pageGridEl.appendChild(buildDivider(i));
  }
}

function buildDivider(boundaryIndex) {
  const div = document.createElement('div');
  div.className = 'split-divider' + (pageBoundaries.has(boundaryIndex) ? ' active' : '');
  div.title = pageBoundaries.has(boundaryIndex) ? 'Remove this split point' : 'Split here';
  div.innerHTML = `<span class="divider-icon">${pageBoundaries.has(boundaryIndex) ? '&#10003;' : '&#43;'}</span>`;
  div.addEventListener('click', () => {
    if (pageBoundaries.has(boundaryIndex)) pageBoundaries.delete(boundaryIndex);
    else pageBoundaries.add(boundaryIndex);
    renderPageGrid();
    updateActionAvailability();
  });
  return div;
}

// ---------------------------------------------------------------------------
// Extract Pages
// ---------------------------------------------------------------------------

function toggleExtractPage(index) {
  if (selectedPages.has(index)) selectedPages.delete(index);
  else selectedPages.add(index);
  renderPageGrid();
  renderModeOptions();
  updateActionAvailability();
}

function renderExtractOptions() {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <label for="extractRangeInput">Pages to extract</label>
    <input type="text" id="extractRangeInput" placeholder="e.g. 1-3, 5, 8-10" value="${formatRanges(selectedPages)}">
    <button type="button" class="btn-chip" id="extractSelectAllBtn">Select all</button>
    <button type="button" class="btn-chip" id="extractClearBtn">Clear</button>
  `;
  modeOptionsEl.appendChild(row);

  const input = row.querySelector('#extractRangeInput');
  const apply = () => {
    selectedPages = parseRanges(input.value, pageCount);
    renderPageGrid();
    updateActionAvailability();
  };
  input.addEventListener('change', apply);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });

  row.querySelector('#extractSelectAllBtn').addEventListener('click', () => {
    selectedPages = new Set(Array.from({ length: pageCount }, (_, i) => i));
    renderPageGrid();
    renderModeOptions();
    updateActionAvailability();
  });
  row.querySelector('#extractClearBtn').addEventListener('click', () => {
    selectedPages = new Set();
    renderPageGrid();
    renderModeOptions();
    updateActionAvailability();
  });
}

function formatRanges(indexSet) {
  const sorted = [...indexSet].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const parts = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) { prev = cur; continue; }
    parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
    start = cur; prev = cur;
  }
  return parts.join(', ');
}

function parseRanges(str, count) {
  const result = new Set();
  const cleaned = str.trim();
  if (!cleaned) return result;
  for (const chunk of cleaned.split(',')) {
    const part = chunk.trim();
    if (!part) continue;
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      let a = parseInt(rangeMatch[1], 10);
      let b = parseInt(rangeMatch[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let n = a; n <= b; n++) {
        if (n >= 1 && n <= count) result.add(n - 1);
      }
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= count) result.add(n - 1);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Split by Pages
// ---------------------------------------------------------------------------

function recomputeBoundariesFromEveryN() {
  pageBoundaries = new Set();
  if (everyN >= 1) {
    for (let b = everyN - 1; b < pageCount - 1; b += everyN) {
      pageBoundaries.add(b);
    }
  }
}

function renderPagesOptions() {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <label for="everyNInput">Split every</label>
    <input type="number" id="everyNInput" min="1" max="${Math.max(pageCount - 1, 1)}" value="${everyN}">
    <span class="field-hint">page${everyN === 1 ? '' : 's'}</span>
  `;
  modeOptionsEl.appendChild(row);

  const hint = document.createElement('p');
  hint.className = 'field-hint';
  hint.textContent = `${pageBoundaries.size} split point${pageBoundaries.size === 1 ? '' : 's'} — ${pageBoundaries.size + 1} file${pageBoundaries.size === 0 ? '' : 's'} will be created. Click between pages below to fine-tune.`;
  modeOptionsEl.appendChild(hint);

  row.querySelector('#everyNInput').addEventListener('change', (e) => {
    const n = Math.max(1, parseInt(e.target.value, 10) || 1);
    everyN = n;
    recomputeBoundariesFromEveryN();
    renderPageGrid();
    renderModeOptions();
    updateActionAvailability();
  });
}

// ---------------------------------------------------------------------------
// Split by Bookmarks
// ---------------------------------------------------------------------------

async function ensureBookmarksLoaded() {
  if (bookmarksLoaded || !pdfDoc) return;
  try {
    const outline = await pdfDoc.getOutline();
    const resolved = [];
    if (outline) {
      for (const item of outline) {
        if (!item.dest) continue;
        const pageIndex = await resolveDestToPageIndex(item.dest);
        if (pageIndex === null || pageIndex < 0 || pageIndex >= pageCount) continue;
        resolved.push({ id: crypto.randomUUID(), title: item.title || 'Untitled', pageIndex, checked: true });
      }
    }
    resolved.sort((a, b) => a.pageIndex - b.pageIndex);
    const seen = new Set();
    bookmarks = resolved.filter((b) => {
      if (seen.has(b.pageIndex)) return false;
      seen.add(b.pageIndex);
      return true;
    });
  } catch (err) {
    console.error('Failed to read bookmarks:', err);
    bookmarks = [];
  }
  bookmarksLoaded = true;
}

async function resolveDestToPageIndex(dest) {
  try {
    let explicitDest = dest;
    if (typeof dest === 'string') {
      explicitDest = await pdfDoc.getDestination(dest);
    }
    if (!explicitDest || !Array.isArray(explicitDest)) return null;
    const ref = explicitDest[0];
    if (ref && typeof ref === 'object') {
      return await pdfDoc.getPageIndex(ref);
    }
    if (typeof ref === 'number') return ref;
    return null;
  } catch (err) {
    console.error('Failed to resolve bookmark destination:', err);
    return null;
  }
}

function renderBookmarksOptions() {
  if (!bookmarksLoaded) {
    const p = document.createElement('p');
    p.className = 'field-hint';
    p.textContent = 'Reading bookmarks…';
    modeOptionsEl.appendChild(p);
    return;
  }

  if (bookmarks.length === 0) {
    const p = document.createElement('p');
    p.className = 'field-hint';
    p.textContent = 'This PDF has no bookmarks to split by.';
    modeOptionsEl.appendChild(p);
    return;
  }

  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <button type="button" class="btn-chip" id="bookmarksCheckAllBtn">Check all</button>
    <button type="button" class="btn-chip" id="bookmarksUncheckAllBtn">Uncheck all</button>
  `;
  modeOptionsEl.appendChild(row);
  row.querySelector('#bookmarksCheckAllBtn').addEventListener('click', () => {
    bookmarks.forEach(b => b.checked = true);
    renderModeOptions();
    updateActionAvailability();
  });
  row.querySelector('#bookmarksUncheckAllBtn').addEventListener('click', () => {
    bookmarks.forEach(b => b.checked = false);
    renderModeOptions();
    updateActionAvailability();
  });

  const list = document.createElement('div');
  list.className = 'bookmark-list';
  bookmarks.forEach((b) => {
    const item = document.createElement('label');
    item.className = 'bookmark-item';
    item.innerHTML = `
      <input type="checkbox" ${b.checked ? 'checked' : ''}>
      <span class="bookmark-title" title="${b.title}">${b.title}</span>
      <span class="bookmark-page">p.${b.pageIndex + 1}</span>
    `;
    item.querySelector('input').addEventListener('change', (e) => {
      b.checked = e.target.checked;
      updateActionAvailability();
    });
    list.appendChild(item);
  });
  modeOptionsEl.appendChild(list);
}

// ---------------------------------------------------------------------------
// Split in Half
// ---------------------------------------------------------------------------

function renderHalfOptions() {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <button type="button" class="btn-chip" data-dir="vertical">Left / Right</button>
    <button type="button" class="btn-chip" data-dir="horizontal">Top / Bottom</button>
    <span class="field-hint">Cut direction</span>
  `;
  row.querySelectorAll('.btn-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.dir === halfDirection);
    btn.addEventListener('click', () => {
      halfDirection = btn.dataset.dir;
      renderModeOptions();
    });
  });
  modeOptionsEl.appendChild(row);
}

// ---------------------------------------------------------------------------
// Split by Size
// ---------------------------------------------------------------------------

function renderSizeOptions() {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <label for="maxSizeInput">Max size per file</label>
    <input type="number" id="maxSizeInput" min="0.1" step="0.1" value="${maxSizeMB}">
    <span class="field-hint">MB</span>
  `;
  modeOptionsEl.appendChild(row);

  row.querySelector('#maxSizeInput').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    maxSizeMB = v > 0 ? v : maxSizeMB;
    updateActionAvailability();
  });
}

// ---------------------------------------------------------------------------
// Split by Text
// ---------------------------------------------------------------------------

function renderTextOptions() {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <label for="textSearchInput">Text to find</label>
    <input type="text" id="textSearchInput" placeholder="e.g. Invoice" value="${escapeAttr(textSearchValue)}">
  `;
  modeOptionsEl.appendChild(row);

  const radios = document.createElement('div');
  radios.className = 'radio-group';
  radios.innerHTML = `
    <label class="radio-row"><input type="radio" name="matchTiming" value="before" ${textMatchTiming === 'before' ? 'checked' : ''}> Start a new file at each matching page</label>
    <label class="radio-row"><input type="radio" name="matchTiming" value="after" ${textMatchTiming === 'after' ? 'checked' : ''}> End the file after each matching page</label>
    <label class="checkbox-row"><input type="checkbox" id="caseSensitiveInput" ${textCaseSensitive ? 'checked' : ''}> Case sensitive</label>
  `;
  modeOptionsEl.appendChild(radios);

  const summary = document.createElement('p');
  summary.className = 'match-summary' + (matchedPageIndices.size > 0 ? ' has-matches' : '');
  summary.id = 'matchSummary';
  summary.textContent = textMatchSummaryText();
  modeOptionsEl.appendChild(summary);

  const input = row.querySelector('#textSearchInput');
  input.addEventListener('input', () => {
    textSearchValue = input.value;
    clearTimeout(textSearchDebounce);
    textSearchDebounce = setTimeout(runTextSearch, 300);
  });

  radios.querySelectorAll('input[name="matchTiming"]').forEach((r) => {
    r.addEventListener('change', (e) => { textMatchTiming = e.target.value; updateActionAvailability(); });
  });
  radios.querySelector('#caseSensitiveInput').addEventListener('change', (e) => {
    textCaseSensitive = e.target.checked;
    runTextSearch();
  });
}

function textMatchSummaryText() {
  if (!textSearchValue.trim()) return 'Type text above to find split points.';
  if (matchedPageIndices.size === 0) return 'No matches found.';
  const pages = [...matchedPageIndices].sort((a, b) => a - b).map(i => i + 1);
  return `Found on page${pages.length === 1 ? '' : 's'}: ${pages.join(', ')}`;
}

async function getPageText(index) {
  if (pageTextCache.has(index)) return pageTextCache.get(index);
  const page = await pdfDoc.getPage(index + 1);
  const content = await page.getTextContent();
  const text = content.items.map(it => it.str).join(' ');
  pageTextCache.set(index, text);
  return text;
}

async function runTextSearch() {
  const query = textSearchValue.trim();
  if (!query) {
    matchedPageIndices = new Set();
    renderPageGrid();
    renderModeOptions();
    updateActionAvailability();
    return;
  }

  const needle = textCaseSensitive ? query : query.toLowerCase();
  const matched = new Set();
  for (let i = 0; i < pageCount; i++) {
    const text = await getPageText(i);
    const haystack = textCaseSensitive ? text : text.toLowerCase();
    if (haystack.includes(needle)) matched.add(i);
  }
  matchedPageIndices = matched;
  renderPageGrid();
  renderModeOptions();
  updateActionAvailability();
}

// ---------------------------------------------------------------------------
// Shared chunk-building helpers
// ---------------------------------------------------------------------------

function chunksFromBoundaries(boundarySet) {
  const boundaries = [...boundarySet].sort((a, b) => a - b);
  const chunks = [];
  let start = 0;
  for (const b of boundaries) {
    if (b >= start) {
      chunks.push([start, b]);
      start = b + 1;
    }
  }
  chunks.push([start, pageCount - 1]);
  return chunks;
}

function chunksFromStarts(startIndices) {
  const starts = new Set(startIndices);
  starts.add(0);
  const sorted = [...starts].filter(s => s >= 0 && s < pageCount).sort((a, b) => a - b);
  const chunks = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    const end = i + 1 < sorted.length ? sorted[i + 1] - 1 : pageCount - 1;
    chunks.push([start, end]);
  }
  return chunks;
}

async function addPageTo(destPdf, index) {
  if (isEncrypted) {
    await addRasterPageTo(destPdf, index);
    return;
  }
  try {
    const [copied] = await destPdf.copyPages(srcPdfLibDoc, [index]);
    destPdf.addPage(copied);
  } catch (err) {
    console.error('copyPages failed, falling back to a rendered image:', err);
    await addRasterPageTo(destPdf, index);
  }
}

async function addRasterPageTo(destPdf, index) {
  const page = await pdfDoc.getPage(index + 1);
  const renderViewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = renderViewport.width;
  canvas.height = renderViewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderViewport }).promise;

  const imgBytes = dataUrlToUint8Array(canvas.toDataURL('image/jpeg', 0.92));
  const embedded = await destPdf.embedJpg(imgBytes);
  const pageViewport = page.getViewport({ scale: 1 });
  const newPage = destPdf.addPage([pageViewport.width, pageViewport.height]);
  newPage.drawImage(embedded, { x: 0, y: 0, width: pageViewport.width, height: pageViewport.height });
}

async function buildChunkPdf(indices) {
  const destPdf = await PDFDocument.create();
  for (const idx of indices) {
    await addPageTo(destPdf, idx);
  }
  return destPdf.save();
}

async function buildRangeChunks(ranges, nameFor) {
  const files = [];
  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i];
    const indices = [];
    for (let p = start; p <= end; p++) indices.push(p);
    const bytes = await buildChunkPdf(indices);
    files.push({ name: nameFor(start, end, i), bytes, pageCount: indices.length });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Split in Half builders
// ---------------------------------------------------------------------------

async function buildHalfSplitPdf() {
  const destPdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    if (isEncrypted) {
      await addRasterHalfPagesTo(destPdf, i);
      continue;
    }
    try {
      await addVectorHalfPagesTo(destPdf, i);
    } catch (err) {
      console.error('Vector half-split failed, falling back to a rendered image:', err);
      await addRasterHalfPagesTo(destPdf, i);
    }
  }
  return destPdf.save();
}

async function addVectorHalfPagesTo(destPdf, index) {
  const [pageA] = await destPdf.copyPages(srcPdfLibDoc, [index]);
  const [pageB] = await destPdf.copyPages(srcPdfLibDoc, [index]);
  const box = pageA.getMediaBox();

  if (halfDirection === 'vertical') {
    const halfW = box.width / 2;
    pageA.setMediaBox(box.x, box.y, halfW, box.height);
    pageA.setCropBox(box.x, box.y, halfW, box.height);
    pageB.setMediaBox(box.x + halfW, box.y, halfW, box.height);
    pageB.setCropBox(box.x + halfW, box.y, halfW, box.height);
  } else {
    const halfH = box.height / 2;
    pageA.setMediaBox(box.x, box.y + halfH, box.width, halfH);
    pageA.setCropBox(box.x, box.y + halfH, box.width, halfH);
    pageB.setMediaBox(box.x, box.y, box.width, halfH);
    pageB.setCropBox(box.x, box.y, box.width, halfH);
  }

  destPdf.addPage(pageA);
  destPdf.addPage(pageB);
}

async function addRasterHalfPagesTo(destPdf, index) {
  const page = await pdfDoc.getPage(index + 1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

  const pageViewport1 = page.getViewport({ scale: 1 });
  let rects;
  if (halfDirection === 'vertical') {
    const halfW = viewport.width / 2;
    rects = [
      { sx: 0, sy: 0, sw: halfW, sh: viewport.height, outW: pageViewport1.width / 2, outH: pageViewport1.height },
      { sx: halfW, sy: 0, sw: halfW, sh: viewport.height, outW: pageViewport1.width / 2, outH: pageViewport1.height },
    ];
  } else {
    const halfH = viewport.height / 2;
    rects = [
      { sx: 0, sy: 0, sw: viewport.width, sh: halfH, outW: pageViewport1.width, outH: pageViewport1.height / 2 },
      { sx: 0, sy: halfH, sw: viewport.width, sh: halfH, outW: pageViewport1.width, outH: pageViewport1.height / 2 },
    ];
  }

  for (const r of rects) {
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = r.sw;
    cropCanvas.height = r.sh;
    cropCanvas.getContext('2d').drawImage(canvas, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
    const imgBytes = dataUrlToUint8Array(cropCanvas.toDataURL('image/jpeg', 0.92));
    const embedded = await destPdf.embedJpg(imgBytes);
    const newPage = destPdf.addPage([r.outW, r.outH]);
    newPage.drawImage(embedded, { x: 0, y: 0, width: r.outW, height: r.outH });
  }
}

// ---------------------------------------------------------------------------
// Split by Size builder
// ---------------------------------------------------------------------------

async function buildSizeSplitChunks(maxBytes) {
  const chunks = [];
  let workingDoc = await PDFDocument.create();
  let workingCount = 0;
  let lastGoodBytes = null;
  let chunkStart = 0;

  for (let i = 0; i < pageCount; i++) {
    await addPageTo(workingDoc, i);
    workingCount++;
    const bytes = await workingDoc.save();

    if (bytes.byteLength > maxBytes && workingCount > 1) {
      workingDoc.removePage(workingDoc.getPageCount() - 1);
      const finalBytes = lastGoodBytes || (await workingDoc.save());
      chunks.push({ startIdx: chunkStart, endIdx: i - 1, bytes: finalBytes });

      workingDoc = await PDFDocument.create();
      await addPageTo(workingDoc, i);
      workingCount = 1;
      chunkStart = i;
      lastGoodBytes = await workingDoc.save();
    } else {
      lastGoodBytes = bytes;
    }
  }

  if (workingCount > 0) {
    chunks.push({ startIdx: chunkStart, endIdx: pageCount - 1, bytes: lastGoodBytes });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Run dispatcher
// ---------------------------------------------------------------------------

async function runAction() {
  actionBtn.disabled = true;
  clearBtn.disabled = true;

  try {
    if (activeMode === 'extract') {
      setStatus('Extracting pages...');
      const indices = [...selectedPages].sort((a, b) => a - b);
      const bytes = await buildChunkPdf(indices);
      lastSingleResultBytes = bytes;
      lastSingleResultFilename = `${baseNameOf(sourceFile.name)}_extracted.pdf`;
      singleModalSubtitle.textContent = isEncrypted
        ? 'This PDF is password-protected, so pages were rendered as images to preserve their content.'
        : 'Check every page before downloading. Go back if something looks wrong.';
      singleModalSubtitle.classList.toggle('warning', isEncrypted);
      setStatus('');
      await openSingleResultModal(bytes);
    } else if (activeMode === 'half') {
      setStatus('Splitting pages in half...');
      const bytes = await buildHalfSplitPdf();
      lastSingleResultBytes = bytes;
      lastSingleResultFilename = `${baseNameOf(sourceFile.name)}_split-in-half.pdf`;
      singleModalSubtitle.textContent = 'Check every page before downloading. Go back if something looks wrong.';
      singleModalSubtitle.classList.remove('warning');
      setStatus('');
      await openSingleResultModal(bytes);
    } else if (activeMode === 'pages') {
      setStatus('Splitting PDF...');
      const ranges = chunksFromBoundaries(pageBoundaries);
      const base = baseNameOf(sourceFile.name);
      const files = await buildRangeChunks(ranges, (start, end) => `${base}_p${start + 1}-${end + 1}.pdf`);
      setStatus('');
      openMultiResultModal(files);
    } else if (activeMode === 'bookmarks') {
      setStatus('Splitting by bookmarks...');
      const checkedStarts = bookmarks.filter(b => b.checked).map(b => b.pageIndex);
      const ranges = chunksFromStarts(checkedStarts);
      const base = baseNameOf(sourceFile.name);
      const titleForStart = new Map(bookmarks.filter(b => b.checked).map(b => [b.pageIndex, b.title]));
      const files = await buildRangeChunks(ranges, (start, end, i) => {
        const title = titleForStart.get(start);
        return title ? `${base}_${sanitizeFilename(title)}.pdf` : `${base}_p${start + 1}-${end + 1}.pdf`;
      });
      setStatus('');
      openMultiResultModal(files);
    } else if (activeMode === 'size') {
      setStatus('Splitting by size...');
      const maxBytes = maxSizeMB * 1024 * 1024;
      const chunks = await buildSizeSplitChunks(maxBytes);
      const base = baseNameOf(sourceFile.name);
      const files = chunks.map((c, i) => ({
        name: `${base}_part${i + 1}.pdf`,
        bytes: c.bytes,
        pageCount: c.endIdx - c.startIdx + 1,
      }));
      const oversized = files.filter(f => f.bytes.byteLength > maxBytes);
      setStatus(oversized.length > 0 ? `${oversized.length} file${oversized.length === 1 ? '' : 's'} couldn't fit a single page under the size limit and are slightly larger.` : '');
      openMultiResultModal(files);
    } else if (activeMode === 'text') {
      setStatus('Splitting by text...');
      const boundaries = new Set();
      const matches = [...matchedPageIndices].sort((a, b) => a - b);
      if (textMatchTiming === 'before') {
        for (const m of matches) if (m > 0) boundaries.add(m - 1);
      } else {
        for (const m of matches) if (m < pageCount - 1) boundaries.add(m);
      }
      if (boundaries.size === 0) {
        setStatus('The matched page(s) don’t create a valid split point.', true);
        return;
      }
      const ranges = chunksFromBoundaries(boundaries);
      const base = baseNameOf(sourceFile.name);
      const files = await buildRangeChunks(ranges, (start, end) => `${base}_p${start + 1}-${end + 1}.pdf`);
      setStatus('');
      openMultiResultModal(files);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Failed to split: ${err.message}`, true);
  } finally {
    updateActionAvailability();
    clearBtn.disabled = !pdfDoc;
  }
}

// ---------------------------------------------------------------------------
// Result modals
// ---------------------------------------------------------------------------

async function openSingleResultModal(bytes) {
  singleResultGrid.innerHTML = '';
  singleResultModal.hidden = false;

  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const cards = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const card = document.createElement('div');
    card.className = 'page-card preview-only';
    card.innerHTML = `<div class="page-thumb-wrap"><div class="spinner"></div></div><span class="page-index">${i}</span>`;
    singleResultGrid.appendChild(card);
    cards.push(card);
  }
  await Promise.all(cards.map((card, i) => renderResultPage(doc, i + 1, card)));
}

async function renderResultPage(doc, pageNum, card) {
  try {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const scaledViewport = page.getViewport({ scale: THUMB_WIDTH / viewport.width });
    const canvas = document.createElement('canvas');
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledViewport }).promise;
    card.querySelector('.page-thumb-wrap').innerHTML = `<img src="${canvas.toDataURL('image/jpeg', 0.85)}" alt="Page ${pageNum}">`;
  } catch (err) {
    console.error(err);
    card.querySelector('.page-thumb-wrap').innerHTML = '<span style="font-size:11px;color:var(--danger);padding:8px;text-align:center;">Preview failed</span>';
  }
}

function closeSingleModal() {
  singleResultModal.hidden = true;
  singleResultGrid.innerHTML = '';
}

async function openMultiResultModal(files) {
  lastMultiResultFiles = files;
  multiResultList.innerHTML = '';
  multiModalSubtitle.textContent = `${files.length} file${files.length === 1 ? '' : 's'} will be created.`;
  multiResultModal.hidden = false;

  for (const file of files) {
    const card = document.createElement('div');
    card.className = 'result-file-card';
    card.innerHTML = `
      <div class="result-file-thumb"><div class="spinner"></div></div>
      <div class="result-file-info">
        <div class="result-file-name" title="${file.name}">${file.name}</div>
        <div class="result-file-meta">${file.pageCount} page${file.pageCount === 1 ? '' : 's'} &middot; ${formatBytes(file.bytes.byteLength)}</div>
        <button type="button" class="result-file-download">Download</button>
      </div>
    `;
    card.querySelector('.result-file-download').addEventListener('click', () => downloadBlob(file.bytes, file.name));
    multiResultList.appendChild(card);
    renderResultThumb(file, card.querySelector('.result-file-thumb'));
  }
}

async function renderResultThumb(file, thumbEl) {
  try {
    const doc = await pdfjsLib.getDocument({ data: file.bytes.slice() }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const scaledViewport = page.getViewport({ scale: 90 / viewport.width });
    const canvas = document.createElement('canvas');
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledViewport }).promise;
    thumbEl.innerHTML = `<img src="${canvas.toDataURL('image/jpeg', 0.85)}" alt="${file.name}">`;
  } catch (err) {
    console.error(err);
    thumbEl.innerHTML = '';
  }
}

function closeMultiModal() {
  multiResultModal.hidden = true;
  multiResultList.innerHTML = '';
}

async function downloadZip(files, zipName) {
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.bytes);
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Preview panel
// ---------------------------------------------------------------------------

async function showPagePreview(index) {
  selectedPreviewIndex = index;
  pageGridEl.querySelectorAll('.page-card').forEach((card) => {
    card.classList.toggle('previewing', card.dataset.index === String(index));
  });

  const token = ++previewToken;
  previewEmpty.hidden = true;
  previewContent.hidden = false;
  previewMeta.textContent = `Page ${index + 1} of ${pageCount}`;
  magnifierGlass.hidden = true;

  if (pagePreviewCache[index]) {
    previewImg.src = pagePreviewCache[index];
    previewSpinner.hidden = true;
    previewImg.hidden = false;
    return;
  }

  previewImg.hidden = true;
  previewSpinner.hidden = false;

  try {
    const page = await pdfDoc.getPage(index + 1);
    const viewport = page.getViewport({ scale: 1 });
    const scaledViewport = page.getViewport({ scale: PREVIEW_WIDTH / viewport.width });
    const canvas = document.createElement('canvas');
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledViewport }).promise;

    if (token !== previewToken) return;
    pagePreviewCache[index] = canvas.toDataURL('image/jpeg', 0.9);
    previewImg.src = pagePreviewCache[index];
    previewSpinner.hidden = true;
    previewImg.hidden = false;
  } catch (err) {
    console.error(err);
    if (token !== previewToken) return;
    previewSpinner.hidden = true;
    previewMeta.textContent = `Failed to preview page ${index + 1}.`;
  }
}

function clearPreview() {
  previewToken++;
  selectedPreviewIndex = null;
  previewContent.hidden = true;
  previewEmpty.hidden = false;
  previewImg.src = '';
  magnifierGlass.hidden = true;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

function resetAll() {
  sourceFile = null;
  pdfDoc = null;
  srcPdfLibDoc = null;
  isEncrypted = false;
  pageCount = 0;
  pageThumbs = [];
  pagePreviewCache = [];
  selectedPreviewIndex = null;

  selectedPages = new Set();
  pageBoundaries = new Set();
  everyN = 1;
  bookmarks = [];
  bookmarksLoaded = false;
  halfDirection = 'vertical';
  maxSizeMB = 5;
  textSearchValue = '';
  textMatchTiming = 'before';
  textCaseSensitive = false;
  matchedPageIndices = new Set();
  pageTextCache.clear();

  clearPreview();
  renderPageGrid();
  renderModeOptions();
  updateActionAvailability();
  setStatus('');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function baseNameOf(filename) {
  return filename.replace(/\.pdf$/i, '');
}

function sanitizeFilename(str) {
  const cleaned = str.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || 'untitled';
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function dataUrlToUint8Array(dataUrl) {
  const binary = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

setActiveMode('extract');
