(function () {
  const CONSENT_KEY = 'inkbind.cookieConsent';

  function getConsent() {
    try { return localStorage.getItem(CONSENT_KEY); } catch { return null; }
  }

  function setConsent(value) {
    try { localStorage.setItem(CONSENT_KEY, value); } catch { /* ignore */ }
  }

  // Exposed so other scripts (e.g. the signature-saving feature) can honor a decline
  // without duplicating the localStorage read logic.
  window.inkbindHasStorageConsent = function () {
    return getConsent() !== 'declined';
  };

  function showBanner() {
    const banner = document.createElement('div');
    banner.className = 'cookie-banner';
    banner.innerHTML = `
      <p class="cookie-banner-text">
        Inkbind uses your browser's local storage for optional features, like saving a signature for reuse. Nothing is ever uploaded or shared.
        See our <a href="privacy.html">Privacy &amp; Cookie Policy</a>.
      </p>
      <div class="cookie-banner-actions">
        <button type="button" class="btn btn-secondary" data-choice="declined">Decline</button>
        <button type="button" class="btn btn-primary" data-choice="accepted">Accept</button>
      </div>
    `;
    document.body.appendChild(banner);

    banner.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-choice]');
      if (!btn) return;
      setConsent(btn.dataset.choice);
      banner.remove();
      if (typeof window.inkbindOnConsentChange === 'function') {
        window.inkbindOnConsentChange(btn.dataset.choice);
      }
    });
  }

  function init() {
    if (getConsent()) return; // already answered on a previous visit
    showBanner();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
