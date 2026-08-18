const { PDFDocument, degrees } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const THUMB_WIDTH = 220;
const PREVIEW_WIDTH = 1400; // rendered higher than the display size so the magnifier stays crisp
const MAGNIFIER_ZOOM = 3;
const MAGNIFIER_SIZE = 170;

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const pageGridEl = document.getElementById('pageGrid');
const mergeBtn = document.getElementById('mergeBtn');
const clearBtn = document.getElementById('clearBtn');
const statusEl = document.getElementById('status');
const previewEmpty = document.getElementById('previewEmpty');
const previewContent = document.getElementById('previewContent');
const previewSpinner = document.getElementById('previewSpinner');
const previewImg = document.getElementById('previewImg');
const previewMeta = document.getElementById('previewMeta');
const magnifierGlass = document.getElementById('magnifierGlass');
const mergePreviewModal = document.getElementById('mergePreviewModal');
const mergePreviewGrid = document.getElementById('mergePreviewGrid');
const modalSubtitle = document.getElementById('modalSubtitle');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalBackBtn = document.getElementById('modalBackBtn');
const modalDownloadBtn = document.getElementById('modalDownloadBtn');

let pages = []; // { id, file, pageIndex (0-based in source file), name, thumbUrl, previewUrl }
let dragSrcId = null;
let selectedId = null;
let previewToken = 0;
let lastMergedBytes = null;
const pdfjsDocCache = new Map(); // File -> pdfjs PDFDocumentProxy

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
  addFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});

clearBtn.addEventListener('click', () => {
  pages = [];
  pdfjsDocCache.clear();
  selectedId = null;
  clearPreview();
  render();
});

mergeBtn.addEventListener('click', mergeFiles);

modalCloseBtn.addEventListener('click', closeMergePreview);
modalBackBtn.addEventListener('click', closeMergePreview);
mergePreviewModal.addEventListener('click', (e) => {
  if (e.target === mergePreviewModal) closeMergePreview();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !mergePreviewModal.hidden) closeMergePreview();
});

modalDownloadBtn.addEventListener('click', () => {
  if (lastMergedBytes) {
    downloadBlob(lastMergedBytes, 'merged.pdf');
    setStatus(`Downloaded. Merged ${pages.length} page${pages.length === 1 ? '' : 's'}.`);
  }
  closeMergePreview();
});

previewImg.addEventListener('mouseenter', () => {
  if (!previewImg.src || previewImg.hidden) return;
  magnifierGlass.style.backgroundImage = `url('${previewImg.src}')`;
  magnifierGlass.style.backgroundSize = `${previewImg.width * MAGNIFIER_ZOOM}px ${previewImg.height * MAGNIFIER_ZOOM}px`;
  magnifierGlass.hidden = false;
});

previewImg.addEventListener('mousemove', moveMagnifier);

previewImg.addEventListener('mouseleave', () => {
  magnifierGlass.hidden = true;
});

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

async function addFiles(fileListArg) {
  const pdfFiles = Array.from(fileListArg).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (pdfFiles.length === 0) {
    setStatus('Please select PDF files only.', true);
    return;
  }
  setStatus('');
  for (const file of pdfFiles) {
    await addFilePages(file);
  }
  if (selectedId === null && pages.length > 0) {
    selectPage(pages[0].id);
  }
}

async function addFilePages(file) {
  let pdfDoc;
  try {
    const arrayBuffer = await file.arrayBuffer();
    pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  } catch (err) {
    console.error(err);
    setStatus(`Failed to open ${file.name}: it may be encrypted or corrupted.`, true);
    return;
  }

  pdfjsDocCache.set(file, pdfDoc);

  const entries = [];
  for (let i = 0; i < pdfDoc.numPages; i++) {
    entries.push({ id: crypto.randomUUID(), file, pageIndex: i, name: file.name, thumbUrl: null, previewUrl: null, rotation: 0 });
  }
  pages.push(...entries);
  render();

  for (const entry of entries) {
    await renderThumbForEntry(entry);
  }
}

