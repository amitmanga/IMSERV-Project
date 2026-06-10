/* EXL — Client-side configuration and shared utilities */
const EXL = {
  version: '1.0.0',
  charts: {},   // registered Chart.js instances
  apiCache: new Map(),
  apiCacheTtlMs: 60_000,

  // Brand colours — mirror CSS variables for Chart.js
  colors: {
    primary:   '#FB4E0B',
    accent:    '#004EFF',
    bright:    '#A100FF',
    orange:    '#FB4E0B',
    ok:        '#005071',
    warn:      '#FB4E0B',
    crit:      '#D93025',
    cancel:    '#D93025',
    abort:     '#A100FF',
    info:      '#004EFF',
    muted:     '#808080',
    text:      '#000000',
  },

  chartDefaults: {
    color: '#000000',
    font: { family: 'Inter, sans-serif', size: 11 },
    plugins: {
      legend: { labels: { color: '#2E2E2E', font: { size: 11 } } },
      tooltip: {
        backgroundColor: '#000000',
        borderColor: 'rgba(251,78,11,0.45)',
        borderWidth: 1,
        titleColor: '#FFFFFF',
        bodyColor: '#E6E6E6',
        padding: 10,
      },
    },
    scales: {
      x: {
        grid:  { color: 'rgba(132,136,136,0.22)' },
        ticks: { color: '#808080', font: { size: 10 } },
      },
      y: {
        grid:  { color: 'rgba(132,136,136,0.22)' },
        ticks: { color: '#808080', font: { size: 10 } },
      },
    },
  },

  themeChartPalettes: {
    light: {
      primary: '#FB4E0B',
      accent: '#004EFF',
      bright: '#A100FF',
      ok: '#005071',
      warn: '#FB4E0B',
      crit: '#D93025',
      cancel: '#D93025',
      abort: '#A100FF',
      info: '#004EFF',
      text: '#000000',
      muted: '#808080',
      secondary: '#2E2E2E',
      grid: 'rgba(132,136,136,0.22)',
      tooltipBg: '#000000',
      tooltipText: '#FFFFFF',
      tooltipBody: '#E6E6E6',
    },
    dark: {
      primary: '#FB4E0B',
      accent: '#6E8DFF',
      bright: '#C06CFF',
      ok: '#7CBCC8',
      warn: '#FB4E0B',
      crit: '#FF6B5C',
      cancel: '#FF6B5C',
      abort: '#C06CFF',
      info: '#6E8DFF',
      text: '#FFFFFF',
      muted: '#ABABAB',
      secondary: '#DCDCDC',
      grid: 'rgba(220,220,220,0.14)',
      tooltipBg: '#101010',
      tooltipText: '#FFFFFF',
      tooltipBody: '#DCDCDC',
    },
  },

  getTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  },

  applyChartTheme(theme = this.getTheme()) {
    const palette = this.themeChartPalettes[theme] || this.themeChartPalettes.light;
    this.colors.primary = palette.primary;
    this.colors.accent = palette.accent;
    this.colors.bright = palette.bright;
    this.colors.orange = palette.primary;
    this.colors.ok = palette.ok;
    this.colors.warn = palette.warn;
    this.colors.crit = palette.crit;
    this.colors.cancel = palette.cancel;
    this.colors.abort = palette.abort;
    this.colors.info = palette.info;
    this.colors.text = palette.text;
    this.colors.muted = palette.muted;

    this.chartDefaults.color = palette.text;
    this.chartDefaults.plugins.legend.labels.color = palette.secondary;
    this.chartDefaults.plugins.tooltip.backgroundColor = palette.tooltipBg;
    this.chartDefaults.plugins.tooltip.titleColor = palette.tooltipText;
    this.chartDefaults.plugins.tooltip.bodyColor = palette.tooltipBody;
    this.chartDefaults.scales.x.grid.color = palette.grid;
    this.chartDefaults.scales.x.ticks.color = palette.muted;
    this.chartDefaults.scales.y.grid.color = palette.grid;
    this.chartDefaults.scales.y.ticks.color = palette.muted;

    if (window.Chart) {
      Chart.defaults.color = palette.text;
      Chart.defaults.plugins.legend.labels.color = palette.secondary;
    }

    Object.values(this.charts).forEach(chart => this.rethemeChart(chart, palette));
  },

  rethemeChart(chart, palette) {
    if (!chart?.options) return;
    const options = chart.options;
    options.color = palette.text;

    if (options.plugins?.legend?.labels) {
      options.plugins.legend.labels.color = palette.secondary;
    }
    if (options.plugins?.tooltip) {
      options.plugins.tooltip.backgroundColor = palette.tooltipBg;
      options.plugins.tooltip.titleColor = palette.tooltipText;
      options.plugins.tooltip.bodyColor = palette.tooltipBody;
    }

    Object.values(options.scales || {}).forEach(scale => {
      if (scale.grid) scale.grid.color = palette.grid;
      if (scale.ticks) scale.ticks.color = palette.muted;
      if (scale.title?.display) scale.title.color = palette.muted;
    });

    (chart.data?.datasets || []).forEach(dataset => {
      if (!dataset.exlColor) return;
      const color = palette[dataset.exlColor];
      if (!color) return;
      dataset.backgroundColor = this.colorWithAlpha(color, dataset.exlAlpha ?? 0.72);
      dataset.borderColor = this.colorWithAlpha(color, dataset.exlBorderAlpha ?? 1);
    });

    chart.update('none');
  },

  colorWithAlpha(hex, alpha = 1) {
    const clean = String(hex || '').replace('#', '');
    if (clean.length !== 6) return hex;
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  },

  // Format helpers
  fmt: {
    num:  (v) => v == null ? '—' : Number(v).toLocaleString('en-GB'),
    pct:  (v) => v == null ? '—' : Number(v).toFixed(1) + '%',
    gbp:  (v) => v == null ? '—' : '£' + Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 }),
    gbpK: (v) => v == null ? '—' : '£' + (Number(v) / 1000).toFixed(0) + 'k',
    gbpM: (v) => v == null ? '—' : '£' + (Number(v) / 1_000_000).toFixed(2) + 'M',
  },

  getRegion:   () => document.getElementById('global-region')?.value || '',
  getMonth:    () => document.getElementById('global-month')?.value || '',
  getGlobalQs(extra = {}) {
    const p = new URLSearchParams();
    const year = this.getYear();
    if (year)                p.set('year',     year);
    const region = this.getRegion();
    if (region)              p.set('region',   region);
    const month = this.getMonth();
    if (month)               p.set('month',    month);
    Object.entries(extra).forEach(([k, v]) => { if (v !== '' && v != null) p.set(k, v); });
    const s = p.toString();
    return s ? '?' + s : '';
  },
  getYear:   () => {
    const activeView = document.querySelector('.view.active')?.id || 'view-journey';
    return ['view-forecasting', 'view-field-ops', 'view-financial'].includes(activeView) ? 2026 : 2025;
  },

  registerChart(key, instance) {
    if (this.charts[key]) { this.charts[key].destroy(); }
    this.charts[key] = instance;
    this.rethemeChart(instance, this.themeChartPalettes[this.getTheme()]);
  },

  destroyChart(key) {
    if (this.charts[key]) {
      this.charts[key].destroy();
      delete this.charts[key];
    }
  },

  clearApiCache() {
    this.apiCache.clear();
  },

  setLoading(targets, isLoading, label = 'Loading...') {
    const list = Array.isArray(targets) ? targets : [targets];
    list.forEach(target => {
      let raw = target;
      if (typeof target === 'string') {
        raw = document.getElementById(target);
        if (!raw) {
          try { raw = document.querySelector(target); } catch { raw = null; }
        }
      }
      if (!raw) return;
      const el = raw.tagName === 'CANVAS' ? raw.closest('.chart-wrap') || raw.parentElement : raw;
      if (!el) return;

      if (isLoading) {
        if (el.querySelector(':scope > .visual-loading-overlay')) return;
        el.classList.add('visual-loading-host', 'is-loading');
        const overlay = document.createElement('div');
        overlay.className = 'visual-loading-overlay';
        overlay.innerHTML = `<div class="loading"><span class="spinner"></span>${label ? ` ${label}` : ''}</div>`;
        el.appendChild(overlay);
      } else {
        el.classList.remove('is-loading');
        el.querySelectorAll(':scope > .visual-loading-overlay').forEach(node => node.remove());
      }
    });
  },

  async apiFetch(url, options = {}) {
    const now = Date.now();
    const cached = this.apiCache.get(url);
    if (!options.force && cached && cached.expiresAt > now) {
      return cached.data ?? cached.promise;
    }

    try {
      const promise = fetch(url).then(async resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
      });
      this.apiCache.set(url, { promise, expiresAt: now + this.apiCacheTtlMs });
      const data = await promise;
      this.apiCache.set(url, { data, expiresAt: Date.now() + this.apiCacheTtlMs });
      return data;
    } catch (e) {
      console.error('API error:', url, e);
      this.apiCache.delete(url);
      return null;
    }
  },

  ragClass: (rag) => rag === 'Green' ? 'ok' : (rag === 'Amber' ? 'warn' : 'crit'),

  priorityIcon: () => '',
};

