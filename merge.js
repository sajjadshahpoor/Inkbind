const { PDFDocument, degrees } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const THUMB_WIDTH = 220;
const PREVIEW_WIDTH = 1400; // rendered higher than the display size so the magnifier stays crisp
const MAGNIFIER_ZOOM = 3;
const MAGNIFIER_SIZE = 170;

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const modeTabs = document.querySelectorAll('.mode-tab');
const modeHelpEl = document.getElementById('modeHelp');
const panelMerge = document.getElementById('panelMerge');
const panelMix = document.getElementById('panelMix');
const panelOrganize = document.getElementById('panelOrganize');
const mergeFileListEl = document.getElementById('mergeFileList');
const mixFileListEl = document.getElementById('mixFileList');
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

const MODE_HELP = {
  merge: 'Files are combined whole, in the order below. Drag to reorder documents, then merge.',
  mix: 'Pages are interleaved one-by-one across files in the order below. Toggle "Reverse pages" on a file to flip its order before mixing — handy for double-sided scans.',
  organize: 'Every page from every file is listed below. Drag to reorder, rotate, or remove individual pages.',
};

let files = []; // { id, file, pageCount, name, thumbUrl, previewUrl, pageIndex: 0, rotation: 0 }
let mergeOrder = []; // array of file ids, in the order they'll be concatenated
let mixOrder = []; // array of file ids, in the order they'll be interleaved
let mixReversed = new Set(); // file ids whose pages should be taken back-to-front when mixing
let pages = []; // { id, file, pageIndex (0-based in source file), name, thumbUrl, previewUrl, rotation }

let activeMode = 'merge'; // 'merge' | 'mix' | 'organize'
let dragSrcFileId = null;
let dragSrcId = null;
let selectedMergeFileId = null;
let selectedMixFileId = null;
let selectedPageId = null;
let previewToken = 0;
let lastMergedBytes = null;
let lastMergedFilename = 'merged.pdf';
let lastMergedPageCount = 0;
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

modeTabs.forEach((btn) => {
  btn.addEventListener('click', () => setActiveMode(btn.dataset.mode));
});

clearBtn.addEventListener('click', () => {
  files = [];
  mergeOrder = [];
  mixOrder = [];
  mixReversed.clear();
  pages = [];
  pdfjsDocCache.clear();
  selectedMergeFileId = null;
  selectedMixFileId = null;
  selectedPageId = null;
  clearPreview();
  renderAll();
});

mergeBtn.addEventListener('click', runActiveModeMerge);

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
    downloadBlob(lastMergedBytes, lastMergedFilename);
    setStatus(`Downloaded. Merged ${lastMergedPageCount} page${lastMergedPageCount === 1 ? '' : 's'}.`);
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

function setActiveMode(mode) {
  activeMode = mode;
  modeTabs.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  panelMerge.hidden = mode !== 'merge';
  panelMix.hidden = mode !== 'mix';
  panelOrganize.hidden = mode !== 'organize';
  modeHelpEl.textContent = MODE_HELP[mode];
  clearPreview();
  updateActionAvailability();
}

async function addFiles(fileListArg) {
  const pdfFiles = Array.from(fileListArg).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (pdfFiles.length === 0) {
    setStatus('Please select PDF files only.', true);
    return;
  }
  setStatus('');
  for (const file of pdfFiles) {
    await addFile(file);
  }

  renderAll();

  if (files.length > 0) {
    if (activeMode === 'merge' && selectedMergeFileId === null) selectMergeFile(mergeOrder[0]);
    if (activeMode === 'mix' && selectedMixFileId === null) selectMixFile(mixOrder[0]);
  }
  if (activeMode === 'organize' && selectedPageId === null && pages.length > 0) selectPage(pages[0].id);
}