// entry.rotation (0/90/180/270) is the EXTRA rotation the user asked for on top of
// whatever the page's own /Rotate metadata already applies — total = page.rotate + entry.rotation.
function totalRotationFor(page, entry) {
  return (page.rotate + entry.rotation + 360) % 360;
}

async function renderThumbForEntry(entry) {
  try {
    const pdfDoc = pdfjsDocCache.get(entry.file);
    const page = await pdfDoc.getPage(entry.pageIndex + 1);
    const rotation = totalRotationFor(page, entry);
    const viewport = page.getViewport({ scale: 1, rotation });
    const scaledViewport = page.getViewport({ scale: THUMB_WIDTH / viewport.width, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledViewport }).promise;
    entry.thumbUrl = canvas.toDataURL('image/jpeg', 0.85);
    updateThumb(entry);
  } catch (err) {
    console.error(err);
  }
}

function rotatePage(id, delta) {
  const entry = pages.find(p => p.id === id);
  if (!entry) return;
  entry.rotation = ((entry.rotation + delta) % 360 + 360) % 360;
  entry.thumbUrl = null;
  entry.previewUrl = null;
  renderThumbForEntry(entry);
  if (selectedId === id) showPreview(entry);
}

function removePage(id) {
  pages = pages.filter(p => p.id !== id);
  if (selectedId === id) {
    selectedId = null;
    clearPreview();
    if (pages.length > 0) selectPage(pages[0].id);
  }
  render();
}

function render() {
  pageGridEl.innerHTML = '';

  pages.forEach((entry, index) => {
    const card = document.createElement('div');
    card.className = 'page-card' + (entry.id === selectedId ? ' selected' : '');
    card.draggable = true;
    card.dataset.id = entry.id;

    card.innerHTML = `
      <div class="page-thumb-wrap">
        <div class="page-thumb-img-slot">${entry.thumbUrl ? `<img src="${entry.thumbUrl}" alt="Page ${index + 1}">` : '<div class="spinner"></div>'}</div>
        <div class="page-rotate-controls">
          <button class="page-rotate-btn" data-dir="left" aria-label="Rotate left 90°" title="Rotate left 90°">&#10226;</button>
          <button class="page-rotate-btn" data-dir="right" aria-label="Rotate right 90°" title="Rotate right 90°">&#10227;</button>
        </div>
      </div>
      <span class="page-index">${index + 1}</span>
      <button class="page-remove" aria-label="Remove page">&times;</button>
      <div class="page-meta" title="${entry.name} — page ${entry.pageIndex + 1}">${entry.name} · p.${entry.pageIndex + 1}</div>
    `;

    card.querySelector('.page-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removePage(entry.id);
    });

    card.querySelector('.page-rotate-btn[data-dir="left"]').addEventListener('click', (e) => {
      e.stopPropagation();
      rotatePage(entry.id, -90);
    });

    card.querySelector('.page-rotate-btn[data-dir="right"]').addEventListener('click', (e) => {
      e.stopPropagation();
      rotatePage(entry.id, 90);
    });

    card.addEventListener('click', () => selectPage(entry.id));

    attachDragHandlers(card, entry);
    pageGridEl.appendChild(card);
  });

  const hasPages = pages.length > 0;
  clearBtn.disabled = !hasPages;
  mergeBtn.disabled = !hasPages;
}

function updateThumb(entry) {
  const card = pageGridEl.querySelector(`[data-id="${entry.id}"]`);
  if (!card) return;
  const slot = card.querySelector('.page-thumb-img-slot');
  if (slot) slot.innerHTML = `<img src="${entry.thumbUrl}" alt="thumbnail">`;
}

