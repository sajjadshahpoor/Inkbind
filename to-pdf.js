const { PDFDocument, StandardFonts } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const THUMB_WIDTH = 220;
const RENDER_DPI = 150;
const MARGIN_IN = 0.4;

const PAGE_SIZES = {
  letter: { widthPt: 612, heightPt: 792 },
  a4: { widthPt: 595.28, heightPt: 841.89 },
};

const MODE_HELP = {
  html: 'Paste HTML or load a .html file. It’s rendered the way a browser would show it, then turned into PDF pages — layout, colors and images carry over, but links and scripts don’t.',
  jpg: 'Each image becomes one page, in the order below — drag to reorder.',
  word: 'Choose editable text (fully editable, but layout, tables and images are lost) or page images (looks right, but isn’t editable). Complex formatting like columns, headers/footers and precise fonts is approximated, not guaranteed.',
};

const modeTabs = document.querySelectorAll('.mode-tab');
const modeHelpEl = document.getElementById('modeHelp');
const modeOptionsEl = document.getElementById('modeOptions');
const panelHtml = document.getElementById('panelHtml');
const panelJpg = document.getElementById('panelJpg');
const panelWord = document.getElementById('panelWord');
const actionBtn = document.getElementById('actionBtn');
const clearBtn = document.getElementById('clearBtn');
const statusEl = document.getElementById('status');

const htmlFileInput = document.getElementById('htmlFileInput');
const htmlTextarea = document.getElementById('htmlTextarea');

const jpgDropzone = document.getElementById('jpgDropzone');
const jpgFileInput = document.getElementById('jpgFileInput');
const jpgFileListEl = document.getElementById('jpgFileList');

const wordDropzone = document.getElementById('wordDropzone');
const wordFileInput = document.getElementById('wordFileInput');
const wordFileInfoEl = document.getElementById('wordFileInfo');

const resultModal = document.getElementById('resultModal');
const resultGrid = document.getElementById('resultGrid');
const resultModalSubtitle = document.getElementById('resultModalSubtitle');
const resultModalCloseBtn = document.getElementById('resultModalCloseBtn');
const resultModalBackBtn = document.getElementById('resultModalBackBtn');
const resultModalDownloadBtn = document.getElementById('resultModalDownloadBtn');

let activeMode = 'html';
let dragSrcId = null;

// HTML to PDF
let htmlSourceBaseName = null;
let htmlPageSize = 'letter';

// JPG to PDF
let jpgImages = []; // { id, file, dataUrl, width, height }
let jpgFitMode = 'fit'; // 'fit' | 'letter' | 'a4'

// Word to PDF
let wordFile = null;
let wordMode = 'image'; // 'image' | 'text'
let wordPageSize = 'letter';

let lastResultBytes = null;
let lastResultFilename = 'converted.pdf';

modeTabs.forEach((btn) => {
  btn.addEventListener('click', () => setActiveMode(btn.dataset.mode));
});

clearBtn.addEventListener('click', clearActiveMode);
actionBtn.addEventListener('click', runAction);

htmlFileInput.addEventListener('change', async () => {
  const file = htmlFileInput.files[0];
  htmlFileInput.value = '';
  if (!file) return;
  htmlTextarea.value = await file.text();
  htmlSourceBaseName = baseNameOf(file.name);
  setStatus('');
  updateActionAvailability();
});

htmlTextarea.addEventListener('input', updateActionAvailability);

jpgDropzone.addEventListener('click', () => jpgFileInput.click());
jpgDropzone.addEventListener('dragover', (e) => { e.preventDefault(); jpgDropzone.classList.add('dragover'); });
jpgDropzone.addEventListener('dragleave', () => jpgDropzone.classList.remove('dragover'));
jpgDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  jpgDropzone.classList.remove('dragover');
  handleJpgFiles(e.dataTransfer.files);
});
jpgFileInput.addEventListener('change', () => {
  handleJpgFiles(jpgFileInput.files);
  jpgFileInput.value = '';
});