async function addFile(file) {
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

  const fileEntry = {
    id: crypto.randomUUID(),
    file,
    pageCount: pdfDoc.numPages,
    name: file.name,
    thumbUrl: null,
    previewUrl: null,
    pageIndex: 0,
    rotation: 0,
  };
  files.push(fileEntry);
  mergeOrder.push(fileEntry.id);
  mixOrder.push(fileEntry.id);
  renderThumbForFile(fileEntry);

  const pageEntries = [];
  for (let i = 0; i < pdfDoc.numPages; i++) {
    pageEntries.push({ id: crypto.randomUUID(), file, pageIndex: i, name: file.name, thumbUrl: null, previewUrl: null, rotation: 0 });
  }
  pages.push(...pageEntries);
  for (const entry of pageEntries) {
    await renderThumbForEntry(entry);
  }
}

// entry.rotation (0/90/180/270) is the EXTRA rotation the user asked for on top of
// whatever the page's own /Rotate metadata already applies — total = page.rotate + entry.rotation.
function totalRotationFor(page, entry) {
  return (page.rotate + entry.rotation + 360) % 360;
}

async function renderThumbForFile(fileEntry) {
  try {
    const pdfDoc = pdfjsDocCache.get(fileEntry.file);
    const page = await pdfDoc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const scaledViewport = page.getViewport({ scale: THUMB_WIDTH / viewport.width });
    const canvas = document.createElement('canvas');
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledViewport }).promise;
    fileEntry.thumbUrl = canvas.toDataURL('image/jpeg', 0.85);
    updateFileThumb(fileEntry);
  } catch (err) {
    console.error(err);
  }
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
  if (selectedPageId === id) showPreview(entry);
}

function removePage(id) {
  pages = pages.filter(p => p.id !== id);
  if (selectedPageId === id) {
    selectedPageId = null;
    clearPreview();
    if (pages.length > 0) selectPage(pages[0].id);
  }
  renderOrganizePanel();
  updateActionAvailability();
}

function removeFile(fileId) {
  const fileEntry = files.find(f => f.id === fileId);
  files = files.filter(f => f.id !== fileId);
  mergeOrder = mergeOrder.filter(id => id !== fileId);
  mixOrder = mixOrder.filter(id => id !== fileId);
  mixReversed.delete(fileId);

  if (fileEntry) {
    pages = pages.filter(p => p.file !== fileEntry.file);
    pdfjsDocCache.delete(fileEntry.file);
  }

  if (selectedMergeFileId === fileId) selectedMergeFileId = null;
  if (selectedMixFileId === fileId) selectedMixFileId = null;
  if (selectedPageId && !pages.find(p => p.id === selectedPageId)) selectedPageId = null;

  clearPreview();
  renderAll();
}

function renderAll() {
  renderMergePanel();
  renderMixPanel();
  renderOrganizePanel();
  updateActionAvailability();
}

function buildFileCard(entry, index, opts) {
  const card = document.createElement('div');
  card.className = 'page-card file-card' + (opts.selected ? ' selected' : '');
  card.draggable = true;
  card.dataset.id = entry.id;

  card.innerHTML = `
    <div class="page-thumb-wrap">
      <div class="page-thumb-img-slot">${entry.thumbUrl ? `<img src="${entry.thumbUrl}" alt="${entry.name}">` : '<div class="spinner"></div>'}</div>
    </div>
    <span class="page-index">${index + 1}</span>
    <button class="page-remove" aria-label="Remove file">&times;</button>
    <div class="page-meta" title="${entry.name}">${entry.name} &middot; ${entry.pageCount} page${entry.pageCount === 1 ? '' : 's'}</div>
    ${opts.showReverse ? `<label class="file-reverse-toggle"><input type="checkbox" ${opts.reversed ? 'checked' : ''}> Reverse pages</label>` : ''}
  `;

  return card;
}

function renderMergePanel() {
  mergeFileListEl.innerHTML = '';
  mergeOrder.forEach((id, index) => {
    const entry = files.find(f => f.id === id);
    if (!entry) return;

    const card = buildFileCard(entry, index, { showReverse: false, selected: entry.id === selectedMergeFileId });

    card.addEventListener('click', (e) => {
      if (e.target.closest('.page-remove')) return;
      selectMergeFile(entry.id);
    });

    card.querySelector('.page-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFile(entry.id);
    });

    attachFileDragHandlers(card, entry.id, () => mergeOrder, renderMergePanel, mergeFileListEl);
    mergeFileListEl.appendChild(card);
  });
}