function attachDragHandlers(card, entry) {
  card.addEventListener('dragstart', () => {
    dragSrcId = entry.id;
    card.classList.add('dragging');
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    clearDropIndicators();
  });

  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragSrcId || dragSrcId === entry.id) return;
    const rect = card.getBoundingClientRect();
    const after = e.clientX - rect.left > rect.width / 2;
    clearDropIndicators();
    card.classList.add(after ? 'drop-after' : 'drop-before');
  });

  card.addEventListener('drop', (e) => {
    e.preventDefault();
    clearDropIndicators();
    if (!dragSrcId || dragSrcId === entry.id) return;

    const rect = card.getBoundingClientRect();
    const after = e.clientX - rect.left > rect.width / 2;

    const fromIndex = pages.findIndex(p => p.id === dragSrcId);
    const [moved] = pages.splice(fromIndex, 1);
    let toIndex = pages.findIndex(p => p.id === entry.id);
    pages.splice(after ? toIndex + 1 : toIndex, 0, moved);

    dragSrcId = null;
    render();
  });
}

function clearDropIndicators() {
  pageGridEl.querySelectorAll('.drop-before, .drop-after').forEach(el => {
    el.classList.remove('drop-before', 'drop-after');
  });
}

function selectPage(id) {
  selectedId = id;
  pageGridEl.querySelectorAll('.page-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.id === id);
  });

  const entry = pages.find(p => p.id === id);
  if (entry) showPreview(entry);
}

async function showPreview(entry) {
  const token = ++previewToken;

  previewEmpty.hidden = true;
  previewContent.hidden = false;
  previewMeta.textContent = `${entry.name} — page ${entry.pageIndex + 1}`;
  magnifierGlass.hidden = true;

  if (entry.previewUrl) {
    previewImg.src = entry.previewUrl;
    previewSpinner.hidden = true;
    previewImg.hidden = false;
    return;
  }

  previewImg.hidden = true;
  previewSpinner.hidden = false;

  try {
    const pdfDoc = pdfjsDocCache.get(entry.file);
    const page = await pdfDoc.getPage(entry.pageIndex + 1);
    const rotation = totalRotationFor(page, entry);
    const viewport = page.getViewport({ scale: 1, rotation });
    const scaledViewport = page.getViewport({ scale: PREVIEW_WIDTH / viewport.width, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledViewport }).promise;

    if (token !== previewToken) return; // a newer selection superseded this one

    entry.previewUrl = canvas.toDataURL('image/jpeg', 0.9);
    previewImg.src = entry.previewUrl;
    previewSpinner.hidden = true;
    previewImg.hidden = false;
  } catch (err) {
    console.error(err);
    if (token !== previewToken) return;
    previewSpinner.hidden = true;
    previewMeta.textContent = `Failed to preview ${entry.name}, page ${entry.pageIndex + 1}.`;
  }
}

function clearPreview() {
  previewToken++;
  previewContent.hidden = true;
  previewEmpty.hidden = false;
  previewImg.src = '';
  magnifierGlass.hidden = true;
}