wordDropzone.addEventListener('click', () => wordFileInput.click());
wordDropzone.addEventListener('dragover', (e) => { e.preventDefault(); wordDropzone.classList.add('dragover'); });
wordDropzone.addEventListener('dragleave', () => wordDropzone.classList.remove('dragover'));
wordDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  wordDropzone.classList.remove('dragover');
  handleWordFile(e.dataTransfer.files);
});
wordFileInput.addEventListener('change', () => {
  handleWordFile(wordFileInput.files);
  wordFileInput.value = '';
});

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

// ---------------------------------------------------------------------------
// Mode switching
// ---------------------------------------------------------------------------

function setActiveMode(mode) {
  activeMode = mode;
  modeTabs.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  panelHtml.hidden = mode !== 'html';
  panelJpg.hidden = mode !== 'jpg';
  panelWord.hidden = mode !== 'word';
  modeHelpEl.textContent = MODE_HELP[mode];
  setStatus('');
  renderModeOptions();
  updateActionAvailability();
}

function renderModeOptions() {
  modeOptionsEl.innerHTML = '';

  if (activeMode === 'html') {
    appendPageSizeChip(htmlPageSize, (v) => { htmlPageSize = v; renderModeOptions(); });
  } else if (activeMode === 'jpg') {
    appendJpgFitOptions();
  } else if (activeMode === 'word') {
    appendWordModeOptions();
    appendPageSizeChip(wordPageSize, (v) => { wordPageSize = v; renderModeOptions(); });
  }

  modeOptionsEl.hidden = modeOptionsEl.children.length === 0;
}

function appendPageSizeChip(current, onChange) {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <label>Page size</label>
    <button type="button" class="btn-chip" data-size="letter">Letter</button>
    <button type="button" class="btn-chip" data-size="a4">A4</button>
  `;
  row.querySelectorAll('.btn-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.size === current);
    btn.addEventListener('click', () => onChange(btn.dataset.size));
  });
  modeOptionsEl.appendChild(row);
}

function appendJpgFitOptions() {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <label>Page size</label>
    <button type="button" class="btn-chip" data-fit="fit">Fit image</button>
    <button type="button" class="btn-chip" data-fit="letter">Letter</button>
    <button type="button" class="btn-chip" data-fit="a4">A4</button>
  `;
  row.querySelectorAll('.btn-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.fit === jpgFitMode);
    btn.addEventListener('click', () => { jpgFitMode = btn.dataset.fit; renderModeOptions(); });
  });
  modeOptionsEl.appendChild(row);
}

function appendWordModeOptions() {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML = `
    <button type="button" class="btn-chip" data-mode="image">Preserve appearance</button>
    <button type="button" class="btn-chip" data-mode="text">Editable text</button>
  `;
  row.querySelectorAll('.btn-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === wordMode);
    btn.addEventListener('click', () => { wordMode = btn.dataset.mode; renderModeOptions(); });
  });
  modeOptionsEl.appendChild(row);
}

function updateActionAvailability() {
  if (activeMode === 'html') {
    const hasContent = htmlTextarea.value.trim() !== '';
    actionBtn.disabled = !hasContent;
    clearBtn.disabled = !hasContent;
  } else if (activeMode === 'jpg') {
    actionBtn.disabled = jpgImages.length === 0;
    clearBtn.disabled = jpgImages.length === 0;
  } else if (activeMode === 'word') {
    actionBtn.disabled = !wordFile;
    clearBtn.disabled = !wordFile;
  }
}

function clearActiveMode() {
  if (activeMode === 'html') {
    htmlTextarea.value = '';
    htmlSourceBaseName = null;
  } else if (activeMode === 'jpg') {
    jpgImages = [];
    renderJpgFileList();
  } else if (activeMode === 'word') {
    wordFile = null;
    wordFileInfoEl.textContent = '';
  }
  setStatus('');
  updateActionAvailability();
}

// ---------------------------------------------------------------------------
// JPG to PDF
// ---------------------------------------------------------------------------

