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

const imageResultModal = document.getElementById('imageResultModal');
const imageResultList = document.getElementById('imageResultList');
const imageModalSubtitle = document.getElementById('imageModalSubtitle');
const imageModalCloseBtn = document.getElementById('imageModalCloseBtn');
const imageModalBackBtn = document.getElementById('imageModalBackBtn');
const imageModalDownloadBtn = document.getElementById('imageModalDownloadBtn');

const MODE_HELP = {
  excel: 'Text is grouped into rows and columns using its position on each page — good for simple tables, but complex layouts or scanned pages won’t extract cleanly.',
  jpg: 'Every page is rendered as its own JPG image.',
  ppt: 'Every page becomes one slide, sized to match the page and rendered as an image.',
  text: 'All text is extracted in reading order into a single .txt file. Scanned pages with no text layer will come out empty.',
  word: 'Choose editable text (fully editable, but layout, tables and images are lost) or page images (looks exactly right, but isn’t editable).',
};

const ACTION_LABEL = {
  excel: 'Convert to Excel',
  jpg: 'Convert to JPG',
  ppt: 'Convert to PowerPoint',
  text: 'Convert to Text',
  word: 'Convert to Word',
};

let activeMode = 'excel';

let sourceFile = null;
let pdfDoc = null; // pdfjs document
let pageCount = 0;
let pageThumbs = [];
let pagePreviewCache = [];
let selectedPreviewIndex = null;
let previewToken = 0;
const pageLinesCache = new Map();

// PDF to JPG
let jpgScale = 2; // 1 = standard, 2 = high, 4 = print

// PDF to Text
let textIncludeMarkers = true;

// PDF to Word
let wordMode = 'text'; // 'text' | 'image'

let lastImageResults = [];

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

imageModalCloseBtn.addEventListener('click', closeImageModal);
imageModalBackBtn.addEventListener('click', closeImageModal);
imageResultModal.addEventListener('click', (e) => {
  if (e.target === imageResultModal) closeImageModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !imageResultModal.hidden) closeImageModal();
});

imageModalDownloadBtn.addEventListener('click', async () => {
  if (lastImageResults.length === 0) return;
  imageModalDownloadBtn.disabled = true;
  imageModalDownloadBtn.textContent = 'Zipping…';
  try {
    const zip = new JSZip();
    for (const img of lastImageResults) zip.file(img.name, img.bytes);
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadFileBlob(blob, `${baseNameOf(sourceFile.name)}_images.zip`);
    setStatus(`Downloaded ${lastImageResults.length} images as a zip.`);
    closeImageModal();
  } catch (err) {
    console.error(err);
    setStatus(`Failed to build zip: ${err.message}`, true);
  } finally {
    imageModalDownloadBtn.disabled = false;
    imageModalDownloadBtn.textContent = 'Download all (.zip)';
  }
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
    setStatus('Convert works on one PDF at a time — using the first file you selected.');
  } else {
    setStatus('');
  }
  await loadFile(pdfFiles[0]);
}