function renderMixPanel() {
  mixFileListEl.innerHTML = '';
  mixOrder.forEach((id, index) => {
    const entry = files.find(f => f.id === id);
    if (!entry) return;

    const card = buildFileCard(entry, index, { showReverse: true, reversed: mixReversed.has(entry.id), selected: entry.id === selectedMixFileId });

    card.addEventListener('click', (e) => {
      if (e.target.closest('.page-remove') || e.target.closest('.file-reverse-toggle')) return;
      selectMixFile(entry.id);
    });

    card.querySelector('.page-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFile(entry.id);
    });

    const checkbox = card.querySelector('.file-reverse-toggle input');
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) mixReversed.add(entry.id); else mixReversed.delete(entry.id);
    });

    attachFileDragHandlers(card, entry.id, () => mixOrder, renderMixPanel, mixFileListEl);
    mixFileListEl.appendChild(card);
  });
}

function renderOrganizePanel() {
  pageGridEl.innerHTML = '';

  pages.forEach((entry, index) => {
    const card = document.createElement('div');
    card.className = 'page-card' + (entry.id === selectedPageId ? ' selected' : '');
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
}

function updateActionAvailability() {
  const hasFiles = files.length > 0;
  clearBtn.disabled = !hasFiles;

  if (activeMode === 'merge') {
    mergeBtn.textContent = 'Preview Merge';
    mergeBtn.disabled = mergeOrder.length === 0;
  } else if (activeMode === 'mix') {
    mergeBtn.textContent = 'Preview Mix';
    mergeBtn.disabled = mixOrder.length < 2;
  } else {
    mergeBtn.textContent = 'Preview Merge';
    mergeBtn.disabled = pages.length === 0;
  }
}

function updateFileThumb(entry) {
  document.querySelectorAll(`.file-card[data-id="${entry.id}"] .page-thumb-img-slot`).forEach((slot) => {
    slot.innerHTML = `<img src="${entry.thumbUrl}" alt="${entry.name}">`;
  });
}

function updateThumb(entry) {
  const card = pageGridEl.querySelector(`[data-id="${entry.id}"]`);
  if (!card) return;
  const slot = card.querySelector('.page-thumb-img-slot');
  if (slot) slot.innerHTML = `<img src="${entry.thumbUrl}" alt="thumbnail">`;
}

function attachFileDragHandlers(card, fileId, getOrder, rerender, containerEl) {
  card.addEventListener('dragstart', () => {
    dragSrcFileId = fileId;
    card.classList.add('dragging');
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    clearDropIndicators(containerEl);
  });

  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragSrcFileId || dragSrcFileId === fileId) return;
    const rect = card.getBoundingClientRect();
    const after = e.clientX - rect.left > rect.width / 2;
    clearDropIndicators(containerEl);
    card.classList.add(after ? 'drop-after' : 'drop-before');
  });

  card.addEventListener('drop', (e) => {
    e.preventDefault();
    clearDropIndicators(containerEl);
    if (!dragSrcFileId || dragSrcFileId === fileId) return;

    const order = getOrder();
    const rect = card.getBoundingClientRect();
    const after = e.clientX - rect.left > rect.width / 2;

    const fromIndex = order.indexOf(dragSrcFileId);
    order.splice(fromIndex, 1);
    let toIndex = order.indexOf(fileId);
    order.splice(after ? toIndex + 1 : toIndex, 0, dragSrcFileId);

    dragSrcFileId = null;
    rerender();
  });
}