async function handleJpgFiles(fileListArg) {
  const validFiles = Array.from(fileListArg).filter(f => f.type === 'image/jpeg' || f.type === 'image/png' || /\.(jpe?g|png)$/i.test(f.name));
  if (validFiles.length === 0) {
    setStatus('Please select JPG or PNG images.', true);
    return;
  }
  setStatus('');
  for (const file of validFiles) {
    try {
      const dataUrl = await readImageFile(file);
      const dims = await getImageDimensions(dataUrl);
      jpgImages.push({ id: crypto.randomUUID(), file, dataUrl, width: dims.width, height: dims.height });
    } catch (err) {
      console.error(err);
      setStatus(`Failed to read ${file.name}.`, true);
    }
  }
  renderJpgFileList();
  updateActionAvailability();
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function removeJpgImage(id) {
  jpgImages = jpgImages.filter(im => im.id !== id);
  renderJpgFileList();
  updateActionAvailability();
}

function renderJpgFileList() {
  jpgFileListEl.innerHTML = '';
  jpgImages.forEach((entry, index) => {
    const card = document.createElement('div');
    card.className = 'page-card file-card';
    card.draggable = true;
    card.dataset.id = entry.id;
    card.innerHTML = `
      <div class="page-thumb-wrap">
        <div class="page-thumb-img-slot"><img src="${entry.dataUrl}" alt="${entry.file.name}"></div>
      </div>
      <span class="page-index">${index + 1}</span>
      <button class="page-remove" aria-label="Remove image">&times;</button>
      <div class="page-meta" title="${entry.file.name}">${entry.file.name} &middot; ${entry.width}&times;${entry.height}</div>
    `;
    card.querySelector('.page-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeJpgImage(entry.id);
    });
    attachJpgDragHandlers(card, entry.id);
    jpgFileListEl.appendChild(card);
  });
}

function attachJpgDragHandlers(card, id) {
  card.addEventListener('dragstart', () => {
    dragSrcId = id;
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    clearDropIndicators(jpgFileListEl);
  });
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragSrcId || dragSrcId === id) return;
    const rect = card.getBoundingClientRect();
    const after = e.clientX - rect.left > rect.width / 2;
    clearDropIndicators(jpgFileListEl);
    card.classList.add(after ? 'drop-after' : 'drop-before');
  });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    clearDropIndicators(jpgFileListEl);
    if (!dragSrcId || dragSrcId === id) return;
    const rect = card.getBoundingClientRect();
    const after = e.clientX - rect.left > rect.width / 2;
    const fromIndex = jpgImages.findIndex(im => im.id === dragSrcId);
    const [moved] = jpgImages.splice(fromIndex, 1);
    let toIndex = jpgImages.findIndex(im => im.id === id);
    jpgImages.splice(after ? toIndex + 1 : toIndex, 0, moved);
    dragSrcId = null;
    renderJpgFileList();
  });
}

function clearDropIndicators(container) {
  container.querySelectorAll('.drop-before, .drop-after').forEach(el => {
    el.classList.remove('drop-before', 'drop-after');
  });
}

async function buildPdfFromImages(imageEntries, fitMode) {
  const pdfDoc = await PDFDocument.create();
  for (const entry of imageEntries) {
    const bytes = dataUrlToUint8Array(entry.dataUrl);
    const isPng = entry.file.type === 'image/png' || /\.png$/i.test(entry.file.name);
    const img = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
    const imgWidthPt = entry.width * 72 / 96;
    const imgHeightPt = entry.height * 72 / 96;

    if (fitMode === 'fit') {
      const page = pdfDoc.addPage([imgWidthPt, imgHeightPt]);
      page.drawImage(img, { x: 0, y: 0, width: imgWidthPt, height: imgHeightPt });
    } else {
      const pageSize = PAGE_SIZES[fitMode];
      const page = pdfDoc.addPage([pageSize.widthPt, pageSize.heightPt]);
      const marginPt = 36;
      const maxW = pageSize.widthPt - marginPt * 2;
      const maxH = pageSize.heightPt - marginPt * 2;
      const scale = Math.min(maxW / imgWidthPt, maxH / imgHeightPt);
      const w = imgWidthPt * scale;
      const h = imgHeightPt * scale;
      page.drawImage(img, { x: (pageSize.widthPt - w) / 2, y: (pageSize.heightPt - h) / 2, width: w, height: h });
    }
  }
  return pdfDoc.save();
}

// ---------------------------------------------------------------------------
// Word to PDF
// ---------------------------------------------------------------------------

