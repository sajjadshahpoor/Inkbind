const { PDFDocument } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const THUMB_WIDTH = 220;
const PREVIEW_WIDTH = 1400;
const MAGNIFIER_ZOOM = 3;
const MAGNIFIER_SIZE = 170;

const QUALITY_PRESETS = {
  low: { label: 'Less compression', hint: 'Higher quality, smaller savings', scale: 2, jpegQuality: 0.85 },
  recommended: { label: 'Recommended', hint: 'Good balance of size and quality', scale: 1.5, jpegQuality: 0.7 },
  high: { label: 'Extreme compression', hint: 'Smallest file, lower quality', scale: 1, jpegQuality: 0.45 },
};

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
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

const resultModal = document.getElementById('resultModal');
const resultGrid = document.getElementById('resultGrid');
const resultModalSubtitle = document.getElementById('resultModalSubtitle');
const resultModalCloseBtn = document.getElementById('resultModalCloseBtn');
const resultModalBackBtn = document.getElementById('resultModalBackBtn');
const resultModalDownloadBtn = document.getElementById('resultModalDownloadBtn');

let sourceFile = null;
let pdfDoc = null; // pdfjs document
let originalBytes = null;
let pageCount = 0;
let pageThumbs = [];
let pagePreviewCache = [];
let selectedPreviewIndex = null;
let previewToken = 0;
let qualityPreset = 'recommended';

let lastResultBytes = null;
let lastResultFilename = 'compressed.pdf';

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

clearBtn.addEventListener('click', resetAll);
actionBtn.addEventListener('click', runCompress);

resultModalCloseBtn.addEventListener('click', closeResultModal);
resultModalBackBtn.addEventListener('click', closeResultModal);
resultModal.addEventListener('click', (e) => {
  if (e.target === resultModal) closeResultModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !resultModal.hidden) closeResultModal();
});

resultModalDownloadBtn.addEventListener('click', () => {
  if (lastResultBytes) {
    downloadBlob(lastResultBytes, lastResultFilename, 'application/pdf');
    setStatus(`Downloaded ${lastResultFilename}.`);
  }
  closeResultModal();
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
    setStatus('Compress works on one PDF at a time — using the first file you selected.');
  } else {
    setStatus('');
  }
  await loadFile(pdfFiles[0]);
}

