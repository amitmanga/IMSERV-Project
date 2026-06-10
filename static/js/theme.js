/* EXL - Theme Manager */
(function () {
  const html = document.documentElement;
  const themeVersion = 'exl-json-theme-v1';
  if (localStorage.getItem('exl-theme-version') !== themeVersion) {
    localStorage.setItem('exl-theme', 'light');
    localStorage.setItem('exl-theme-version', themeVersion);
  }
  const stored = localStorage.getItem('exl-theme') || 'light';
  html.setAttribute('data-theme', stored);

  window.toggleTheme = function () {
    const current = html.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('exl-theme', next);
    window.EXL?.applyChartTheme?.(next);
    window.dispatchEvent(new CustomEvent('exl:themechange', { detail: { theme: next } }));

    const icon = document.getElementById('theme-icon');
    if (icon && window.EXL?.setElementIcon) {
      delete icon.dataset.iconReady;
      EXL.setElementIcon(icon, next === 'dark' ? 'moon' : 'sun');
    } else if (icon) {
      icon.textContent = next === 'dark' ? 'Dark' : 'Light';
    }
  };
})();