async function handleWordFile(fileListArg) {
  const files = Array.from(fileListArg).filter(f => f.name.toLowerCase().endsWith('.docx'));
  if (files.length === 0) {
    setStatus('Please select a .docx file.', true);
    return;
  }
  wordFile = files[0];
  wordFileInfoEl.textContent = `Selected: ${wordFile.name}`;
  setStatus('');
  updateActionAvailability();
}

async function buildTextPdf(rawText, pageSize) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 11;
  const lineHeight = fontSize * 1.4;
  const marginPt = 54;
  const maxWidth = pageSize.widthPt - marginPt * 2;
  const maxY = pageSize.heightPt - marginPt;
  const minY = marginPt;

  let page = pdfDoc.addPage([pageSize.widthPt, pageSize.heightPt]);
  let y = maxY;

  const newPage = () => {
    page = pdfDoc.addPage([pageSize.widthPt, pageSize.heightPt]);
    y = maxY;
  };

  const paragraphs = sanitizeForStandardFont(rawText).split(/\n{2,}/);
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      y -= lineHeight * 0.5;
      continue;
    }
    let line = '';
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(trial, fontSize) > maxWidth) {
        if (y - lineHeight < minY) newPage();
        page.drawText(line, { x: marginPt, y, size: fontSize, font });
        y -= lineHeight;
        line = word;
      } else {
        line = trial;
      }
    }
    if (line) {
      if (y - lineHeight < minY) newPage();
      page.drawText(line, { x: marginPt, y, size: fontSize, font });
      y -= lineHeight;
    }
    y -= lineHeight * 0.5;
    if (y < minY) newPage();
  }

  return pdfDoc.save();
}

function sanitizeForStandardFont(str) {
  return str
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–/g, '-')
    .replace(/—/g, '--')
    .replace(/…/g, '...')
    .replace(/•/g, '*')
    .replace(/[^\x00-\xFF]/g, '?');
}

// ---------------------------------------------------------------------------
// HTML rendering pipeline (shared by HTML to PDF and Word "preserve appearance")
// ---------------------------------------------------------------------------

