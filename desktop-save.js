// Shared by every tool page: "Save" actually saves a file in the desktop
// build via a native Save As dialog, instead of a browser-style
// <a download> blob link - a bare WebView2 control doesn't reliably fire a
// real save for one of those the way an actual browser does, so it used to
// silently do nothing at all when clicked. Falls back to the blob-link
// approach when window.pywebview isn't available (the plain hosted web
// version, where real browsers handle <a download> correctly).
//
// Each tab in the desktop build is its own iframe (see shell.js), and
// pywebview's bridge may only land on the top-level document, so this
// checks both this window and its parent before falling back.
function findPywebviewApi() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.save_file_bytes) return window.pywebview.api;
  try {
    if (window.parent && window.parent !== window && window.parent.pywebview && window.parent.pywebview.api && window.parent.pywebview.api.save_file_bytes) {
      return window.parent.pywebview.api;
    }
  } catch (err) {
    // Cross-origin parent (shouldn't happen here - same origin always) or no parent.
  }
  return null;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Returns { ok, path } on a real save, { ok: false, canceled: true } if the
// user dismissed the Save As dialog, or { ok: true } once a blob download
// has been handed to the browser (fire-and-forget - browsers don't report
// whether the user actually completed it).
async function inkbindSaveFile(bytes, filename, mime) {
  const api = findPywebviewApi();
  if (api) {
    try {
      const result = await api.save_file_bytes(bytesToBase64(bytes), filename);
      if (result && (result.ok || result.canceled)) return result;
      console.warn('Native save failed, falling back to browser download:', result && result.error);
    } catch (err) {
      console.warn('Native save failed, falling back to browser download:', err);
    }
  }

  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { ok: true };
}