async function mergeFiles() {
  mergeBtn.disabled = true;
  clearBtn.disabled = true;
  setStatus('Preparing preview...');

  try {
    const mergedPdf = await PDFDocument.create();
    const docCache = new Map(); // File -> pdf-lib PDFDocument
    const rasterizedFiles = new Set(); // files that needed the image fallback

    for (const entry of pages) {
      let srcDoc = docCache.get(entry.file);
      if (!srcDoc) {
        const bytes = await entry.file.arrayBuffer();
        srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
        docCache.set(entry.file, srcDoc);
      }

      // pdf-lib cannot decrypt page content streams — copying pages from an
      // encrypted source silently produces blank pages. Rasterize those pages
      // via pdf.js instead, since pdf.js decrypts and renders them correctly.
      if (srcDoc.isEncrypted) {
        rasterizedFiles.add(entry.name);
        await addRasterPage(mergedPdf, entry);
        continue;
      }

      try {
        const [copiedPage] = await mergedPdf.copyPages(srcDoc, [entry.pageIndex]);
        mergedPdf.addPage(copiedPage);
        if (entry.rotation) {
          const current = copiedPage.getRotation().angle;
          copiedPage.setRotation(degrees((current + entry.rotation + 360) % 360));
        }
      } catch (copyErr) {
        console.error('copyPages failed, falling back to a rendered image:', copyErr);
        rasterizedFiles.add(entry.name);
        await addRasterPage(mergedPdf, entry);
      }
    }

    lastMergedBytes = await mergedPdf.save();

    if (rasterizedFiles.size > 0) {
      modalSubtitle.textContent = `${[...rasterizedFiles].join(', ')} ${rasterizedFiles.size === 1 ? 'is' : 'are'} password-protected, so ${rasterizedFiles.size === 1 ? 'its' : 'their'} pages were rendered as images to make sure the content still shows up. Everything else was merged normally.`;
      modalSubtitle.classList.add('warning');
    } else {
      modalSubtitle.textContent = 'Check every page before downloading. Go back if something looks wrong.';
      modalSubtitle.classList.remove('warning');
    }

    setStatus('');
    await openMergePreview(lastMergedBytes);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to merge: ${err.message}`, true);
  } finally {
    clearBtn.disabled = pages.length === 0;
    mergeBtn.disabled = pages.length === 0;
  }
}

async function addRasterPage(mergedPdf, entry) {
  const pdfjsDoc = pdfjsDocCache.get(entry.file);
  const page = await pdfjsDoc.getPage(entry.pageIndex + 1);
  // There's no /Rotate entry to set on a rasterized page, so the rotation is baked
  // directly into the rendered pixels via the viewport instead.
  const rotation = totalRotationFor(page, entry);
  const renderViewport = page.getViewport({ scale: 2, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = renderViewport.width;
  canvas.height = renderViewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderViewport }).promise;

  const imgBytes = dataUrlToUint8Array(canvas.toDataURL('image/jpeg', 0.92));
  const embeddedImg = await mergedPdf.embedJpg(imgBytes);

  const pageViewport = page.getViewport({ scale: 1, rotation });
  const newPage = mergedPdf.addPage([pageViewport.width, pageViewport.height]);
  newPage.drawImage(embeddedImg, { x: 0, y: 0, width: pageViewport.width, height: pageViewport.height });
}

function dataUrlToUint8Array(dataUrl) {
  const binary = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function openMergePreview(mergedBytes) {
  mergePreviewGrid.innerHTML = '';
  mergePreviewModal.hidden = false;

  const pdfDoc = await pdfjsLib.getDocument({ data: mergedBytes.slice() }).promise;

  const cards = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const card = document.createElement('div');
    card.className = 'page-card preview-only';
    card.innerHTML = `
      <div class="page-thumb-wrap"><div class="spinner"></div></div>
      <span class="page-index">${i}</span>
    `;
    mergePreviewGrid.appendChild(card);
    cards.push(card);
  }

  await Promise.all(cards.map((card, i) => renderMergePreviewPage(pdfDoc, i + 1, card)));
}

async function renderMergePreviewPage(pdfDoc, pageNum, card) {
  try {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const scaledViewport = page.getViewport({ scale: THUMB_WIDTH / viewport.width });
    const canvas = document.createElement('canvas');
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledViewport }).promise;
    card.querySelector('.page-thumb-wrap').innerHTML = `<img src="${canvas.toDataURL('image/jpeg', 0.85)}" alt="Merged page ${pageNum}">`;
  } catch (err) {
    console.error(err);
    card.querySelector('.page-thumb-wrap').innerHTML = '<span style="font-size:11px;color:var(--danger);padding:8px;text-align:center;">Preview failed</span>';
  }
}

function closeMergePreview() {
  mergePreviewModal.hidden = true;
  mergePreviewGrid.innerHTML = '';
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