async function renderHtmlToPageImages(htmlContent, pageSizeKey) {
  const pageSize = PAGE_SIZES[pageSizeKey];
  const pageWidthIn = pageSize.widthPt / 72;
  const pageHeightIn = pageSize.heightPt / 72;
  const contentWidthPx = Math.round((pageWidthIn - MARGIN_IN * 2) * RENDER_DPI);
  const contentHeightPx = Math.round((pageHeightIn - MARGIN_IN * 2) * RENDER_DPI);

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.style.cssText = `position:fixed; left:-99999px; top:0; width:${contentWidthPx}px; height:0; border:none;`;
  document.body.appendChild(iframe);

  try {
    await new Promise((resolve) => {
      iframe.addEventListener('load', resolve, { once: true });
      iframe.srcdoc = wrapHtmlDocument(htmlContent, contentWidthPx);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const body = iframe.contentDocument.body;
    // The iframe starts at height:0, which makes html2canvas treat its capture
    // viewport as 0px tall and clip everything. Resize it to the real content
    // height first so the full document lays out and gets captured.
    const fullContentHeightPx = Math.max(body.scrollHeight, iframe.contentDocument.documentElement.scrollHeight, 1);
    iframe.style.height = `${fullContentHeightPx}px`;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const fullCanvas = await html2canvas(body, {
      width: contentWidthPx,
      height: fullContentHeightPx,
      windowWidth: contentWidthPx,
      windowHeight: fullContentHeightPx,
      scale: 1,
      useCORS: true,
      backgroundColor: '#ffffff',
    });

    const totalHeightPx = Math.max(fullCanvas.height, 1);
    const pages = [];
    let y = 0;
    while (y < totalHeightPx) {
      const sliceHeight = Math.min(contentHeightPx, totalHeightPx - y);
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = contentWidthPx;
      pageCanvas.height = sliceHeight;
      const ctx = pageCanvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, contentWidthPx, sliceHeight);
      ctx.drawImage(fullCanvas, 0, y, contentWidthPx, sliceHeight, 0, 0, contentWidthPx, sliceHeight);
      pages.push({ dataUrl: pageCanvas.toDataURL('image/jpeg', 0.92), widthPx: contentWidthPx, heightPx: sliceHeight });
      y += sliceHeight;
    }
    if (pages.length === 0) pages.push({ dataUrl: null, widthPx: contentWidthPx, heightPx: 10 });

    return { pages, pageSize };
  } finally {
    document.body.removeChild(iframe);
  }
}

function wrapHtmlDocument(innerHtml, widthPx) {
  if (/<html[\s>]/i.test(innerHtml)) return innerHtml;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { width: ${widthPx}px; font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.5; color: #111; background: #fff; }
    img { max-width: 100%; }
    table { border-collapse: collapse; }
  </style></head><body>${innerHtml}</body></html>`;
}

async function buildPdfFromPageImages(pages, pageSize) {
  const pdfDoc = await PDFDocument.create();
  const marginPt = MARGIN_IN * 72;
  for (const p of pages) {
    const page = pdfDoc.addPage([pageSize.widthPt, pageSize.heightPt]);
    if (p.dataUrl) {
      const imgBytes = dataUrlToUint8Array(p.dataUrl);
      const img = await pdfDoc.embedJpg(imgBytes);
      const widthPt = (p.widthPx / RENDER_DPI) * 72;
      const heightPt = (p.heightPx / RENDER_DPI) * 72;
      page.drawImage(img, { x: marginPt, y: pageSize.heightPt - marginPt - heightPt, width: widthPt, height: heightPt });
    }
  }
  return pdfDoc.save();
}

// ---------------------------------------------------------------------------
// Run dispatcher
// ---------------------------------------------------------------------------

async function runAction() {
  actionBtn.disabled = true;
  clearBtn.disabled = true;

  try {
    if (activeMode === 'html') await runHtmlConversion();
    else if (activeMode === 'jpg') await runJpgConversion();
    else if (activeMode === 'word') await runWordConversion();
  } catch (err) {
    console.error(err);
    setStatus(`Failed to convert: ${err.message}`, true);
  } finally {
    updateActionAvailability();
  }
}

async function runHtmlConversion() {
  const html = htmlTextarea.value;
  if (!html.trim()) return;
  setStatus('Rendering HTML...');
  const { pages, pageSize } = await renderHtmlToPageImages(html, htmlPageSize);
  setStatus('Building PDF...');
  const bytes = await buildPdfFromPageImages(pages, pageSize);
  setStatus('');
  await openResultModal(bytes, `${htmlSourceBaseName || 'webpage'}.pdf`);
}

async function runJpgConversion() {
  setStatus('Building PDF...');
  const bytes = await buildPdfFromImages(jpgImages, jpgFitMode);
  setStatus('');
  await openResultModal(bytes, 'images.pdf');
}

async function runWordConversion() {
  const arrayBuffer = await wordFile.arrayBuffer();
  const pageSize = PAGE_SIZES[wordPageSize];
  let bytes;

  if (wordMode === 'image') {
    setStatus('Converting document...');
    const result = await mammoth.convertToHtml({ arrayBuffer });
    setStatus('Rendering pages...');
    const { pages } = await renderHtmlToPageImages(result.value, wordPageSize);
    setStatus('Building PDF...');
    bytes = await buildPdfFromPageImages(pages, pageSize);
  } else {
    setStatus('Extracting text...');
    const result = await mammoth.extractRawText({ arrayBuffer });
    setStatus('Building PDF...');
    bytes = await buildTextPdf(result.value, pageSize);
  }

  setStatus('');
  await openResultModal(bytes, `${baseNameOf(wordFile.name)}.pdf`);
}

// ---------------------------------------------------------------------------
// Result modal
// ---------------------------------------------------------------------------

async function openResultModal(bytes, filename) {
  lastResultBytes = bytes;
  lastResultFilename = filename;
  resultGrid.innerHTML = '';
  resultModal.hidden = false;
  resultModalSubtitle.textContent = 'Check every page before downloading. Go back if something looks wrong.';

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
// Utilities
// ---------------------------------------------------------------------------

function baseNameOf(filename) {
  return filename.replace(/\.(html?|docx)$/i, '');
}

function dataUrlToUint8Array(dataUrl) {
  const binary = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function downloadBlob(bytes, filename, mime = 'application/octet-stream') {
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

setActiveMode('html');