window.EXL = EXL;
EXL.applyChartTheme();

// Apply initial theme icon
(function () {
  const t = localStorage.getItem('exl-theme') || 'light';
  const icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = t === 'dark' ? 'Dark' : 'Light';
})();

Object.assign(EXL, {
  iconSvg(name) {
    const icons = {
      activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
      alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
      barChart: '<path d="M4 19V9"/><path d="M12 19V5"/><path d="M20 19v-7"/>',
      beaker: '<path d="M10 2v7.5L4.2 19a2 2 0 0 0 1.7 3h12.2a2 2 0 0 0 1.7-3L14 9.5V2"/><path d="M8 2h8"/><path d="M7.5 16h9"/>',
      bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4"/><path d="M8 13h.01"/><path d="M16 13h.01"/><path d="M9 17h6"/>',
      calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
      check: '<path d="M21 12a9 9 0 1 1-5.3-8.2"/><path d="m9 12 2 2 6-7"/>',
      clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M8 12h8"/><path d="M8 16h6"/>',
      columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M15 4v16"/>',
      download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
      factory: '<path d="M3 21h18"/><path d="M5 21V9l5 3V9l5 3h4v9"/><path d="M9 17h1"/><path d="M14 17h1"/><path d="M18 17h1"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
      map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15"/><path d="M15 6v15"/>',
      moon: '<path d="M21 14.5A8.5 8.5 0 0 1 9.5 3a7 7 0 1 0 11.5 11.5Z"/>',
      panelLeftClose: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m16 9-3 3 3 3"/>',
      panelLeftOpen: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m13 9 3 3-3 3"/>',
      percent: '<path d="M19 5 5 19"/><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/>',
      phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1A19.5 19.5 0 0 1 5.2 13 19.8 19.8 0 0 1 2 4.3 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L7.8 9.7a16 16 0 0 0 6.5 6.5l1.3-1.3a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 1.9Z"/>',
      pound: '<path d="M18 7a4 4 0 0 0-8 0v10"/><path d="M6 12h8"/><path d="M6 21h12"/><path d="M10 17h7"/>',
      refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
      send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
      settings: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V22a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 18l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 8A2 2 0 1 1 7 5.2l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.6V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
      shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-5"/>',
      sparkles: '<path d="M12 3 10.3 8.3 5 10l5.3 1.7L12 17l1.7-5.3L19 10l-5.3-1.7Z"/><path d="M19 15l-.8 2.2L16 18l2.2.8L19 21l.8-2.2L22 18l-2.2-.8Z"/><path d="M5 3l-.6 1.6L3 5l1.4.4L5 7l.6-1.6L7 5l-1.4-.4Z"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>',
      target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
      trendingDown: '<path d="m22 17-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>',
      trendingUp: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
      trophy: '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v4a5 5 0 0 1-10 0Z"/><path d="M7 6H4a2 2 0 0 0 2 4h1"/><path d="M17 6h3a2 2 0 0 1-2 4h-1"/>',
      user: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>',
      users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
      wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2"/><path d="M3 7h17a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4a3 3 0 0 1 0-6h4"/>',
      wrench: '<path d="M14.7 6.3a4 4 0 0 0-5 5L3 18v3h3l6.7-6.7a4 4 0 0 0 5-5l-2.9 2.9-2-2 2.9-2.9Z"/>',
      xCircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
      zap: '<path d="M13 2 3 14h8l-1 8 11-14h-8Z"/>',
    };
    const body = icons[name] || icons.activity;
    return `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
  },

  iconForLabel(label = '') {
    const t = label.toLowerCase();
    if (t.includes('dialler') || t.includes('customer data')) return 'user';
    if (t.includes('executed successfully')) return 'check';
    if (t.includes('appointment') && t.includes('cancel')) return 'alert';
    if (t.includes('appointment') && t.includes('abort')) return 'xCircle';
    if (t.includes('appointment')) return 'calendar';
    if (t.includes('request')) return 'clipboard';
    if (t.includes('contact') || t.includes('volume') || t.includes('phone')) return 'phone';
    if (t.includes('customer')) return 'user';
    if (t.includes('visit')) return 'map';
    if (t.includes('booking')) return 'calendar';
    if (t.includes('cancel')) return 'alert';
    if (t.includes('abort') || t.includes('abandon')) return 'xCircle';
    if (t.includes('completion') || t.includes('completed') || t.includes('jobs completed')) return 'check';
    if (t.includes('conversion') || t.includes('margin by') || t.includes('funnel')) return 'target';
    if (t.includes('engineer')) return 'wrench';
    if (t.includes('utilisation') || t.includes('productivity') || t.includes('efficiency')) return 'activity';
    if (t.includes('absence')) return 'shield';
    if (t.includes('revenue') || t.includes('gross') || t.includes('profit')) return 'trendingUp';
    if (t.includes('supplier')) return 'factory';
    if (t.includes('breakdown') || t.includes('table')) return 'columns';
    if (t.includes('short term')) return 'zap';
    if (t.includes('long term')) return 'trendingUp';
    if (t.includes('peak month')) return 'trendingUp';
    if (t.includes('gap')) return 'alert';
    if (t.includes('capacity status')) return 'zap';
    if (t.includes('total capacity')) return 'users';
    if (t.includes('annual demand') || t.includes('demand')) return 'barChart';
    if (t.includes('pound') || t.includes('gbp')) return 'pound';
    if (t.includes('cost')) return 'wallet';
    if (t.includes('margin %') || t.includes('rate') || t.includes('%')) return 'percent';
    if (t.includes('heatmap') || t.includes('regional') || t.includes('patch')) return 'map';
    if (t.includes('ai') || t.includes('recommendation') || t.includes('prediction')) return 'bot';
    if (t.includes('scenario') || t.includes('config') || t.includes('builder')) return 'settings';
    if (t.includes('accuracy') || t.includes('model')) return 'beaker';
    if (t.includes('trend') || t.includes('forecast')) return 'trendingUp';
    if (t.includes('category')) return 'folder';
    if (t.includes('rebooking')) return 'refresh';
    if (t.includes('performance') || t.includes('top')) return 'trophy';
    return 'barChart';
  },

  setElementIcon(el, name) {
    if (!el) return;
    el.innerHTML = this.iconSvg(name);
    el.classList.add('modern-icon');
    el.dataset.iconReady = 'true';
  },

  hydrateIcons(root = document) {
    root.querySelectorAll('.kpi-icon:not([data-icon-ready])').forEach(el => {
      const card = el.closest('.kpi-card');
      const label = card?.querySelector('.kpi-label')?.textContent || '';
      card?.classList.add('has-modern-icon');
      if (label.toLowerCase().includes('cancel')) card?.classList.add('cancel');
      if (label.toLowerCase().includes('abort')) card?.classList.add('abort');
      this.setElementIcon(el, this.iconForLabel(label));
    });

    root.querySelectorAll('.lt-kpi-icon:not([data-icon-ready]), .pst-icon:not([data-icon-ready]), .mv-panel-icon:not([data-icon-ready])').forEach(el => {
      const icon = el.dataset.icon;
      const label = el.closest('.lt-kpi')?.querySelector('.lt-kpi-label')?.textContent
        || el.closest('.pst-btn')?.textContent
        || el.closest('.mv-panel-header')?.querySelector('.mv-panel-title')?.textContent
        || el.textContent;
      this.setElementIcon(el, icon || this.iconForLabel(label));
    });

    root.querySelectorAll('.nav-icon:not([data-icon-ready])').forEach(el => {
      const view = el.closest('.nav-item')?.dataset.view;
      const icon = el.id === 'theme-icon'
        ? ((document.documentElement.dataset.theme || 'light') === 'dark' ? 'moon' : 'sun')
        : ({ journey: 'barChart', forecasting: 'trendingUp', cancellations: 'xCircle', 'field-ops': 'wrench', financial: 'wallet' }[view] || 'settings');
      this.setElementIcon(el, icon);
    });

    root.querySelectorAll('.btn-icon:not([data-icon-ready])').forEach(el => {
      const title = (el.getAttribute('title') || '').toLowerCase();
      const icon = title.includes('refresh') ? 'refresh' : title.includes('export') ? 'download' : title.includes('ai') ? 'sparkles' : 'settings';
      this.setElementIcon(el, icon);
    });

    root.querySelectorAll('.ai-icon:not([data-icon-ready])').forEach(el => this.setElementIcon(el, 'bot'));
    root.querySelectorAll('.rec-icon:not([data-icon-ready])').forEach(el => {
      const priority = Array.from(el.closest('.rec-card')?.classList || []).find(c => ['Critical', 'High', 'Medium', 'Low'].includes(c));
      this.setElementIcon(el, ({ Critical: 'alert', High: 'zap', Medium: 'activity', Low: 'check' }[priority] || 'bot'));
    });
    root.querySelectorAll('.empty-icon:not([data-icon-ready])').forEach(el => this.setElementIcon(el, 'activity'));

    root.querySelectorAll('.card-title:not([data-icon-ready])').forEach(el => {
      const raw = el.textContent.trim();
      const clean = /^[^\x00-\x7F]/.test(raw) ? raw.replace(/^\S+\s+/, '') : raw;
      el.textContent = clean;
      const icon = document.createElement('span');
      icon.className = 'title-icon modern-icon';
      icon.dataset.iconReady = 'true';
      icon.innerHTML = this.iconSvg(this.iconForLabel(clean));
      el.prepend(icon);
      el.dataset.iconReady = 'true';
    });
  },

  priorityIcon() {
    return '';
  },
});

window.EXL = EXL;

document.addEventListener('DOMContentLoaded', () => {
  EXL.hydrateIcons();
  const observer = new MutationObserver(() => {
    window.requestAnimationFrame(() => EXL.hydrateIcons());
  });
  observer.observe(document.body, { childList: true, subtree: true });
});
