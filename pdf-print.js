// Shared by edit.html (standalone) and shell.html (the tab shell): renders
// every page of a PDF's bytes into #printContainer and calls window.print().
//
// This must run in whichever document is actually the TOP-LEVEL frame -
// WebView2 prints the top frame regardless of which nested frame calls
// window.print(), so a tab (an <iframe> inside shell.html, per shell.js)
// can't just print itself directly; it hands the bytes to shell.js via
// postMessage (see the 'inkbind-print' listener there and printDocument()
// in edit.js), which runs this in its own, top-level document instead.
//
// Requires pdf.js (lib/pdf.min.js) to already be loaded by the including page.
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

async function inkbindPrintPdfBytes(bytes) {
  const printDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;

  let printContainer = document.getElementById('printContainer');
  if (!printContainer) {
    printContainer = document.createElement('div');
    printContainer.id = 'printContainer';
    document.body.appendChild(printContainer);
  }
  printContainer.innerHTML = '';

  const PRINT_DPI = 150;
  // Comfortably inside both Letter (8.5x11in) and A4 (8.27x11.69in) after a
  // 0.4in margin on every side - a PDF page prints at its true physical size
  // (like Acrobat's default "Actual Size"), only shrinking (never enlarging)
  // pages too big to fit either paper size. Without this, a page sized for
  // one paper standard but printed on the other (e.g. this document's A4
  // pages on a printer set to Letter) scales to fill the width and ends up
  // too *tall* for the page, spilling onto a second, near-blank sheet.
  const SAFE_WIDTH_IN = 7.5;
  const SAFE_HEIGHT_IN = 10;

  for (let i = 1; i <= printDoc.numPages; i++) {
    const page = await printDoc.getPage(i);
    const baseViewport = page.getViewport({ scale: 1 });
    const pageWidthIn = baseViewport.width / 72;
    const pageHeightIn = baseViewport.height / 72;
    const fitScale = Math.min(1, SAFE_WIDTH_IN / pageWidthIn, SAFE_HEIGHT_IN / pageHeightIn);

    const viewport = page.getViewport({ scale: (PRINT_DPI / 72) * fitScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    // A data-URL <img> rather than the canvas itself: a canvas whose parent chain
    // is display:none (true here, outside @media print) can come out blank when
    // Chromium builds the print snapshot, since it was never actually painted in a
    // visible layout pass. Assigning a data URL still needs decoding, so this
    // explicitly awaits the img's load event before moving on - printing before
    // that finishes is what left pages blank.
    const img = document.createElement('img');
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = canvas.toDataURL('image/jpeg', 0.95);
    });
    // Explicit physical size rather than width:100% - see above.
    img.style.width = `${(pageWidthIn * fitScale).toFixed(3)}in`;
    img.style.height = `${(pageHeightIn * fitScale).toFixed(3)}in`;

    const pageEl = document.createElement('div');
    pageEl.className = 'print-page';
    pageEl.appendChild(img);
    printContainer.appendChild(pageEl);
  }

  // window.print() doesn't block on Chromium/WebView2 - it returns as soon as the
  // print preview opens, not when it closes. So printContainer is left populated
  // (it's display:none outside @media print, so it's invisible either way) rather
  // than raced against an afterprint event; the next print request clears it.
  window.print();
}