async function loadFile(file) {
  let doc;
  let bytes;
  try {
    bytes = await file.arrayBuffer();
    doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  } catch (err) {
    console.error(err);
    setStatus(`Failed to open ${file.name}: it may be encrypted or corrupted.`, true);
    return;
  }

  resetAll();

  sourceFile = file;
  pdfDoc = doc;
  originalBytes = new Uint8Array(bytes);
  pageCount = doc.numPages;
  pageThumbs = new Array(pageCount).fill(null);
  pagePreviewCache = new Array(pageCount).fill(null);

  setStatus('');
  renderPageGrid();
  renderModeOptions();
  updateActionAvailability();

  for (let i = 0; i < pageCount; i++) {
    renderThumbForPage(i);
  }
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
// Page grid (read-only viewer with click-to-preview)
// ---------------------------------------------------------------------------

function renderPageGrid() {
  pageGridEl.innerHTML = '';
  if (!pdfDoc) return;
  for (let i = 0; i < pageCount; i++) {
    pageGridEl.appendChild(buildPageCard(i));
  }
}

function buildPageCard(index) {
  const card = document.createElement('div');
  card.className = 'page-card' + (index === selectedPreviewIndex ? ' previewing' : '');
  card.dataset.index = String(index);
  card.innerHTML = `
    <div class="page-thumb-wrap">
      <div class="page-thumb-img-slot">${pageThumbs[index] ? `<img src="${pageThumbs[index]}" alt="Page ${index + 1}">` : '<div class="spinner"></div>'}</div>
    </div>
    <span class="page-index">${index + 1}</span>
  `;
  card.addEventListener('click', () => showPagePreview(index));
  return card;
}

// ---------------------------------------------------------------------------
// Quality options
// ---------------------------------------------------------------------------

function renderModeOptions() {
  modeOptionsEl.innerHTML = '';
  modeOptionsEl.hidden = !pdfDoc;
  if (!pdfDoc) return;

  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <label>Compression level</label>
    ${Object.entries(QUALITY_PRESETS).map(([key, preset]) => `<button type="button" class="btn-chip" data-quality="${key}" title="${preset.hint}">${preset.label}</button>`).join('')}
  `;
  row.querySelectorAll('.btn-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.quality === qualityPreset);
    btn.addEventListener('click', () => { qualityPreset = btn.dataset.quality; renderModeOptions(); });
  });
  modeOptionsEl.appendChild(row);

  const hint = document.createElement('p');
  hint.className = 'field-hint';
  hint.textContent = QUALITY_PRESETS[qualityPreset].hint;
  modeOptionsEl.appendChild(hint);
}

function updateActionAvailability() {
  clearBtn.disabled = !pdfDoc;
  actionBtn.disabled = !pdfDoc || pageCount === 0;
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

async function buildLosslessBytes(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.save({ useObjectStreams: true });
}

async function buildRasterizedBytes(quality) {
  const { scale, jpegQuality } = QUALITY_PRESETS[quality];
  const destPdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = await pdfDoc.getPage(i + 1);
    const renderViewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = renderViewport.width;
    canvas.height = renderViewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderViewport }).promise;

    const imgBytes = dataUrlToUint8Array(canvas.toDataURL('image/jpeg', jpegQuality));
    const embedded = await destPdf.embedJpg(imgBytes);
    const pageViewport1 = page.getViewport({ scale: 1 });
    const newPage = destPdf.addPage([pageViewport1.width, pageViewport1.height]);
    newPage.drawImage(embedded, { x: 0, y: 0, width: pageViewport1.width, height: pageViewport1.height });
  }
  return destPdf.save();
}

async function runCompress() {
  actionBtn.disabled = true;
  clearBtn.disabled = true;

  try {
    setStatus('Compressing...');

    let losslessBytes = null;
    try {
      losslessBytes = await buildLosslessBytes(originalBytes);
    } catch (err) {
      console.error('Lossless resave failed:', err);
    }

    const rasterBytes = await buildRasterizedBytes(qualityPreset);

    let resultBytes = rasterBytes;
    let method = 'raster';
    if (losslessBytes && losslessBytes.byteLength < rasterBytes.byteLength) {
      resultBytes = losslessBytes;
      method = 'lossless';
    }

    setStatus('');
    lastResultFilename = `${baseNameOf(sourceFile.name)}_compressed.pdf`;
    await openResultModal(resultBytes, method);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to compress: ${err.message}`, true);
  } finally {
    updateActionAvailability();
  }
}

// ---------------------------------------------------------------------------
// Result modal
// ---------------------------------------------------------------------------

async function openResultModal(bytes, method) {
  lastResultBytes = bytes;

  const originalSize = originalBytes.byteLength;
  const finalSize = bytes.byteLength;
  const percent = Math.round((1 - finalSize / originalSize) * 100);

  let subtitle;
  if (percent > 0) {
    subtitle = `${formatBytes(originalSize)} → ${formatBytes(finalSize)} (${percent}% smaller). `;
  } else {
    subtitle = `${formatBytes(originalSize)} → ${formatBytes(finalSize)}. This PDF was already compact, so compressing it further didn't help much. `;
  }
  subtitle += method === 'raster'
    ? 'Pages were converted to images to shrink the file — text is no longer selectable. Try "Less compression" for higher quality, or "Extreme compression" for a smaller file.'
    : 'The file\'s internal structure was optimized without changing any content — nothing was rasterized.';

  resultModalSubtitle.textContent = subtitle;
  resultModalSubtitle.classList.toggle('warning', percent <= 0);

  resultGrid.innerHTML = '';
  resultModal.hidden = false;

  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const cards = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const card = document.createElement('div');
    card.className = 'page-card preview-only';
    card.innerHTML = `<div class="page-thumb-wrap"><div class="spinner"></div></div><span class="page-index">${i}</span>`;
    resultGrid.appendChild(card);
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

function closeResultModal() {
  resultModal.hidden = true;
  resultGrid.innerHTML = '';
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
  originalBytes = null;
  pageCount = 0;
  pageThumbs = [];
  pagePreviewCache = [];
  selectedPreviewIndex = null;

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

function downloadBlob(bytes, filename, mime = 'application/pdf') {
  const blob = new Blob([bytes], { type: mime });
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