async function loadFile(file) {
  let doc;
  try {
    const bytes = await file.arrayBuffer();
    doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (err) {
    console.error(err);
    setStatus(`Failed to open ${file.name}: it may be encrypted or corrupted.`, true);
    return;
  }

  resetAll();

  sourceFile = file;
  pdfDoc = doc;
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
// Mode switching
// ---------------------------------------------------------------------------

function setActiveMode(mode) {
  activeMode = mode;
  modeTabs.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  modeHelpEl.textContent = MODE_HELP[mode];
  actionBtn.textContent = ACTION_LABEL[mode];
  clearPreview();
  renderModeOptions();
  updateActionAvailability();
}

function renderModeOptions() {
  modeOptionsEl.innerHTML = '';

  if (activeMode === 'jpg') renderJpgOptions();
  else if (activeMode === 'text') renderTextOptions();
  else if (activeMode === 'word') renderWordOptions();

  modeOptionsEl.hidden = !pdfDoc || modeOptionsEl.children.length === 0;
}

function updateActionAvailability() {
  clearBtn.disabled = !pdfDoc;
  actionBtn.disabled = !pdfDoc || pageCount === 0;
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
// Mode-specific option panels
// ---------------------------------------------------------------------------

function renderJpgOptions() {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <label>Image quality</label>
    <button type="button" class="btn-chip" data-scale="1">Standard</button>
    <button type="button" class="btn-chip" data-scale="2">High</button>
    <button type="button" class="btn-chip" data-scale="4">Print</button>
  `;
  row.querySelectorAll('.btn-chip').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.scale) === jpgScale);
    btn.addEventListener('click', () => {
      jpgScale = Number(btn.dataset.scale);
      renderModeOptions();
    });
  });
  modeOptionsEl.appendChild(row);
}

function renderTextOptions() {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <label class="checkbox-row"><input type="checkbox" id="markersInput" ${textIncludeMarkers ? 'checked' : ''}> Add a "--- Page N ---" marker between pages</label>
  `;
  row.querySelector('#markersInput').addEventListener('change', (e) => {
    textIncludeMarkers = e.target.checked;
  });
  modeOptionsEl.appendChild(row);
}

function renderWordOptions() {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <button type="button" class="btn-chip" data-mode="text">Editable text</button>
    <button type="button" class="btn-chip" data-mode="image">Preserve appearance</button>
  `;
  row.querySelectorAll('.btn-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === wordMode);
    btn.addEventListener('click', () => {
      wordMode = btn.dataset.mode;
      renderModeOptions();
    });
  });
  modeOptionsEl.appendChild(row);
}

// ---------------------------------------------------------------------------
// Shared page-content helpers
// ---------------------------------------------------------------------------

async function renderPageCanvas(index, scale) {
  const page = await pdfDoc.getPage(index + 1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}

async function getPageLines(index) {
  if (pageLinesCache.has(index)) return pageLinesCache.get(index);
  const page = await pdfDoc.getPage(index + 1);
  const content = await page.getTextContent();
  const lines = [];
  let current = '';
  for (const item of content.items) {
    current += item.str;
    if (item.hasEOL) {
      lines.push(current);
      current = '';
    }
  }
  if (current.trim() !== '') lines.push(current);
  pageLinesCache.set(index, lines);
  return lines;
}

async function getPageRows(index) {
  const page = await pdfDoc.getPage(index + 1);
  const content = await page.getTextContent();
  const items = content.items.filter(it => it.str.trim() !== '');

  const rows = [];
  const Y_TOLERANCE = 3;
  for (const it of items) {
    const y = it.transform[5];
    const x = it.transform[4];
    let row = rows.find(r => Math.abs(r.y - y) <= Y_TOLERANCE);
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push({ x, str: it.str, width: it.width || 0 });
  }
  rows.sort((a, b) => b.y - a.y);

  const COLUMN_GAP = 8;
  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x);
    const cells = [];
    let current = '';
    let lastEndX = null;
    for (const it of row.items) {
      if (lastEndX !== null && it.x - lastEndX > COLUMN_GAP) {
        cells.push(current.trim());
        current = '';
      }
      current += (current ? ' ' : '') + it.str;
      lastEndX = it.x + it.width;
    }
    if (current) cells.push(current.trim());
    return cells;
  });
}

// ---------------------------------------------------------------------------
// Run dispatcher
// ---------------------------------------------------------------------------

async function runAction() {
  actionBtn.disabled = true;
  clearBtn.disabled = true;

  try {
    if (activeMode === 'jpg') await runJpgConversion();
    else if (activeMode === 'text') await runTextConversion();
    else if (activeMode === 'word') await runWordConversion();
    else if (activeMode === 'excel') await runExcelConversion();
    else if (activeMode === 'ppt') await runPptConversion();
  } catch (err) {
    console.error(err);
    setStatus(`Failed to convert: ${err.message}`, true);
  } finally {
    updateActionAvailability();
    clearBtn.disabled = !pdfDoc;
  }
}

async function runJpgConversion() {
  setStatus('Rendering pages...');
  const base = baseNameOf(sourceFile.name);
  const images = [];
  for (let i = 0; i < pageCount; i++) {
    const canvas = await renderPageCanvas(i, jpgScale);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    images.push({
      name: pageCount === 1 ? `${base}.jpg` : `${base}_page${i + 1}.jpg`,
      bytes: dataUrlToUint8Array(dataUrl),
      dataUrl,
    });
  }

  if (images.length === 1) {
    downloadBlob(images[0].bytes, images[0].name, 'image/jpeg');
    setStatus(`Downloaded ${images[0].name}.`);
  } else {
    setStatus('');
    openImageResultModal(images);
  }
}

async function runTextConversion() {
  setStatus('Extracting text...');
  const base = baseNameOf(sourceFile.name);
  const parts = [];
  for (let i = 0; i < pageCount; i++) {
    const lines = await getPageLines(i);
    const pageText = lines.join('\n');
    parts.push(textIncludeMarkers ? `--- Page ${i + 1} ---\n${pageText}` : pageText);
  }
  const bytes = new TextEncoder().encode(parts.join('\n\n'));
  downloadBlob(bytes, `${base}.txt`, 'text/plain');
  setStatus(`Downloaded ${base}.txt.`);
}

async function runWordConversion() {
  setStatus('Building Word document...');
  const base = baseNameOf(sourceFile.name);
  const { Document, Packer, Paragraph, ImageRun, PageBreak } = docx;
  const children = [];

  if (wordMode === 'text') {
    for (let i = 0; i < pageCount; i++) {
      const lines = await getPageLines(i);
      if (lines.length === 0) children.push(new Paragraph(''));
      for (const line of lines) children.push(new Paragraph(line));
      if (i < pageCount - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  } else {
    for (let i = 0; i < pageCount; i++) {
      const canvas = await renderPageCanvas(i, 2);
      const imgBytes = dataUrlToUint8Array(canvas.toDataURL('image/jpeg', 0.9));
      const targetW = 600;
      const targetH = Math.round(600 * (canvas.height / canvas.width));
      children.push(new Paragraph({
        children: [new ImageRun({ type: 'jpg', data: imgBytes, transformation: { width: targetW, height: targetH } })],
      }));
      if (i < pageCount - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  downloadFileBlob(blob, `${base}.docx`);
  setStatus(`Downloaded ${base}.docx.`);
}

async function runExcelConversion() {
  setStatus('Building spreadsheet...');
  const base = baseNameOf(sourceFile.name);
  const wb = XLSX.utils.book_new();

  for (let i = 0; i < pageCount; i++) {
    const rows = await getPageRows(i);
    const ws = XLSX.utils.aoa_to_sheet(rows.length > 0 ? rows : [['']]);
    XLSX.utils.book_append_sheet(wb, ws, `Page ${i + 1}`);
  }

  const wbArray = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  downloadBlob(new Uint8Array(wbArray), `${base}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  setStatus(`Downloaded ${base}.xlsx.`);
}

async function runPptConversion() {
  setStatus('Building presentation...');
  const base = baseNameOf(sourceFile.name);

  const firstPage = await pdfDoc.getPage(1);
  const baseViewport = firstPage.getViewport({ scale: 1 });
  const widthIn = Math.max(baseViewport.width / 72, 1);
  const heightIn = Math.max(baseViewport.height / 72, 1);

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'PDF_PAGE', width: widthIn, height: heightIn });
  pptx.layout = 'PDF_PAGE';

  for (let i = 0; i < pageCount; i++) {
    const canvas = await renderPageCanvas(i, 2);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const slide = pptx.addSlide();
    slide.addImage({ data: dataUrl, x: 0, y: 0, w: widthIn, h: heightIn });
  }

  const blob = await pptx.write({ outputType: 'blob' });
  downloadFileBlob(blob, `${base}.pptx`);
  setStatus(`Downloaded ${base}.pptx.`);
}

// ---------------------------------------------------------------------------
// Image (JPG) result modal
// ---------------------------------------------------------------------------

function openImageResultModal(images) {
  lastImageResults = images;
  imageResultList.innerHTML = '';
  imageModalSubtitle.textContent = `${images.length} images will be created.`;
  imageResultModal.hidden = false;

  for (const img of images) {
    const card = document.createElement('div');
    card.className = 'result-file-card';
    card.innerHTML = `
      <div class="result-file-thumb"><img src="${img.dataUrl}" alt="${img.name}"></div>
      <div class="result-file-info">
        <div class="result-file-name" title="${img.name}">${img.name}</div>
        <div class="result-file-meta">${formatBytes(img.bytes.byteLength)}</div>
        <button type="button" class="result-file-download">Download</button>
      </div>
    `;
    card.querySelector('.result-file-download').addEventListener('click', () => downloadBlob(img.bytes, img.name, 'image/jpeg'));
    imageResultList.appendChild(card);
  }
}

function closeImageModal() {
  imageResultModal.hidden = true;
  imageResultList.innerHTML = '';
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
  pageCount = 0;
  pageThumbs = [];
  pagePreviewCache = [];
  selectedPreviewIndex = null;
  pageLinesCache.clear();

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

function downloadBlob(bytes, filename, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });
  downloadFileBlob(blob, filename);
}

function downloadFileBlob(blob, filename) {
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

setActiveMode('excel');
