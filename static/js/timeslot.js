/* ── Time-Slot Analysis Dashboard ─────────────────────────── */

let _tsFilterType  = 'all';
let _tsFilterValue = '';
let _tsSupplier    = '';
let _tsAgentData   = null;
let _tsDashCache   = null;   // last fetched dashboard payload — used for theme-only re-renders
let _tsLoaded      = false;
let _tsWindow      = null;

const TS_SLOTS = ['Morning', 'Afternoon', 'Evening'];
const TS_DAYS  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

const TS_SLOT_COLORS = {
  Morning:   { bg: 'rgba(251,191,36,0.12)',  accent: '#f59e0b', text: '#d97706' },
  Afternoon: { bg: 'rgba(59,130,246,0.12)',  accent: '#3b82f6', text: '#2563eb' },
  Evening:   { bg: 'rgba(139,92,246,0.12)',  accent: '#8b5cf6', text: '#7c3aed' },
};
const TS_SLOT_ICONS = { Morning: '🌅', Afternoon: '☀️', Evening: '🌆' };

const TS_MONTHS = [
  ['1','January'],['2','February'],['3','March'],['4','April'],
  ['5','May'],['6','June'],['7','July'],['8','August'],
  ['9','September'],['10','October'],['11','November'],['12','December'],
];

const TS_RATE_COL = v => v >= 80 ? '#10b981' : v >= 60 ? '#f59e0b' : '#ef4444';

function tsIsDarkTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

// Returns [bgColor, textColor] — discrete 6-tier palette matching UK map tier colours
function heatColor(pct) {
  if (tsIsDarkTheme()) {
    const darkTiers = [
      { bg: 'rgba(248,113,113,0.50)', col: '#fff1f2' },
      { bg: 'rgba(252,165,165,0.46)', col: '#fff1f2' },
      { bg: 'rgba(245,158, 11,0.48)', col: '#fffbeb' },
      { bg: 'rgba(250,204, 21,0.46)', col: '#fffbeb' },
      { bg: 'rgba( 52,211,153,0.40)', col: '#ecfdf5' },
      { bg: 'rgba( 34,197, 94,0.46)', col: '#f0fdf4' },
    ];
    const idx = Math.min(5, Math.floor(pct * 6));
    return [darkTiers[idx].bg, darkTiers[idx].col];
  }

  const tiers = [
    { bg: 'rgba(183, 28,  28, 0.45)', col: '#7f0000' },  // tier6 — dark red   (worst)
    { bg: 'rgba(229,115, 115, 0.45)', col: '#7f0000' },  // tier5 — light red
    { bg: 'rgba(200,150,  12, 0.45)', col: '#7f4000' },  // tier4 — amber
    { bg: 'rgba(253,216,  53, 0.50)', col: '#6b5000' },  // tier3 — yellow
    { bg: 'rgba( 82,190, 128, 0.45)', col: '#0a3d1f' },  // tier2 — medium green
    { bg: 'rgba( 27, 94,  53, 0.45)', col: '#0a2e18' },  // tier1 — dark green  (best)
  ];
  const idx = Math.min(5, Math.floor(pct * 6));
  return [tiers[idx].bg, tiers[idx].col];
}

