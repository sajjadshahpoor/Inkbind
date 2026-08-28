// Site menu (hamburger, top-left of the topbar) - included on every page so
// "About" and the desktop-app link are reachable no matter which tool you're
// using.
(function () {
  const btn = document.getElementById('siteMenuBtn');
  const menu = document.getElementById('siteMenuDropdown');
  if (!btn || !menu) return;

  function openMenu() {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  });

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) closeMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) closeMenu();
  });

  // ---------- About Inkbind ----------
  const aboutBtn = document.getElementById('menuAboutBtn');
  const aboutModal = document.getElementById('aboutModal');
  const aboutCloseBtn = document.getElementById('aboutModalCloseBtn');
  const aboutOkBtn = document.getElementById('aboutModalOkBtn');

  if (aboutBtn && aboutModal) {
    function openAboutModal() {
      closeMenu();
      aboutModal.hidden = false;
    }

    function closeAboutModal() {
      aboutModal.hidden = true;
    }

    aboutBtn.addEventListener('click', openAboutModal);
    if (aboutCloseBtn) aboutCloseBtn.addEventListener('click', closeAboutModal);
    if (aboutOkBtn) aboutOkBtn.addEventListener('click', closeAboutModal);
    aboutModal.addEventListener('click', (e) => {
      if (e.target === aboutModal) closeAboutModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !aboutModal.hidden) closeAboutModal();
    });
  }
})();