function attachDragHandlers(card, entry) {
  card.addEventListener('dragstart', () => {
    dragSrcId = entry.id;
    card.classList.add('dragging');
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    clearDropIndicators(pageGridEl);
  });

  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragSrcId || dragSrcId === entry.id) return;
    const rect = card.getBoundingClientRect();
    const after = e.clientX - rect.left > rect.width / 2;
    clearDropIndicators(pageGridEl);
    card.classList.add(after ? 'drop-after' : 'drop-before');
  });

  card.addEventListener('drop', (e) => {
    e.preventDefault();
    clearDropIndicators(pageGridEl);
    if (!dragSrcId || dragSrcId === entry.id) return;

    const rect = card.getBoundingClientRect();
    const after = e.clientX - rect.left > rect.width / 2;

    const fromIndex = pages.findIndex(p => p.id === dragSrcId);
    const [moved] = pages.splice(fromIndex, 1);
    let toIndex = pages.findIndex(p => p.id === entry.id);
    pages.splice(after ? toIndex + 1 : toIndex, 0, moved);

    dragSrcId = null;
    renderOrganizePanel();
  });
}

function clearDropIndicators(container) {
  container.querySelectorAll('.drop-before, .drop-after').forEach(el => {
    el.classList.remove('drop-before', 'drop-after');
  });
}

function selectMergeFile(id) {
  selectedMergeFileId = id;
  mergeFileListEl.querySelectorAll('.page-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.id === id);
  });
  const entry = files.find(f => f.id === id);
  if (entry) showPreview(entry);
}

function selectMixFile(id) {
  selectedMixFileId = id;
  mixFileListEl.querySelectorAll('.page-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.id === id);
  });
  const entry = files.find(f => f.id === id);
  if (entry) showPreview(entry);
}

function selectPage(id) {
  selectedPageId = id;
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
  previewMeta.textContent = 'pageCount' in entry
    ? `${entry.name} — first page`
    : `${entry.name} — page ${entry.pageIndex + 1}`;
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

function getEntriesForActiveMode() {
  if (activeMode === 'merge') {
    return mergeOrder.flatMap((id) => {
      const f = files.find(x => x.id === id);
      if (!f) return [];
      return Array.from({ length: f.pageCount }, (_, i) => ({ file: f.file, pageIndex: i, rotation: 0, name: f.name }));
    });
  }
  if (activeMode === 'mix') {
    return buildMixEntries();
  }
  return pages;
}

function buildMixEntries() {
  const activeFiles = mixOrder.map(id => files.find(f => f.id === id)).filter(Boolean);
  if (activeFiles.length === 0) return [];

  const pointer = activeFiles.map(f => (mixReversed.has(f.id) ? f.pageCount - 1 : 0));
  const step = activeFiles.map(f => (mixReversed.has(f.id) ? -1 : 1));
  const remaining = activeFiles.map(f => f.pageCount);
  let totalRemaining = remaining.reduce((a, b) => a + b, 0);

  const result = [];
  while (totalRemaining > 0) {
    for (let i = 0; i < activeFiles.length; i++) {
      if (remaining[i] <= 0) continue;
      const f = activeFiles[i];
      result.push({ file: f.file, pageIndex: pointer[i], rotation: 0, name: f.name });
      pointer[i] += step[i];
      remaining[i]--;
      totalRemaining--;
    }
  }
  return result;
}

async function runActiveModeMerge() {
  const entries = getEntriesForActiveMode();
  if (entries.length === 0) return;

  mergeBtn.disabled = true;
  clearBtn.disabled = true;
  setStatus(activeMode === 'mix' ? 'Preparing mix...' : 'Preparing preview...');

  try {
    const { bytes, rasterizedFiles } = await buildMergedPdf(entries);
    lastMergedBytes = bytes;
    lastMergedPageCount = entries.length;
    lastMergedFilename = activeMode === 'mix' ? 'mixed.pdf' : 'merged.pdf';

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
    updateActionAvailability();
  }
}

async function buildMergedPdf(pageEntries) {
  const mergedPdf = await PDFDocument.create();
  const docCache = new Map(); // File -> pdf-lib PDFDocument
  const rasterizedFiles = new Set(); // files that needed the image fallback

  for (const entry of pageEntries) {
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

  const bytes = await mergedPdf.save();
  return { bytes, rasterizedFiles };
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

setActiveMode('merge');