function tsFormatMonth(value) {
  const d = new Date(`${value}-01T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' }).format(d);
}

function tsLocalWindowFallback() {
  const today = new Date();
  const current = new Date(today.getFullYear(), today.getMonth(), 1);
  const start = new Date(current.getFullYear(), current.getMonth() - 12, 1);
  const end = new Date(current.getFullYear(), current.getMonth(), 0);
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const months = [];
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ value, label: tsFormatMonth(value) });
  }
  const weeks = [];
  const cursor = new Date(start);
  cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
  while (cursor <= end) {
    const value = iso(cursor);
    weeks.push({ value, label: `Week of ${new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(cursor)}` });
    cursor.setDate(cursor.getDate() + 7);
  }
  return {
    start: iso(start),
    end: iso(end),
    label: `${tsFormatMonth(months[0].value)} - ${tsFormatMonth(months[months.length - 1].value)}`,
    months,
    weeks,
    default_day: iso(start),
  };
}

function tsApplyWindowChrome() {
  const label = _tsWindow?.label || 'Rolling actuals';
  const allBtn = document.querySelector('.ts-period-btn[data-ftype="all"]');
  if (allBtn) allBtn.textContent = `All ${label}`;

  const dateInput = document.getElementById('ts-picker-date');
  if (dateInput && _tsWindow) {
    dateInput.min = _tsWindow.start;
    dateInput.max = _tsWindow.end;
    if (!dateInput.value) dateInput.value = _tsWindow.default_day || _tsWindow.start;
  }

  const active = document.getElementById('ts-active-label');
  if (active && _tsFilterType === 'all') active.textContent = `Showing: ${label}`;
}

async function tsEnsureWindow() {
  if (_tsWindow) return _tsWindow;
  try {
    _tsWindow = await EXL.apiFetch('/api/data/actual-window', { force: true });
  } catch (err) {
    console.warn('Timeslot actual window metadata unavailable', err);
  }
  if (!_tsWindow?.start) _tsWindow = tsLocalWindowFallback();
  tsApplyWindowChrome();
  return _tsWindow;
}

function tsQs() {
  const region = EXL.getRegion();
  let qs = `filter_type=${_tsFilterType}&filter_value=${encodeURIComponent(_tsFilterValue)}`;
  if (region)      qs += `&region=${region}`;
  if (_tsSupplier) qs += `&supplier=${encodeURIComponent(_tsSupplier)}`;
  return qs;
}

async function loadTimeslotDashboard(force = false) {
  if (_tsLoaded && !force) return;
  _tsLoaded = true;
  await tsEnsureWindow();

  tsSetLoading();
  try {
    const dashboard = await EXL.apiFetch('/api/timeslot/dashboard?' + tsQs(), { force });
    _tsDashCache = dashboard;   // cache for theme-only re-renders
    const chData   = dashboard?.channel_booking;
    const bizData  = dashboard?.business_type;
    const attData  = dashboard?.attempts_overview;
    const agData   = dashboard?.agent_view;
    const sumData  = dashboard?.summary;
    const supList  = dashboard?.suppliers;
    const doData   = dashboard?.dialler_outcome;
    if (supList)  tsPopulateSupplierSelect(supList);
    if (sumData)  renderTsSummaryKpis(sumData);
    if (doData)   renderDiallerOutcome(doData);
    if (chData)   renderTsChannelGrid(chData);
    if (bizData)  renderTsBizWrap(bizData);
    if (attData)  renderTsAttemptsGrid(attData);
    if (agData)   { _tsAgentData = agData; renderTsAgentGrid(agData); }
  } catch (e) {
    console.error('Timeslot load error', e);
  } finally {
    tsSetLoading(false);
  }
}

// On theme change — ONLY re-render the heatmap (the one section with theme-dependent
// inline background/color styles baked in). Everything else is pure CSS and updates
// automatically via [data-theme="dark"] selectors — no API call, no spinners.
window.addEventListener('exl:themechange', () => {
  if (_tsLoaded && _tsDashCache?.business_type) {
    renderTsBizWrap(_tsDashCache.business_type);
  }
});

function tsSetLoading(isLoading = true) {
  const targets = ['ts-summary-kpis', 'ts-outcome-grid','ts-channel-grid','ts-biz-wrap','ts-attempts-grid','ts-agent-grid'];
  if (window.EXL?.setLoading) EXL.setLoading(targets, isLoading);
  if (!isLoading) return;
  ['ts-outcome-grid','ts-channel-grid','ts-biz-wrap','ts-attempts-grid','ts-agent-grid'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
  });
}

/* ── Summary KPI Cards ─────────────────────────────────────────── */
function renderTsSummaryKpis(s) {
  const fmt = EXL.fmt.num;

  // Bookings card
  const bkEl = document.getElementById('ts-kpi-bookings');
  if (bkEl) bkEl.textContent = fmt(s.bookings ?? 0);
  const bkSub = document.getElementById('ts-kpi-bookings-sub');
  if (bkSub && s.attempts) {
    const bkRate = s.attempts > 0 ? Math.round((s.bookings / s.attempts) * 100) : '—';
    bkSub.textContent = bkRate + '% booking rate';
    bkSub.style.color = 'var(--info)';
  }

  // Completions card
  const cpEl = document.getElementById('ts-kpi-completions');
  if (cpEl) cpEl.textContent = fmt(s.completions ?? 0);
  const cpSub = document.getElementById('ts-kpi-completions-sub');
  if (cpSub && s.bookings) {
    const execRate = s.bookings > 0 ? Math.round((s.completions / s.bookings) * 100) : '—';
    cpSub.textContent = execRate + '% of booked';
    cpSub.style.color = 'var(--ok)';
  }

  // Success Rate card — colour by threshold
  const rateEl = document.getElementById('ts-kpi-rate');
  const rateCard = document.getElementById('ts-kpi-rate-card');
  const rateSub = document.getElementById('ts-kpi-rate-sub');
  const rate = s.success_rate ?? 0;
  if (rateEl) rateEl.textContent = Math.round(rate) + '%';
  if (rateCard) {
    rateCard.classList.remove('rate-ok','rate-warn','rate-crit','ok','warn','crit');
    if (rate >= 15) {
      rateCard.classList.add('rate-ok', 'ok');
    } else if (rate >= 10) {
      rateCard.classList.add('rate-warn', 'warn');
    } else {
      rateCard.classList.add('rate-crit', 'crit');
    }
  }
  if (rateSub) {
    rateSub.textContent = rate >= 15 ? '✓ On target' : rate >= 10 ? '⚠ Below target' : '✗ Critical';
    rateSub.style.color = rate >= 15 ? 'var(--ok)' : rate >= 10 ? 'var(--warn)' : 'var(--crit)';
  }
}

/* ── Supplier filter ──────────────────────────────────────── */

/**
 * Populate the supplier <select> from the API supplier list.
 * Only re-populates on the very first call (keeps the user's selection stable
 * across filter refreshes; only resets if the list itself changed).
 */
let _tsSupplierListPopulated = false;
function tsPopulateSupplierSelect(suppliers) {
  const sel = document.getElementById('ts-supplier-select');
  if (!sel || !Array.isArray(suppliers) || suppliers.length === 0) return;
  if (_tsSupplierListPopulated) return;   // Don't overwrite user's selection on reload
  _tsSupplierListPopulated = true;

  // Keep the 'All Suppliers' placeholder as first option
  sel.innerHTML = '<option value="">All Suppliers</option>';
  suppliers.forEach(({ name }) => {
    if (!name) return;
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === _tsSupplier) opt.selected = true;
    sel.appendChild(opt);
  });
}

/**
 * Called by the <select onchange> in index.html.
 * Stores the chosen supplier, marks dashboard stale, and reloads.
 */
window.tsSetSupplier = async function(name) {
  _tsSupplier = name || '';
  _tsLoaded   = false;

  // Keep the active-label in sync
  const lbl = document.getElementById('ts-active-label');
  if (lbl) {
    const base = _tsFilterType === 'all'
      ? (_tsWindow?.label || 'Rolling actuals')
      : _tsFilterValue;
    lbl.textContent = `Showing: ${base}${_tsSupplier ? ' • ' + _tsSupplier : ''}`;
  }

  loadTimeslotDashboard(true);
};

/* ── Filter controls ──────────────────────────────────────── */

window.tsSetFilter = async function(ftype, fval) {
  await tsEnsureWindow();
  _tsFilterType  = ftype;
  _tsFilterValue = fval;
  _tsLoaded = false;

  document.querySelectorAll('.ts-period-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.ftype === ftype);
  });
  const wrap = document.getElementById('ts-picker-wrap');
  if (wrap) wrap.style.display = 'none';
  const sel = document.getElementById('ts-picker-select');
  const dateInput = document.getElementById('ts-picker-date');
  if (sel) sel.style.display = '';
  if (dateInput) dateInput.style.display = 'none';

  const lbl = document.getElementById('ts-active-label');
  if (lbl) lbl.textContent = `Showing: ${_tsWindow?.label || 'Rolling actuals'}`;

  loadTimeslotDashboard(true);
};

window.tsOpenPicker = async function(ftype) {
  await tsEnsureWindow();
  _tsFilterType = ftype;
  document.querySelectorAll('.ts-period-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.ftype === ftype);
  });

  const wrap   = document.getElementById('ts-picker-wrap');
  const sel    = document.getElementById('ts-picker-select');
  const dateInput = document.getElementById('ts-picker-date');
  if (!wrap || !sel || !dateInput) return;

  sel.innerHTML = '';
  sel.style.display = ftype === 'day' ? 'none' : '';
  dateInput.style.display = ftype === 'day' ? '' : 'none';

  if (ftype === 'month') {
    (_tsWindow?.months || []).forEach(({ value, label }) => {
      const o = document.createElement('option');
      o.value = value; o.textContent = label; sel.appendChild(o);
    });
  } else if (ftype === 'week') {
    (_tsWindow?.weeks || []).forEach(({ value, label }) => {
      const o = document.createElement('option');
      o.value = value; o.textContent = label; sel.appendChild(o);
    });
  } else if (ftype === 'day') {
    const current = /^\d{4}-\d{2}-\d{2}$/.test(_tsFilterValue)
      ? _tsFilterValue
      : (_tsWindow?.default_day || _tsWindow?.start || '');
    dateInput.value = current;
  }
  wrap.style.display = '';
  tsApplyPicker();
};

window.tsApplyPicker = function() {
  const sel = document.getElementById('ts-picker-select');
  const dateInput = document.getElementById('ts-picker-date');
  if (!sel || !dateInput) return;
  _tsFilterValue = _tsFilterType === 'day' ? dateInput.value : sel.value;
  _tsLoaded = false;

  const lbl = document.getElementById('ts-active-label');
  if (lbl) {
    const txt = _tsFilterType === 'month'
      ? (_tsWindow?.months || []).find(m => m.value === _tsFilterValue)?.label || tsFormatMonth(_tsFilterValue)
      : _tsFilterType === 'week'
        ? (_tsWindow?.weeks || []).find(w => w.value === _tsFilterValue)?.label || `Week of ${_tsFilterValue}`
        : _tsFilterValue;
    lbl.textContent = `Showing: ${txt}`;
  }
  loadTimeslotDashboard(true);
};


/* ── 1. Channel Booking Grid ───────────────────────────────── */

function renderTsChannelGrid(data) {
  const container = document.getElementById('ts-channel-grid');
  if (!container) return;

  const fmt = EXL.fmt.num;
  const allChannels = [...new Set(TS_SLOTS.flatMap(s => (data[s] || []).map(r => r.channel)))];

  const html = TS_SLOTS.map(slot => {
    const rows = data[slot] || [];
    const col  = TS_SLOT_COLORS[slot];
    const maxAtt = Math.max(...rows.map(r => r.attempts), 1);

    const rowsHtml = rows.map(r => {
      const barW = (r.attempts / maxAtt * 100).toFixed(1);
      const bkW  = Math.min(r.booking_rate, 100);
      return `
        <div class="ts-ch-row">
          <span class="ts-ch-name">${r.channel}</span>
          <div class="ts-ch-bars">
            <div class="ts-ch-bar-wrap" title="Attempts: ${fmt(r.attempts)}">
              <div class="ts-ch-bar ts-ch-bar--att" style="width:${barW}%;background:${col.accent};opacity:0.35;"></div>
              <div class="ts-ch-bar ts-ch-bar--bk"  style="width:${bkW * barW / 100}%;background:${col.accent};"></div>
            </div>
          </div>
          <div class="ts-ch-meta">
            <span class="ts-ch-num">${fmt(r.attempts)}</span>
            <span class="ts-ch-rate" style="color:${TS_RATE_COL(r.booking_rate)};">${Math.round(r.booking_rate)}%</span>
          </div>
        </div>`;
    }).join('');

    const total    = rows.reduce((s, r) => s + r.attempts, 0);
    const totalBk  = rows.reduce((s, r) => s + r.bookings, 0);
    const totalRate = total > 0 ? Math.round(totalBk / total * 100) : '—';

    return `
      <div class="ts-slot-panel" style="--slot-accent:${col.accent};--slot-bg:${col.bg};">
        <div class="ts-slot-hd">
          <span class="ts-slot-icon">${TS_SLOT_ICONS[slot]}</span>
          <span class="ts-slot-name">${slot}</span>
          <span class="ts-slot-total">${fmt(total)} attempts · <strong style="color:${TS_RATE_COL(parseFloat(totalRate))};">${totalRate}% booked</strong></span>
        </div>
        <div class="ts-ch-legend">
          <span class="ts-ch-leg-item"><span class="ts-ch-leg-dot" style="background:${col.accent};opacity:0.35;"></span>Attempts</span>
          <span class="ts-ch-leg-item"><span class="ts-ch-leg-dot" style="background:${col.accent};"></span>Bookings</span>
        </div>
        <div class="ts-ch-rows">${rowsHtml}</div>
      </div>`;
  }).join('');

  container.innerHTML = `<div class="ts-slots-3">${html}</div>`;
}

/* ── 2. Business Type Grid ─────────────────────────────────── */

function renderTsBizWrap(data) {
  const container = document.getElementById('ts-biz-wrap');
  if (!container) return;

  const fmt = EXL.fmt.num;

  // Left: by slot (heatmap table)
  const bySlot = data.by_slot || {};
  const allTypes = [...new Set(TS_SLOTS.flatMap(s => (bySlot[s] || []).map(r => r.type)))];

  const slotHeader = `<th class="ts-biz-th ts-biz-th--type">Business Category</th>` +
    TS_SLOTS.map(s => `<th class="ts-biz-th" colspan="2">${TS_SLOT_ICONS[s]} ${s}</th>`).join('');

  const slotSubheader = `<th></th>` +
    TS_SLOTS.map(() => `<th class="ts-biz-sub">Bookings</th><th class="ts-biz-sub">Rate</th>`).join('');

  const allRatesSlot = allTypes.flatMap(type => TS_SLOTS.map(slot => {
      const row = (bySlot[slot] || []).find(r => r.type === type);
      return row ? row.booking_rate : null;
  })).filter(v => v !== null);
  const maxSlotRate = allRatesSlot.length ? Math.max(...allRatesSlot) : 1;
  const minSlotRate = allRatesSlot.length ? Math.min(...allRatesSlot) : 0;

  const slotRows = allTypes.map(type => {
    const cells = TS_SLOTS.map(slot => {
      const row = (bySlot[slot] || []).find(r => r.type === type);
      const rate = row ? row.booking_rate : 0;
      const bk   = row ? row.bookings : 0;
      
      const pct  = maxSlotRate > minSlotRate ? (rate - minSlotRate) / (maxSlotRate - minSlotRate) : 0;
      const [bg, col] = heatColor(pct);

      return `<td class="ts-biz-td">${fmt(bk)}</td><td class="ts-biz-td ts-biz-td--rate" style="background:${bg};color:${col};">${Math.round(rate)}%</td>`;
    }).join('');
    return `<tr><td class="ts-biz-td ts-biz-td--type">${type}</td>${cells}</tr>`;
  }).join('');

  // Right: by day (heatmap table)
  const byDay = data.by_day || {};
  const dayHeader = `<th class="ts-biz-th ts-biz-th--type">Business Category</th>` +
    TS_DAYS.map(d => `<th class="ts-biz-th">${d}</th>`).join('');

  const allRatesDay = allTypes.flatMap(type => TS_DAYS.map(day => {
      const row = (byDay[day] || []).find(r => r.type === type);
      return row ? row.success_rate : null;
  })).filter(v => v !== null);
  const maxDayRate = allRatesDay.length ? Math.max(...allRatesDay) : 1;
  const minDayRate = allRatesDay.length ? Math.min(...allRatesDay) : 0;

  const dayRows = allTypes.map(type => {
    const cells = TS_DAYS.map(day => {
      const row  = (byDay[day] || []).find(r => r.type === type);
      const rate = row ? row.success_rate : 0;
      
      const pct  = maxDayRate > minDayRate ? (rate - minDayRate) / (maxDayRate - minDayRate) : 0;
      const [bg, col] = heatColor(pct);

      return `<td class="ts-biz-td ts-biz-td--rate" style="background:${bg};color:${col};">${Math.round(rate)}%</td>`;
    }).join('');
    return `<tr><td class="ts-biz-td ts-biz-td--type">${type}</td>${cells}</tr>`;
  }).join('');

  // Overall row for each table
  const slotOverall = TS_SLOTS.map(slot => {
    const rows = bySlot[slot] || [];
    const totalAtt = rows.reduce((s,r) => s + r.attempts, 0);
    const totalBk  = rows.reduce((s,r) => s + r.bookings, 0);
    const rate = totalAtt > 0 ? Math.round(totalBk / totalAtt * 100) : 0;
    return `<td class="ts-biz-td ts-biz-td--total">${fmt(totalBk)}</td><td class="ts-biz-td ts-biz-td--rate ts-biz-td--total" style="color:${TS_RATE_COL(rate)};">${rate}%</td>`;
  }).join('');

  const dayOverall = TS_DAYS.map(day => {
    const rows = byDay[day] || [];
    const totalBk  = rows.reduce((s,r) => s + r.bookings, 0);
    const totalAtt = rows.reduce((s,r) => s + r.attempts, 0);
    const rate = totalAtt > 0 ? Math.round(totalBk / totalAtt * 100) : 0;
    return `<td class="ts-biz-td ts-biz-td--rate ts-biz-td--total" style="color:${TS_RATE_COL(rate)};">${rate}%</td>`;
  }).join('');

  container.innerHTML = `
    <div class="ts-biz-split">
      <div class="ts-biz-half">
        <div class="ts-biz-half-title">By Time Slot — Booking Rate</div>
        <div class="ts-table-scroll">
          <table class="ts-biz-table">
            <thead>
              <tr>${slotHeader}</tr>
              <tr class="ts-biz-subrow">${slotSubheader}</tr>
            </thead>
            <tbody>
              ${slotRows}
              <tr class="ts-biz-overall-row"><td class="ts-biz-td ts-biz-td--type">Overall</td>${slotOverall}</tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="ts-biz-half">
        <div class="ts-biz-half-title">By Weekday — Success Rate</div>
        <div class="ts-table-scroll">
          <table class="ts-biz-table">
            <thead><tr>${dayHeader}</tr></thead>
            <tbody>
              ${dayRows}
              <tr class="ts-biz-overall-row"><td class="ts-biz-td ts-biz-td--type">Overall</td>${dayOverall}</tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

/* ── 3. Total Attempts vs Bookings ─────────────────────────── */

function renderTsAttemptsGrid(data) {
  const container = document.getElementById('ts-attempts-grid');
  if (!container) return;

  const fmt = EXL.fmt.num;
  const maxAtt = Math.max(...TS_SLOTS.map(s => (data[s]?.attempts || 0)), 1);

  const html = TS_SLOTS.map(slot => {
    const d   = data[slot] || {};
    const col = TS_SLOT_COLORS[slot];
    const attW = (d.attempts / maxAtt * 100).toFixed(1);
    const bkW  = d.attempts > 0 ? (d.bookings / d.attempts * 100).toFixed(1) : 0;

    return `
      <div class="ts-att-panel" style="--slot-accent:${col.accent};--slot-bg:${col.bg};">
        <div class="ts-slot-hd">
          <span class="ts-slot-icon">${TS_SLOT_ICONS[slot]}</span>
          <span class="ts-slot-name">${slot}</span>
        </div>
        <div class="ts-att-stats">
          <div class="ts-att-stat">
            <span class="ts-att-lbl">Total Attempts</span>
            <strong class="ts-att-val">${fmt(d.attempts || 0)}</strong>
          </div>
          <div class="ts-att-stat">
            <span class="ts-att-lbl">Total Contacts</span>
            <strong class="ts-att-val">${fmt(d.contacts || 0)}</strong>
          </div>
          <div class="ts-att-stat">
            <span class="ts-att-lbl">Bookings Made</span>
            <strong class="ts-att-val" style="color:${col.text};">${fmt(d.bookings || 0)}</strong>
          </div>
          <div class="ts-att-stat">
            <span class="ts-att-lbl">Booking Rate</span>
            <strong class="ts-att-val" style="color:${TS_RATE_COL(d.booking_rate || 0)};">${d.booking_rate || 0}%</strong>
          </div>
        </div>
        <div class="ts-att-bars">
          <div class="ts-att-bar-row">
            <span class="ts-att-bar-lbl">Attempts</span>
            <div class="ts-att-bar-track">
              <div class="ts-att-bar-fill" style="width:${attW}%;background:${col.accent};opacity:0.4;"></div>
            </div>
          </div>
          <div class="ts-att-bar-row">
            <span class="ts-att-bar-lbl">Booked</span>
            <div class="ts-att-bar-track">
              <div class="ts-att-bar-fill" style="width:${bkW}%;background:${col.accent};"></div>
            </div>
            <span class="ts-att-bar-pct" style="color:${TS_RATE_COL(d.booking_rate||0)};">${d.booking_rate||0}%</span>
          </div>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `<div class="ts-slots-3">${html}</div>`;
}

/* ── 4. Agent View — unified 3-slot table ──────────────────── */

function renderTsAgentGrid(data) {
  const container = document.getElementById('ts-agent-grid');
  if (!container) return;

  const fmt = EXL.fmt.num;
  const rowsData = Array.isArray(data) ? data : [];
  if (!rowsData.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-title">No voice agent data available</div></div>';
    return;
  }

  // Column max per slot (for bar scaling)
  const slotMax = {};
  TS_SLOTS.forEach(slot => {
    slotMax[slot] = Math.max(...rowsData.map(r => (r.slots && r.slots[slot]) ? r.slots[slot].attempts : 0), 1);
  });

  // Slot header
  const slotHeaders = TS_SLOTS.map(slot => {
    const col = TS_SLOT_COLORS[slot];
    return `<th class="ts-tbl-slot-hd" colspan="6" style="border-bottom:3px solid ${col.accent}; text-align:center;">
      ${TS_SLOT_ICONS[slot]} ${slot}
    </th>`;
  }).join('');

  const subHeaders = TS_SLOTS.map(() =>
    `<th class="ts-tbl-sub" style="text-align:left;">Attempts</th><th class="ts-tbl-sub">Bookings</th><th class="ts-tbl-sub">Cancel</th><th class="ts-tbl-sub">Abort</th><th class="ts-tbl-sub">Comp</th><th class="ts-tbl-sub">Rate</th>`
  ).join('');

  const rows = rowsData.map((row, idx) => {
    const name = row.agent || 'Unassigned Agent';
    const total = row.attempts || 0;
    const overallRate = row.success_rate || 0;
    const rowClass = idx % 2 === 0 ? '' : ' ts-tbl-row--alt';

    const cells = TS_SLOTS.map(slot => {
      const col = TS_SLOT_COLORS[slot];
      const d = (row.slots && row.slots[slot]) ? row.slots[slot] : { attempts: 0, bookings: 0, cancellations: 0, aborts: 0, completions: 0, success_rate: 0 };
      const barW = (d.attempts / slotMax[slot] * 100).toFixed(1);
      const rateColor = TS_RATE_COL(d.success_rate);

      return `
        <td class="ts-tbl-cell" style="padding: 12px 8px;">
          <div class="ts-tbl-bar-wrap" style="display:flex; align-items:center; gap:8px;">
            <div class="ts-tbl-bar-track" style="flex:1; height:6px; background:rgba(255,255,255,0.05); border-radius:3px; overflow:hidden;">
              <div class="ts-tbl-bar-att" style="height:100%; width:${barW}%; background:${col.accent};"></div>
            </div>
            <span class="ts-tbl-num" style="min-width:30px; text-align:right;">${fmt(d.attempts)}</span>
          </div>
        </td>
        <td class="ts-tbl-cell ts-tbl-cell--bk" style="text-align:center; color:#9ca3af;">${fmt(d.bookings)}</td>
        <td class="ts-tbl-cell ts-tbl-cell--warn" style="text-align:center; color:#f59e0b;">${fmt(d.cancellations)}</td>
        <td class="ts-tbl-cell ts-tbl-cell--crit" style="text-align:center; color:#ef4444;">${fmt(d.aborts)}</td>
        <td class="ts-tbl-cell ts-tbl-cell--ok" style="text-align:center; color:#10b981;">${fmt(d.completions)}</td>
        <td class="ts-tbl-cell ts-tbl-cell--rate" style="text-align:center; font-weight:600; color:${rateColor};">${Math.round(d.success_rate)}%</td>`;
    }).join('');

    return `<tr class="ts-tbl-row${rowClass}">
      <td class="ts-tbl-rank" style="padding:12px 16px; color:#6b7280;">#${idx + 1}</td>
      <td class="ts-tbl-name" title="${name}" style="padding:12px 16px; font-weight:500; white-space:nowrap;">${name}</td>
      ${cells}
      <td class="ts-tbl-total" style="padding:12px 16px; text-align:right; font-weight:600;">${fmt(total)}</td>
      <td class="ts-tbl-total-rate" style="padding:12px 16px; text-align:right; font-weight:700; color:${TS_RATE_COL(overallRate)};">${overallRate}%</td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="ts-ag-table-wrap" style="overflow-x:auto;">
      <table class="ts-ag-table" style="width:100%; border-collapse:collapse; min-width: 1400px;">
        <thead>
          <tr>
            <th class="ts-tbl-rank-hd" rowspan="2" style="padding:12px 16px; text-align:left; border-bottom:1px solid rgba(255,255,255,0.1);">#</th>
            <th class="ts-tbl-name-hd" rowspan="2" style="padding:12px 16px; text-align:left; border-bottom:1px solid rgba(255,255,255,0.1);">Agent</th>
            ${slotHeaders}
            <th class="ts-tbl-total-hd" colspan="2" style="padding:12px 16px; text-align:center; border-bottom:3px solid #6b7280;">Total</th>
          </tr>
          <tr>
            ${subHeaders}
            <th class="ts-tbl-sub" style="padding:12px 8px; text-align:right; color:#9ca3af; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; border-bottom:1px solid rgba(255,255,255,0.1);">Attempts</th>
            <th class="ts-tbl-sub" style="padding:12px 8px; text-align:right; color:#9ca3af; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; border-bottom:1px solid rgba(255,255,255,0.1);">Success</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/* ── Dialler Outcome Table ──────────────────────────────────────── */
function renderDiallerOutcome(rows) {
  const el = document.getElementById('ts-outcome-grid');
  if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-title">No outcome data available</div></div>';
    return;
  }

  const fmt = EXL.fmt.num;

  const tbody = rows.map(r => {
    const stateCls = r.category_state === 'Usable' ? 'do-badge-usable' : 'do-badge-lowvol';
    const opCls    = r.op_meaningful  === 'Yes'    ? 'do-badge-yes'    : 'do-badge-no';
    const prefCls  = r.pref_contact   === 'LL'     ? 'do-badge-ll'     : 'do-badge-mob';

    const mobW  = Math.min(r.mobile_pct  || 0, 100);
    const landW = Math.min(r.landline_pct || 0, 100);

    const [timeLabel, slotName] = r.best_time.split(' - ');

    return `<tr>
      <td class="do-td-cat">${r.category}</td>
      <td class="do-td-time"><strong>${timeLabel}</strong> — ${slotName}</td>
      <td>${r.best_day}</td>
      <td><span class="do-badge ${opCls}">${r.op_meaningful}</span></td>
      <td><span class="do-badge ${stateCls}">${r.category_state}</span></td>
      <td class="do-td-num">${fmt(r.volume)}</td>
      <td class="do-td-pct">${Math.round(r.vol_pct)}%</td>
      <td>
        <div class="do-ch-bar">
          <div class="do-ch-bar-track"><div class="do-ch-bar-fill-mob" style="width:${mobW}%;"></div></div>
          <span class="do-ch-val" style="color:#fb923c;">${Math.round(r.mobile_pct)}%</span>
        </div>
      </td>
      <td>
        <div class="do-ch-bar">
          <div class="do-ch-bar-track"><div class="do-ch-bar-fill-land" style="width:${landW}%;"></div></div>
          <span class="do-ch-val" style="color:#22d3ee;">${Math.round(r.landline_pct)}%</span>
        </div>
      </td>
      <td><span class="do-badge ${prefCls}">${r.pref_contact}</span></td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="do-table-wrap">
      <table class="do-table">
        <thead>
          <tr>
            <th>Business Category</th>
            <th>Best Time to Call</th>
            <th>Best Day to Call</th>
            <th>Op Meaningful</th>
            <th>Category State</th>
            <th class="do-th-num">Volume</th>
            <th class="do-th-num">Vol %</th>
            <th class="do-th-num">Mobile</th>
            <th class="do-th-num">Landline</th>
            <th>Pref. Contact</th>
          </tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}
