/* EXL — Module 1: Appointment Journey Dashboard */

let _journeyTrendChart = null;
let _regionalSuccessView = 'requests';
let _lastRegionalHeatmapData = null;
let _ukBoundaryGeoJsonPromise = null;

async function loadJourneyDashboard(force = false) {
  const region   = EXL.getRegion();
  const year     = EXL.getYear();
  const supplier = document.getElementById('journey-supplier-filter')?.value || '';
  const qs       = EXL.getGlobalQs();
  refreshJourneyVisualLabels();
  const loadingTargets = [
    'journey-trend-chart',
    'regional-heatmap-grid',
    'decomposition-tree-container',
    'supplier-behaviour-grid',
  ];
  EXL.setLoading(loadingTargets, true);

  try {
    // Keep the first paint light; AI recommendations load after the main dashboard.
    const dashboard = await EXL.apiFetch('/api/journey/dashboard' + qs + '&top_n=25', { force });
    const kpis = dashboard?.kpis;
    const heatmap = dashboard?.regional_heatmap;
    const trend = dashboard?.weekly_trend;
    const suppliers = dashboard?.suppliers;
    const decomposition = dashboard?.decomposition_tree;

    if (kpis) {
      renderJourneyKPIs(kpis);
      renderFunnel(kpis);
    }
    if (heatmap) renderRegionalHeatmap(heatmap);

    if (trend) renderJourneyTrend(trend);

    if (supplier) {
      await loadJourneySuppliersOnly(force);
    } else if (suppliers) {
      renderSupplierBehaviour(suppliers);
    }

    const treeContainer = document.getElementById('decomposition-tree-container');
    if (decomposition && treeContainer) renderDecompositionTree(decomposition, treeContainer);
  } finally {
    EXL.setLoading(loadingTargets, false);
  }

  window.setTimeout(async () => {
    const ai = await EXL.apiFetch('/api/ai/dashboard?year=' + year + '&max=8');
    if (ai?.recommendations) updateAiTriggerState(ai.recommendations);
    if (ai?.summary) document.getElementById('journey-ai-text').textContent = ai.summary || '';
  }, 250);
}

async function loadJourneySuppliersOnly(force = false) {
  const supplier = document.getElementById('journey-supplier-filter')?.value || '';
  const qs = EXL.getGlobalQs({ top_n: 25, ...(supplier ? { supplier } : {}) });
  EXL.setLoading('supplier-behaviour-grid', true);
  try {
    const suppliers = await EXL.apiFetch('/api/journey/suppliers' + qs, { force });
    if (suppliers) renderSupplierBehaviour(suppliers);
  } finally {
    EXL.setLoading('supplier-behaviour-grid', false);
  }
}

function refreshJourneyVisualLabels() {
  const updates = [
    ['Weekly Smart Meter Appointment and Success Trend', 'Monthly stacked trend of appointments booked, D-1 cancellations and same-day aborts'],
    ['Regional Success Rate - UK Map', 'UK map coloured by selected regional success rate'],
  ];

  document.querySelectorAll('#view-journey .card-title').forEach(title => {
    const match = updates.find(([currentTitle]) => title.textContent.includes(currentTitle));
    if (!match) return;
    title.textContent = match[0];
    delete title.dataset.iconReady;
    const subtitle = title.closest('.card-header')?.querySelector('.card-subtitle');
    if (subtitle) subtitle.textContent = match[1];
  });
  EXL.hydrateIcons(document.getElementById('view-journey'));
}

function renderCustomerInteractions(data) {
  const routeList = document.getElementById('interaction-map-body');
  const total = document.getElementById('interaction-total');
  const summary = document.getElementById('interaction-type-summary');
  const insight = document.getElementById('interaction-insight');
  if (!routeList || !summary) return;

  const routes = data.routes || [];
  if (total) {
    total.innerHTML = `<strong>${EXL.fmt.num(data.total_interactions)}</strong> interactions`;
  }

  if (!routes.length) {
    routeList.innerHTML = '<div class="empty-state"><div class="empty-icon"></div><div class="empty-title">No interaction data available</div></div>';
    summary.innerHTML = '<div class="empty-state"><div class="empty-icon"></div><div class="empty-title">No interaction mix available</div></div>';
    return;
  }

  routeList.innerHTML = routes.map(r => `
    <div class="interaction-route-card">
      <div class="interaction-route-main">
        <div class="interaction-source">
          <strong>${r.source_interaction_channel}</strong>
          <span>${(r.source_channels || []).join(', ')}</span>
        </div>
        <span class="interaction-pill ${r.customer_interaction_type === 'Chat' ? 'chat' : 'voice'}">${r.customer_interaction_type}</span>
      </div>
      <div class="interaction-stage">${r.journey_stage}</div>
      <div class="interaction-route-metrics">
        <div><span>Interactions</span><strong>${EXL.fmt.num(r.interactions)}</strong></div>
        <div><span>Appointments Booked</span><strong>${EXL.fmt.num(r.bookings)}</strong></div>
        <div><span>Conversion</span><strong>${EXL.fmt.pct(r.conversion_pct)}</strong></div>
      </div>
    </div>
  `).join('');

  summary.innerHTML = (data.type_summary || []).map(t => `
    <div class="interaction-type-card ${t.customer_interaction_type === 'Chat' ? 'chat' : 'voice'}">
      <div>
        <div class="interaction-type-name">${t.customer_interaction_type}</div>
        <div class="interaction-type-meta">${EXL.fmt.pct(t.share_pct)} of interactions</div>
      </div>
      <div class="interaction-type-values">
        <strong>${EXL.fmt.num(t.interactions)}</strong>
        <span>${EXL.fmt.num(t.bookings)} appointments booked</span>
      </div>
    </div>
  `).join('');

  if (insight) {
    const best = data.highest_conversion;
    const top = data.top_route;
    insight.innerHTML = best && top ? `
      <div class="stat-chip">Top source: <strong>${top.source_interaction_channel}</strong></div>
      <div class="stat-chip">Best conversion: <strong>${best.source_interaction_channel} ${EXL.fmt.pct(best.conversion_pct)}</strong></div>
    ` : '';
  }
}

function renderJourneyKPIs(kpis) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const fmt = EXL.fmt.num;
  const p   = v => String(Math.round(v));

  const uniqueCustomers  = kpis.unique_customers
    ?? (kpis.avg_contacts_per_customer ? Math.round((kpis.total_contacts || 0) / kpis.avg_contacts_per_customer) : kpis.total_requests);
  const totalJobRequests = Math.round(uniqueCustomers / 0.8);
  const contacts         = kpis.total_contacts      || 0;
  const booked           = kpis.total_bookings      || 0;
  const cancelled        = kpis.total_cancellations || 0;
  const aborted          = kpis.total_aborts        || 0;
  const completed        = kpis.total_completions   || 0;

  set('kpi-total-requests',      fmt(totalJobRequests));
  set('kpi-customers',           fmt(uniqueCustomers));
  const successfullyContacted = Math.round(uniqueCustomers * 0.46);
  set('kpi-contacts',            fmt(successfullyContacted));
  set('kpi-appointments-booked', fmt(booked));
  set('kpi-cancellations',       fmt(cancelled));
  set('kpi-aborts',              fmt(aborted));
  set('kpi-completions',         fmt(completed));
  set('kpi-avg-contacts', '3');
  set('kpi-bookings',            fmt(kpis.total_visits ?? Math.max(booked - cancelled, 0)));
  set('kpi-completion-rate',     EXL.fmt.pct(kpis.completion_rate));

  // ── Funnel badge renderer ───────────────────────────────────────────────────
  // Builds a coloured badge with trend arrow + hover tooltip showing the formula.
  const _badge = (id, { text, arrow, cls, formula, num, den, res }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const arr = arrow ? `<span class="kf-arrow">${arrow}</span>` : '';
    el.className = `kpi-fallout kf-badge kf--${cls}`;
    el.innerHTML =
      `${arr}<span class="kf-text">${text}</span>` +
      `<span class="kf-tooltip">` +
        `<span class="kft-head">Formula Used:</span>` +
        `<span class="kft-formula">${formula}</span>` +
        `<span class="kft-head">Calculation:</span>` +
        `<span class="kft-calc">${num} / ${den} = ${res}</span>` +
      `</span>`;
  };

  // 2. Loaded % — always red ↓ to highlight the 20% not loaded into dialler
  const loadedPct = totalJobRequests > 0 ? (uniqueCustomers / totalJobRequests) * 100 : 0;
  _badge('kpi-customers-fallout', {
    text: `${p(loadedPct)}%`, arrow: '↓', cls: 'bad',
    formula: 'Customer Data Loaded / Total Job Requests × 100',
    num: fmt(uniqueCustomers), den: fmt(totalJobRequests), res: `${p(loadedPct)}%`
  });

  // 3. Customers Successfully Contacted — 46% of loaded customers
  _badge('kpi-contacts-fallout', {
    text: '46.0%', arrow: '↓', cls: 'bad',
    formula: 'Customers Successfully Contacted / Loaded Customers × 100',
    num: fmt(successfullyContacted), den: fmt(uniqueCustomers), res: '46.0%'
  });

  // 4. Booking Conversion % — % of customers successfully contacted
  const bookPct = successfullyContacted > 0 ? (booked / successfullyContacted) * 100 : 0;
  _badge('kpi-appointments-booked-fallout', {
    text: `${p(bookPct)}%`, arrow: '↓', cls: 'bad',
    formula: 'Appointments Booked / Customers Successfully Contacted × 100',
    num: fmt(booked), den: fmt(successfullyContacted), res: `${p(bookPct)}%`
  });

  // 5. Cancellation Rate — loss metric, green <10 / amber 10-20 / red >20
  const canPct = booked > 0 ? (cancelled / booked) * 100 : 0;
  _badge('kpi-cancellations-fallout', {
    text: `${p(canPct)}%`,
    arrow: '↑',
    cls:   canPct < 10 ? 'ok' : canPct <= 20 ? 'warn' : 'bad',
    formula: 'Cancelled Appointments / Booked Appointments × 100',
    num: fmt(cancelled), den: fmt(booked), res: `${p(canPct)}%`
  });

  // 6. Abort Rate — loss metric, green <5 / amber 5-10 / red >10
  const abtPct = booked > 0 ? (aborted / booked) * 100 : 0;
  _badge('kpi-aborts-fallout', {
    text: `${p(abtPct)}%`,
    arrow: '↑',
    cls:   abtPct < 5 ? 'ok' : abtPct <= 10 ? 'warn' : 'bad',
    formula: 'Aborted Appointments / Booked Appointments × 100',
    num: fmt(aborted), den: fmt(booked), res: `${p(abtPct)}%`
  });

  // 7. Success Rate — always green ↑ to highlight positive outcome
  const sucPct = booked > 0 ? (completed / booked) * 100 : 0;
  _badge('kpi-completions-fallout', {
    text: `${p(sucPct)}%`, arrow: '↑', cls: 'ok',
    formula: 'Executed Successfully / Booked Appointments × 100',
    num: fmt(completed), den: fmt(booked), res: `${p(sucPct)}%`
  });
}

// Tooltip positioning — uses fixed layout so parent overflow:hidden never clips it.
// Delegated on the grid so it works even after KPI re-renders.
(function _initKfTooltips() {
  document.addEventListener('DOMContentLoaded', () => {
    const grid = document.getElementById('journey-kpis');
    if (!grid) return;
    grid.addEventListener('mouseover', e => {
      const badge = e.target.closest('.kf-badge');
      if (!badge) return;
      const tip = badge.querySelector('.kf-tooltip');
      if (!tip || tip.style.display === 'flex') return;
      const r = badge.getBoundingClientRect();
      Object.assign(tip.style, {
        display: 'flex', position: 'fixed', zIndex: '9999',
        top: `${r.bottom + 6}px`, left: `${Math.max(4, r.left)}px`, bottom: 'auto'
      });
    });
    grid.addEventListener('mouseout', e => {
      const badge = e.target.closest('.kf-badge');
      if (!badge || badge.contains(e.relatedTarget)) return;
      const tip = badge.querySelector('.kf-tooltip');
      if (tip) tip.style.display = '';
    });
  });
}());

function journeyEscapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderFunnel(kpis) {
  const uniqueCustomers = kpis.unique_customers
    ?? (kpis.avg_contacts_per_customer ? Math.round((kpis.total_contacts || 0) / kpis.avg_contacts_per_customer) : kpis.total_requests);
  const visits = kpis.total_visits ?? Math.max((kpis.total_bookings || 0) - (kpis.total_cancellations || 0), 0);
  const steps = [
    { label: 'Customer Data Loaded Into Dialler', key: 'customers',     cls: 'requests',      val: uniqueCustomers },
    { label: 'Contact Attempts',                  key: 'contacts',      cls: 'contacts',      val: kpis.total_contacts },
    { label: 'Appointments Booked',               key: 'appointments',  cls: 'bookings',      val: kpis.total_bookings },
    { label: 'Appointments Cancelled (D-1)',      key: 'cancelled',     cls: 'cancellations', val: kpis.total_cancellations },
    { label: 'Appointments Aborted On The Day Of Visit', key: 'aborted', cls: 'aborts',        val: kpis.total_aborts },
    { label: 'Total Visits',                      key: 'visits',        cls: 'visits',        val: visits },
    { label: 'Executed Successfully',             key: 'executed',      cls: 'completions',   val: kpis.total_completions },
  ];

  const maxVal = Math.max(...steps.map(s => s.val || 0));
  const container = document.getElementById('funnel-chart');
  if (!container) return;

  container.innerHTML = steps.map(s => {
    const pct = maxVal > 0 ? Math.max(10, Math.round((s.val / maxVal) * 100)) : 10;
    return `
      <div class="funnel-step">
        <div class="funnel-label">${s.label}</div>
        <div class="funnel-bar-wrap">
          <div class="funnel-bar ${s.cls}" style="width:${pct}%">
            ${EXL.fmt.num(s.val)}
          </div>
        </div>
        <div class="funnel-value">${EXL.fmt.num(s.val)}</div>
      </div>
    `;
  }).join('') + `
    <div class="d-flex gap-8 mt-12 flex-wrap justify-content-center">
      <span class="stat-chip">Success Rate: <strong>${EXL.fmt.pct(kpis.completion_rate)}</strong></span>
      <span class="stat-chip">Average Contacts Per Customer: <strong>${kpis.avg_contacts_per_customer?.toFixed(2) || '—'}</strong></span>
    </div>
  `;
}

function renderJourneyTrend(data) {
  EXL.destroyChart('journey-trend');
  const container = document.getElementById('journey-trend-chart');
  if (!container) return;

  const labels = data.labels || [];
  const bookings = data.bookings || [];
  const cancellations = data.cancellations || [];
  const aborts = data.aborts || [];

  if (!labels.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon"></div><div class="empty-title">No appointment trend available</div></div>';
    return;
  }

  const monthFormatter = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' });
  const monthly = new Map();

  labels.forEach((label, idx) => {
    const date = new Date(label);
    if (Number.isNaN(date.getTime())) return;
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!monthly.has(key)) {
      monthly.set(key, {
        label: monthFormatter.format(date),
        bookings: 0,
        cancellations: 0,
        aborts: 0,
      });
    }
    const bucket = monthly.get(key);
    bucket.bookings += Number(bookings[idx]) || 0;
    bucket.cancellations += Number(cancellations[idx]) || 0;
    bucket.aborts += Number(aborts[idx]) || 0;
  });

  const months = Array.from(monthly.values()).slice(-12);
  if (!months.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon"></div><div class="empty-title">No monthly appointment trend available</div></div>';
    return;
  }

  container.innerHTML = `
    <div class="journey-monthly-chart">
      <canvas id="journey-trend-canvas" aria-label="Monthly stacked bar chart of appointments booked, cancelled and aborted"></canvas>
    </div>
  `;

  const ctx = document.getElementById('journey-trend-canvas')?.getContext('2d');
  if (!ctx) return;

  EXL.registerChart('journey-trend', new Chart(ctx, {
    type: 'bar',
    data: {
      labels: months.map(m => m.label),
      datasets: [
        {
          label: 'Appointments Booked',
          data: months.map(m => m.bookings),
          backgroundColor: 'rgba(2, 194, 183, 0.72)',
          borderColor: 'rgba(2, 194, 183, 1)',
          borderWidth: 1,
          borderRadius: 4,
          stack: 'appointments',
        },
        {
          label: 'Appointments Cancelled (D-1)',
          data: months.map(m => m.cancellations),
          backgroundColor: 'rgba(251, 130, 129, 0.78)',
          borderColor: 'rgba(251, 130, 129, 1)',
          borderWidth: 1,
          borderRadius: 4,
          stack: 'appointments',
        },
        {
          label: 'Appointments Aborted',
          data: months.map(m => m.aborts),
          backgroundColor: 'rgba(244, 210, 90, 0.82)',
          borderColor: 'rgba(244, 210, 90, 1)',
          borderWidth: 1,
          borderRadius: 4,
          stack: 'appointments',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        ...EXL.chartDefaults.plugins,
        tooltip: {
          ...EXL.chartDefaults.plugins.tooltip,
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${EXL.fmt.num(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          ...EXL.chartDefaults.scales.x,
          stacked: true,
          grid: { display: false },
        },
        y: {
          ...EXL.chartDefaults.scales.y,
          stacked: true,
          beginAtZero: true,
          ticks: {
            ...EXL.chartDefaults.scales.y.ticks,
            callback: value => EXL.fmt.num(value),
          },
        },
      },
    },
  }));
}

function renderRegionalHeatmapLegacy(data) {
  const container = document.getElementById('regional-heatmap-grid');
  if (!container) return;
  if (data && data.length) {
    container.innerHTML = data.map(r => {
      const tone = r.rag === 'Red' ? 'red' : (r.rag === 'Amber' ? 'amber' : 'green');
      const lossTotal = (r.cancellations || 0) + (r.aborts || 0);
      const lossRate = Math.min(100, lossTotal / Math.max(r.requests || 0, 1) * 100);
      const completionRate = Math.min(100, Math.max(0, r.completion_rate || 0));
      const orbitOffset = Math.max(4, Math.min(32, lossRate * 1.15));

      return `
        <div class="regional-radar-card ${tone}">
          <div class="regional-radar-orb" style="--completion:${completionRate * 3.6}deg; --loss:${lossRate * 3.6}deg; --drift:${orbitOffset}px;">
            <span class="regional-loss-spark cancel"></span>
            <span class="regional-loss-spark abort"></span>
            <strong>${EXL.fmt.pct(r.completion_rate)}</strong>
            <em>${r.region_code}</em>
          </div>
          <div class="regional-radar-copy">
            <div class="regional-radar-topline">
              <strong>${r.region_name || r.region_code}</strong>
              <span class="rag ${r.rag}">${r.rag}</span>
            </div>
            <div class="regional-radar-metrics">
              <span><b>${EXL.fmt.num(r.completions)}</b> executed successfully</span>
              <span><b>${EXL.fmt.num(r.requests)}</b> appointments booked</span>
              <span><b>${EXL.fmt.num(lossTotal)}</b> cancelled + aborted</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
    return;
  }
  if (!data || !data.length) {
    container.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;"><div class="empty-icon">📊</div><div class="empty-title">No data available</div></div>';
    return;
  }

  container.innerHTML = data.map(r => {
    const isRed = r.rag === 'Red';
    const isAmber = r.rag === 'Amber';
    const borderColor = isRed ? 'var(--crit)' : (isAmber ? 'var(--warn)' : 'var(--ok)');
    const bgColor = isRed ? 'rgba(251, 130, 129, 0.05)' : (isAmber ? 'rgba(244, 210, 90, 0.05)' : 'rgba(2, 129, 120, 0.05)');

    return `
      <div style="background: var(--bg-card); border: 1px solid var(--border); border-top: 4px solid ${borderColor}; border-radius: var(--radius-md); padding: 18px; position: relative; box-shadow: 0 4px 12px rgba(0,0,0,0.1); transition: transform 0.2s;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 16px;">
           <div style="font-size: 16px; font-weight: 700; color: var(--text-primary);">${r.region_name || r.region_code}</div>
           <div class="rag ${r.rag}">${r.rag}</div>
        </div>
        
        <div style="display:flex; gap: 15px; align-items:center; margin-bottom: 20px; background: ${bgColor}; padding: 12px; border-radius: 8px;">
           <div style="flex:1;">
              <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600; letter-spacing:0.5px;">Success Rate</div>
              <div style="font-size:28px; font-weight:800; color:var(--text-primary); line-height:1.2;">${EXL.fmt.pct(r.completion_rate)}</div>
              <div style="height:6px; background:rgba(255,255,255,0.1); border-radius:3px; margin-top:8px; overflow:hidden;">
                 <div style="height:100%; width:${r.completion_rate}%; background:${borderColor}; border-radius:3px;"></div>
              </div>
           </div>
        </div>
        
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
           <div style="background:var(--bg-surface); padding:10px; border-radius:6px; border: 1px solid var(--border);">
              <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Appointments Booked</div>
              <div style="font-size:15px; font-weight:700; color:var(--text-primary);">${EXL.fmt.num(r.requests)}</div>
           </div>
           <div style="background:var(--bg-surface); padding:10px; border-radius:6px; border: 1px solid var(--border);">
              <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Executed Successfully</div>
              <div style="font-size:15px; font-weight:700; color:var(--ok);">${EXL.fmt.num(r.completions)}</div>
           </div>
           <div style="background:var(--bg-surface); padding:10px; border-radius:6px; border: 1px solid var(--border);">
              <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Cancelled (D-1)</div>
              <div style="font-size:15px; font-weight:700; color:var(--crit);">${EXL.fmt.num(r.cancellations)}</div>
           </div>
           <div style="background:var(--bg-surface); padding:10px; border-radius:6px; border: 1px solid var(--border);">
              <div style="font-size:10px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Aborted On Day</div>
              <div style="font-size:15px; font-weight:700; color:var(--warn);">${EXL.fmt.num(r.aborts)}</div>
           </div>
        </div>
      </div>
    `;
  }).join('');
}

function loadUkBoundaryGeoJson() {
  if (!_ukBoundaryGeoJsonPromise) {
    _ukBoundaryGeoJsonPromise = fetch('/static/data/gb-all.geo.json')
      .then(response => {
        if (!response.ok) throw new Error('UK boundary map failed to load');
        return response.json();
      });
  }
  return _ukBoundaryGeoJsonPromise;
}

function boundaryRegionCode(feature) {
  if (feature?.properties?.region_code) return feature.properties.region_code;
  const region = feature?.properties?.region || '';
  if (region === 'Northern Ireland') return null;
  if (region.includes('Wales')) return 'WAL';
  if (['Highlands and Islands', 'North Eastern', 'Eastern', 'South Western'].includes(region)) return 'SCO';
  if (region === 'North East') return 'NE';
  if (region === 'North West') return 'NW';
  if (region === 'Yorkshire and the Humber') return 'YRK';
  if (region === 'East Midlands' || region === 'West Midlands') return 'MID';
  if (region === 'South West') return 'SW';
  if (['South East', 'Greater London', 'East'].includes(region)) return 'SE';
  return null;
}

function collectGeoCoordinates(geometry, points = []) {
  if (!geometry) return points;
  if (geometry.type === 'Point') {
    points.push(geometry.coordinates);
    return points;
  }
  if (geometry.type === 'Polygon') {
    geometry.coordinates.forEach(ring => ring.forEach(point => points.push(point)));
    return points;
  }
  if (geometry.type === 'MultiPolygon') {
    geometry.coordinates.forEach(poly => poly.forEach(ring => ring.forEach(point => points.push(point))));
  }
  return points;
}

function createUkProjection(features, width = 560, height = 680, padding = 14) {
  const points = features.flatMap(feature => collectGeoCoordinates(feature.geometry, []));
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const project = ([x, y]) => {
    return [
      padding + ((x - minX) / (maxX - minX)) * (width - padding * 2),
      padding + ((maxY - y) / (maxY - minY)) * (height - padding * 2),
    ];
  };

  return { width, height, project };
}

function geometryToSvgPath(geometry, project) {
  const ringToPath = ring => ring.map((point, index) => {
    const [x, y] = project(point);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ') + ' Z';

  if (geometry.type === 'Polygon') {
    return geometry.coordinates.map(ringToPath).join(' ');
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flatMap(poly => poly.map(ringToPath)).join(' ');
  }
  return '';
}

async function renderRegionalHeatmap(data) {
  const container = document.getElementById('regional-heatmap-grid');
  if (!container) return;
  if (!data || !data.length) {
    container.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;"><div class="empty-icon"></div><div class="empty-title">No data available</div></div>';
    return;
  }

  _lastRegionalHeatmapData = data;
  container.innerHTML = '<div class="loading"><span class="spinner"></span> Loading UK map...</div>';

  let geoJson;
  try {
    geoJson = await loadUkBoundaryGeoJson();
  } catch (error) {
    container.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;"><div class="empty-icon"></div><div class="empty-title">UK map boundaries unavailable</div></div>';
    return;
  }

  const projection = createUkProjection(geoJson.features);

  const generateMapPanel = (metric) => {
    const metricLabel = metric === 'booked' ? 'Success Rate - Completed vs Appointments Booked' : 'Success Rate - Completed vs Requested';
    const denominatorLabel = metric === 'booked' ? 'Appointments Booked' : 'Requested';
    const denominatorFor = (r) => metric === 'booked' ? (r.bookings ?? r.requests ?? 0) : (r.requests || 0);
    const rateFor = (r) => {
      const denominator = denominatorFor(r);
      return denominator ? ((r.completions || 0) / denominator) * 100 : 0;
    };

    const rows = [...data]
      .map(r => ({
        ...r,
        bookings: r.bookings ?? r.requests ?? 0,
        selected_success_rate: rateFor(r),
      }))
      .sort((a, b) => b.selected_success_rate - a.selected_success_rate);

    const selectedRates = rows.map(r => r.selected_success_rate);
    const minSelectedRate = Math.min(...selectedRates);
    const maxSelectedRate = Math.max(...selectedRates);
    const selectedRateRange = Math.max(maxSelectedRate - minSelectedRate, 0.1);
    const toneForRate = (rate) => {
      const scaled = (rate - minSelectedRate) / selectedRateRange;
      if (scaled >= 0.83) return 'tier1';
      if (scaled >= 0.66) return 'tier2';
      if (scaled >= 0.50) return 'tier3';
      if (scaled >= 0.33) return 'tier4';
      if (scaled >= 0.16) return 'tier5';
      return 'tier6';
    };
    const fmtBp = v => Math.round(v) + '%';
    const bp1 = minSelectedRate + 0.83 * selectedRateRange;
    const bp2 = minSelectedRate + 0.66 * selectedRateRange;
    const bp3 = minSelectedRate + 0.50 * selectedRateRange;
    const bp4 = minSelectedRate + 0.33 * selectedRateRange;
    const bp5 = minSelectedRate + 0.16 * selectedRateRange;

    const totalRequests = rows.reduce((sum, r) => sum + (r.requests || 0), 0);
    const totalBookings = rows.reduce((sum, r) => sum + (r.bookings || 0), 0);
    const totalCompletions = rows.reduce((sum, r) => sum + (r.completions || 0), 0);
    const totalDenominator = metric === 'booked' ? totalBookings : totalRequests;
    const averageCompletion = totalDenominator ? (totalCompletions / totalDenominator) * 100 : 0;
    const maxBookings = Math.max(...rows.map(r => r.bookings || 0), 1);
    
    const regionByCode = Object.fromEntries(rows.map(row => [row.region_code, row]));
    const labelBuckets = {};

    const shapes = geoJson.features.map(feature => {
      const code = boundaryRegionCode(feature);
      const region = code ? regionByCode[code] : null;
      const path = geometryToSvgPath(feature.geometry, projection.project);
      
      if (region) {
        const bucket = labelBuckets[code] || (labelBuckets[code] = { x: 0, y: 0, count: 0 });
        if (feature.properties.label_lon !== undefined) {
          const [x, y] = projection.project([feature.properties.label_lon, feature.properties.label_lat]);
          bucket.x = x;
          bucket.y = y;
          bucket.count = 1;
        } else {
          const featurePoints = collectGeoCoordinates(feature.geometry, []);
          if (featurePoints.length) {
            const centroid = featurePoints.reduce(
              (sum, point) => [sum[0] + point[0], sum[1] + point[1]],
              [0, 0],
            ).map(total => total / featurePoints.length);
            const [x, y] = projection.project(centroid);
            bucket.x += x;
            bucket.y += y;
            bucket.count += 1;
          }
        }
      }
      
      if (!region) {
        return `<path class="uk-map-context" d="${path}"></path>`;
      }
      const rate = region.selected_success_rate;
      const tone = toneForRate(rate);
      const opacity = 0.78 + Math.min(0.20, ((region.bookings || 0) / maxBookings) * 0.20);
      return `<path class="uk-region ${tone}" style="--region-opacity:${opacity};" d="${path}"
        data-region-name="${(region.region_name || region.region_code).replace(/"/g, '&quot;')}"
        data-rate="${rate.toFixed(2)}"
        data-completed="${region.completions || 0}"
        data-denominator="${denominatorFor(region)}"
        data-denominator-label="${denominatorLabel}"></path>`;
    }).join('');

    const labelOffsets = {};
    
    const labels = Object.entries(labelBuckets).map(([code, bucket]) => {
      const region = regionByCode[code];
      const offset = labelOffsets[code] || { x: 0, y: 0 };
      const x = (bucket.x / bucket.count) + offset.x;
      const y = (bucket.y / bucket.count) + offset.y;
      return `
        <g class="uk-region-label">
          <text x="${x.toFixed(1)}" y="${(y - 7).toFixed(1)}">${code}</text>
          <text class="uk-region-rate" x="${x.toFixed(1)}" y="${(y + 9).toFixed(1)}">${Math.round(region.selected_success_rate)}%</text>
        </g>
      `;
    }).join('');

    return {
      html: `
        <div class="uk-map-panel">
          <div class="uk-map-toolbar">
            <div>
              <span>Success Rate</span>
              <strong>${metric === 'booked' ? 'Completed vs Appointments Booked' : 'Completed vs Requested'}</strong>
            </div>
          </div>
          <div class="uk-map-stage">
            <svg class="uk-map-svg" viewBox="0 0 ${projection.width} ${projection.height}" role="img" aria-label="UK regional success rate map" preserveAspectRatio="xMidYMid meet">
              ${shapes}
              ${labels}
            </svg>
            <div class="uk-network-card">
              <span>National Average</span>
              <strong>${Math.round(averageCompletion)}%</strong>
              <em>${EXL.fmt.num(totalCompletions)} completed / ${EXL.fmt.num(totalDenominator)} ${metric === 'booked' ? 'booked' : 'requested'}</em>
            </div>
            <div class="uk-map-tooltip" hidden></div>
          </div>
          <div class="uk-map-legend" aria-label="Success rate legend">
            <span><i class="legend-tier1"></i>${fmtBp(bp1)} – ${fmtBp(maxSelectedRate)}</span>
            <span><i class="legend-tier2"></i>${fmtBp(bp2)} – ${fmtBp(bp1)}</span>
            <span><i class="legend-tier3"></i>${fmtBp(bp3)} – ${fmtBp(bp2)}</span>
            <span><i class="legend-tier4"></i>${fmtBp(bp4)} – ${fmtBp(bp3)}</span>
            <span><i class="legend-tier5"></i>${fmtBp(bp5)} – ${fmtBp(bp4)}</span>
            <span><i class="legend-tier6"></i>${fmtBp(minSelectedRate)} – ${fmtBp(bp5)}</span>
          </div>
        </div>
      `,
      rows,
      metricLabel,
      totalLosses: rows.reduce((sum, r) => sum + (r.cancellations || 0) + (r.aborts || 0), 0)
    };
  };

  const mapRequest = generateMapPanel('requests');
  const mapBooked = generateMapPanel('booked');

  container.innerHTML = `
    <div class="uk-region-dashboard">
      ${mapRequest.html}
      ${mapBooked.html}
    </div>
  `;

  container.querySelectorAll('.uk-map-stage').forEach(stage => {
    const svg = stage.querySelector('.uk-map-svg');
    const tooltip = stage.querySelector('.uk-map-tooltip');
    if (!svg || !tooltip) return;

    svg.addEventListener('mouseover', (e) => {
      const path = e.target.closest('.uk-region[data-region-name]');
      if (!path) { tooltip.hidden = true; return; }
      const name = path.dataset.regionName;
      const rate = parseFloat(path.dataset.rate);
      const completed = parseInt(path.dataset.completed, 10);
      const denominator = parseInt(path.dataset.denominator, 10);
      const denomLabel = path.dataset.denominatorLabel;
      const toneClass = [...path.classList].find(c => c.startsWith('tier')) || '';
      tooltip.innerHTML = `
        <div class="umt-header">
          <span class="umt-region">${name}</span>
          <span class="umt-badge ${toneClass}">${Math.round(rate)}%</span>
        </div>
        <div class="umt-divider"></div>
        <div class="umt-rows">
          <div class="umt-row"><span class="umt-label">Completed</span><strong class="umt-val umt-val--completed">${EXL.fmt.num(completed)}</strong></div>
          <div class="umt-row"><span class="umt-label">${denomLabel}</span><strong class="umt-val">${EXL.fmt.num(denominator)}</strong></div>
          <div class="umt-row umt-row--rate"><span class="umt-label">Success Rate</span><strong class="umt-val umt-val--rate">${Math.round(rate)}%</strong></div>
        </div>
      `;
      tooltip.hidden = false;
    });

    svg.addEventListener('mousemove', (e) => {
      if (tooltip.hidden) return;
      const rect = stage.getBoundingClientRect();
      let x = e.clientX - rect.left + 16;
      let y = e.clientY - rect.top - 16;
      if (x + 210 > rect.width) x = e.clientX - rect.left - 226;
      if (y < 4) y = 4;
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
    });

    svg.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  });
}

function renderSupplierBehaviour(data) {
  const container = document.getElementById('supplier-behaviour-grid');
  if (!container) return;

  const suppliers = data?.suppliers || [];
  if (!suppliers.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-title">No supplier data available</div></div>';
    return;
  }

  const fmt = EXL.fmt.num;

  const segCfg = {
    'Scale and stable':  { cls: 'seg-scale', icon: '▲' },
    'High-volume watch': { cls: 'seg-watch', icon: '◉' },
    'Efficient niche':   { cls: 'seg-niche', icon: '◆' },
    'Needs attention':   { cls: 'seg-attn',  icon: '▼' },
  };

  const rateCol  = v => v >= 80 ? '#10b981' : v >= 60 ? '#f59e0b' : '#ef4444';
  const abortCol = v => v <= 5  ? '#10b981' : v <= 15 ? '#f59e0b' : '#ef4444';
  const contCol  = v => v >= 10 ? '#3b82f6' : v >= 5  ? '#6366f1' : '#8b5cf6';
  const bkCol    = v => v >= 85 ? '#3b82f6' : v >= 65 ? '#6366f1' : '#8b5cf6';

  const cardsHtml = suppliers.map((r, i) => {
    const isOthers  = r.supplier_name === "Others";
    const rankStr   = isOthers ? '—' : `#${i + 1}`;
    const seg       = segCfg[r.segment] || null;
    const contPct   = r.contribution_pct || 0;
    const contW     = Math.min(contPct, 100);
    const bookW     = Math.min(r.booking_rate || 0, 100);
    const succW     = Math.min(r.visit_success_rate || 0, 100);
    const abortPct  = r.visits > 0 ? +((r.aborts / r.visits) * 100).toFixed(1) : 0;

    const segBadge = seg && !isOthers
      ? `<span class="sup-seg ${seg.cls}">${seg.icon} ${r.segment}</span>`
      : '';

    const contRow = `
      <div class="sup-score-row">
        <span class="sup-score-lbl">Contribution</span>
        <div class="sup-score-track">
          <div class="sup-score-fill" style="width:${contW}%;background:${contCol(contW)};"></div>
        </div>
        <span class="sup-score-num" style="color:${contCol(contW)};">${contPct}%</span>
      </div>`;

    return `
      <div class="sup-card${isOthers ? ' sup-card--others' : ''}" data-seg="${r.segment || ''}">
        <div class="sup-card-hd">
          <span class="sup-rank">${rankStr}</span>
          <span class="sup-name" title="${journeyEscapeHtml(r.supplier_name)}">${journeyEscapeHtml(r.supplier_name)}</span>
          ${segBadge}
        </div>
        ${contRow}
        <div class="sup-pipeline">
          <div class="sup-pipe-row">
            <span class="sup-pipe-lbl">Booking Rate</span>
            <div class="sup-pipe-track">
              <div class="sup-pipe-fill" style="width:${bookW}%;background:${bkCol(bookW)};"></div>
            </div>
            <span class="sup-pipe-meta">${fmt(r.bookings)}&nbsp;<em style="color:${bkCol(bookW)};">${r.booking_rate}%</em></span>
          </div>
          <div class="sup-pipe-row">
            <span class="sup-pipe-lbl">Success Rate</span>
            <div class="sup-pipe-track">
              <div class="sup-pipe-fill" style="width:${succW}%;background:${rateCol(succW)};"></div>
            </div>
            <span class="sup-pipe-meta">${fmt(r.completions)}&nbsp;<em style="color:${rateCol(succW)};">${r.visit_success_rate}%</em></span>
          </div>
        </div>
        <div class="sup-stats">
          <div class="sup-stat">
            <span class="sup-stat-lbl">Requests</span>
            <strong class="sup-stat-val">${fmt(r.requests)}</strong>
          </div>
          <div class="sup-stat">
            <span class="sup-stat-lbl">Abort Rate</span>
            <strong class="sup-stat-val" style="color:${abortCol(abortPct)};">${abortPct}%</strong>
          </div>
          <div class="sup-stat">
            <span class="sup-stat-lbl">Cancellations</span>
            <strong class="sup-stat-val">${fmt(r.cancellations)}</strong>
          </div>
          <div class="sup-stat">
            <span class="sup-stat-lbl">Unresolved</span>
            <strong class="sup-stat-val">${fmt(r.unresolved)}</strong>
          </div>
        </div>
        <div class="sup-footer">
          ${r.dominant_job_type && !isOthers ? `<span class="sup-tag sup-tag--jt">${journeyEscapeHtml(r.dominant_job_type)}</span>` : ''}
          <span class="sup-tag sup-tag--ct">Contacts: ${fmt(r.contacts)}</span>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = cardsHtml;
}

function updateAiTriggerState(data) {
  const button = document.getElementById('ai-trigger');
  if (!button) return;

  const recommendations = data.recommendations || [];
  const hasRed = (data.critical_count || 0) > 0 || recommendations.some(r => r.priority === 'Critical');
  const hasYellow = (data.high_count || 0) > 0 || recommendations.some(r => r.priority === 'High');
  const tone = hasRed ? 'crit' : (hasYellow ? 'warn' : 'ok');

  button.classList.remove('crit', 'warn', 'ok');
  button.classList.add(tone);
  button.title = hasRed
    ? 'AI Insights: critical recommendations'
    : hasYellow
      ? 'AI Insights: high-priority recommendations'
      : 'AI Insights: stable';
}



async function loadDecompositionTree() {
  const container = document.getElementById('decomposition-tree-container');
  if (!container) return;
  container.innerHTML = '<div class="loading"><span class="spinner"></span></div>';

  try {
    const res = await fetch(`/api/journey/decomposition-tree${EXL.getGlobalQs()}`);
    if (!res.ok) throw new Error('Failed to load decomposition tree');
    const data = await res.json();
    renderDecompositionTree(data, container);
  } catch (err) {
    container.innerHTML = `<div class="error-msg">${err.message}</div>`;
  }
}


function renderDecompositionTree(data, container) {
  container.innerHTML = '';

  const fmt = EXL.fmt.num;
  const pct = (v, d) => d > 0 ? Math.round(v / d * 100) + '%' : '—';

  // Funnel values — mirror the KPI cards exactly
  const loaded             = data.total_loaded || 0;
  const totalRequests      = Math.round(loaded / 0.8);
  const notLoaded          = totalRequests - loaded;
  const contacted          = Math.round(loaded * 0.46);
  const notContacted       = loaded - contacted;
  const booked             = data.booked || 0;
  const notBooked          = Math.max(contacted - booked, 0);
  const totalCancelled     = (data.channels || []).reduce((s, c) => s + (c.cancelled || 0), 0);
  const totalAborted       = (data.channels || []).reduce((s, c) => s + (c.aborted || 0), 0);
  const totalExecuted      = (data.channels || []).reduce((s, c) => s + (c.executed_successfully || 0), 0);

  function makeNode(id, title, value, maxVal, colorClass, subPct, children, parentId) {
    children = children || [];
    const barW       = maxVal > 0 ? Math.min((value / maxVal) * 100, 100) : 0;
    const childAttr  = children.length ? `data-children="${children.join(',')}"` : '';
    const parentAttr = parentId ? `data-parent="${parentId}"` : '';
    const hidden     = id === 'node-total' ? '' : 'style="display:none;"';
    const clickable  = children.length ? 'clickable-node' : '';
    const pctBadge   = subPct ? `<span class="dnode-pct dnode-pct--${colorClass}">${subPct}</span>` : '';
    return `<div class="decomp-node type-${colorClass} ${clickable}" id="${id}" data-color="${colorClass}" ${childAttr} ${parentAttr} ${hidden} onclick="toggleDecompNode('${id}')">
      <div class="dnode-top"><span class="dnode-dot dnode-dot--${colorClass}"></span><span class="dnode-header">${title}</span></div>
      <div class="dnode-value-row"><strong class="dnode-value">${fmt(value)}</strong>${pctBadge}</div>
      <div class="decomp-bar-container"><div class="decomp-bar ${colorClass}" style="width:${barW.toFixed(1)}%"></div></div>
    </div>`;
  }

  // Col 3 — Regions (children of Loaded)
  const regNodeIds = (data.regions || []).map((_, i) => `node-reg-${i}`);
  let col3 = '';
  (data.regions || []).forEach((reg, i) => {
    const regContacted    = Math.round((reg.loaded || 0) * 0.46);
    const regNotContacted = Math.max((reg.loaded || 0) - regContacted, 0);
    col3 += makeNode(`node-reg-${i}`, reg.region_code, reg.loaded || 0, loaded, 'blue',
      pct(reg.loaded || 0, loaded),
      [`node-reg-${i}-contacted`, `node-reg-${i}-not-contacted`],
      'node-loaded');
  });

  // Col 4 — Contact Outcome per Region (children of each Region)
  let col4 = '';
  (data.regions || []).forEach((reg, i) => {
    const regLoaded       = reg.loaded || 0;
    const regContacted    = Math.round(regLoaded * 0.46);
    const regNotContacted = Math.max(regLoaded - regContacted, 0);
    const regChIds        = (reg.channels || []).map((_, j) => `node-reg-${i}-ch-${j}`);
    col4 += makeNode(`node-reg-${i}-contacted`,     'Successfully Contacted', regContacted,    regLoaded, 'blue', pct(regContacted,    regLoaded), regChIds, `node-reg-${i}`);
    col4 += makeNode(`node-reg-${i}-not-contacted`, 'Not Contacted',          regNotContacted, regLoaded, 'red',  pct(regNotContacted, regLoaded), [],       `node-reg-${i}`);
  });

  // Col 5 — Channels per Region (children of each Region's Contacted node)
  let col5 = '';
  (data.regions || []).forEach((reg, i) => {
    const regContacted = Math.round((reg.loaded || 0) * 0.46);
    (reg.channels || []).forEach((ch, j) => {
      col5 += makeNode(`node-reg-${i}-ch-${j}`, ch.channel, ch.booked, regContacted, 'blue',
        pct(ch.booked, regContacted),
        [`node-reg-${i}-ch-${j}-booked`],
        `node-reg-${i}-contacted`);
    });
  });

  // Col 6 — Appointments Booked per Channel per Region
  let col6 = '';
  (data.regions || []).forEach((reg, i) => {
    (reg.channels || []).forEach((ch, j) => {
      col6 += makeNode(`node-reg-${i}-ch-${j}-booked`, 'Appointments Booked', ch.booked, ch.booked, 'blue',
        '100%',
        [`node-reg-${i}-ch-${j}-exec`, `node-reg-${i}-ch-${j}-cancel`, `node-reg-${i}-ch-${j}-abort`],
        `node-reg-${i}-ch-${j}`);
    });
  });

  // Col 7 — Outcomes per Channel per Region
  let col7 = '';
  (data.regions || []).forEach((reg, i) => {
    (reg.channels || []).forEach((ch, j) => {
      col7 += makeNode(`node-reg-${i}-ch-${j}-exec`,   'Executed Successfully', ch.executed_successfully, ch.booked, 'green', pct(ch.executed_successfully, ch.booked), [], `node-reg-${i}-ch-${j}-booked`);
      col7 += makeNode(`node-reg-${i}-ch-${j}-cancel`, 'Cancelled (D-1)',       ch.cancelled,             ch.booked, 'red',   pct(ch.cancelled,             ch.booked), [], `node-reg-${i}-ch-${j}-booked`);
      col7 += makeNode(`node-reg-${i}-ch-${j}-abort`,  'Aborted on Day',        ch.aborted,               ch.booked, 'amber', pct(ch.aborted,               ch.booked), [], `node-reg-${i}-ch-${j}-booked`);
    });
  });

  // Summary bar — mirrors KPI card funnel
  const summaryHtml = `
    <div class="decomp-summary">
      <div class="dsum-step"><span class="dsum-label">Job Requests</span><strong class="dsum-val">${fmt(totalRequests)}</strong></div>
      <span class="dsum-arrow">→</span>
      <div class="dsum-step"><span class="dsum-label">Loaded</span><strong class="dsum-val">${fmt(loaded)}</strong><span class="dsum-rate dsum-rate--blue">${pct(loaded, totalRequests)}</span></div>
      <span class="dsum-arrow">→</span>
      <div class="dsum-step"><span class="dsum-label">Contacted</span><strong class="dsum-val">${fmt(contacted)}</strong><span class="dsum-rate dsum-rate--blue">${pct(contacted, loaded)}</span></div>
      <span class="dsum-arrow">→</span>
      <div class="dsum-step"><span class="dsum-label">Booked</span><strong class="dsum-val">${fmt(booked)}</strong><span class="dsum-rate dsum-rate--blue">${pct(booked, contacted)}</span></div>
      <span class="dsum-arrow">→</span>
      <div class="dsum-step"><span class="dsum-label">Executed</span><strong class="dsum-val">${fmt(totalExecuted)}</strong><span class="dsum-rate dsum-rate--green">${pct(totalExecuted, booked)}</span></div>
      <div class="dsum-sep"></div>
      <div class="dsum-step"><span class="dsum-label">Cancelled</span><strong class="dsum-val dsum-val--red">${fmt(totalCancelled)}</strong><span class="dsum-rate dsum-rate--red">${pct(totalCancelled, booked)}</span></div>
      <div class="dsum-step"><span class="dsum-label">Aborted</span><strong class="dsum-val dsum-val--red">${fmt(totalAborted)}</strong><span class="dsum-rate dsum-rate--red">${pct(totalAborted, booked)}</span></div>
      <div class="dsum-sep"></div>
      <div class="dsum-e2e"><span class="dsum-label">End-to-End</span><strong class="dsum-e2e-val">${pct(totalExecuted, totalRequests)}</strong><span class="dsum-label">Requests → Executed</span></div>
    </div>`;

  container.innerHTML = summaryHtml + `
    <div class="decomp-cols-area" id="decomp-cols-area">
      <svg class="decomp-svg-layer" id="decomp-lines"></svg>

      <div class="decomp-col" id="col-1">
        <div class="decomp-stage-hdr decomp-stage-hdr--blue">Job Requests</div>
        ${makeNode('node-total', 'Total Job Requests', totalRequests, totalRequests, 'blue', '100%', ['node-loaded', 'node-not-loaded'])}
      </div>

      <div class="decomp-col" id="col-2">
        <div class="decomp-stage-hdr decomp-stage-hdr--blue">Dialler Load</div>
        ${makeNode('node-loaded',     'Loaded Into Dialler', loaded,    totalRequests, 'blue', pct(loaded,    totalRequests), regNodeIds, 'node-total')}
        ${makeNode('node-not-loaded', 'Not Loaded',          notLoaded, totalRequests, 'red',  pct(notLoaded, totalRequests), [],         'node-total')}
      </div>

      <div class="decomp-col" id="col-3">
        <div class="decomp-stage-hdr decomp-stage-hdr--green">Region Split</div>
        ${col3}
      </div>

      <div class="decomp-col" id="col-4">
        <div class="decomp-stage-hdr decomp-stage-hdr--blue">Contact Outcome</div>
        ${col4}
      </div>

      <div class="decomp-col" id="col-5">
        <div class="decomp-stage-hdr decomp-stage-hdr--blue">Channel Split</div>
        ${col5}
      </div>

      <div class="decomp-col" id="col-6">
        <div class="decomp-stage-hdr decomp-stage-hdr--blue">Appointments Booked</div>
        ${col6}
      </div>

      <div class="decomp-col" id="col-7">
        <div class="decomp-stage-hdr decomp-stage-hdr--mixed">Outcomes</div>
        ${col7}
      </div>
    </div>`;

  const colsArea = document.getElementById('decomp-cols-area');
  if (colsArea) colsArea.addEventListener('scroll', drawDecompLines, { passive: true });
  setTimeout(() => drawDecompLines(), 50);
}

window.toggleDecompNode = function(id) {
  const node = document.getElementById(id);
  if (!node) return;
  const childrenAttr = node.getAttribute('data-children');
  if (!childrenAttr) return;

  const childrenIds = childrenAttr.split(',');
  const firstChild = document.getElementById(childrenIds[0]);
  if (!firstChild) return;

  const isExpanded = firstChild.style.display !== 'none';

  if (isExpanded) {
    hideDescendants(id);
    node.classList.remove('expanded');
  } else {
    // Accordion: collapse any expanded sibling (and its descendants) first
    const parentId = node.getAttribute('data-parent');
    if (parentId) {
      const parentNode = document.getElementById(parentId);
      if (parentNode) {
        const siblingsAttr = parentNode.getAttribute('data-children');
        if (siblingsAttr) {
          siblingsAttr.split(',').forEach(sibId => {
            if (sibId === id) return;
            const sib = document.getElementById(sibId);
            if (sib && sib.classList.contains('expanded')) {
              hideDescendants(sibId);
              sib.classList.remove('expanded');
            }
          });
        }
      }
    }

    // Show immediate children
    childrenIds.forEach(cid => {
      const cnode = document.getElementById(cid);
      if (cnode) cnode.style.display = 'flex';
    });
    node.classList.add('expanded');
  }

  drawDecompLines();
};

function hideDescendants(id) {
  const node = document.getElementById(id);
  if (!node) return;
  const childrenAttr = node.getAttribute('data-children');
  if (childrenAttr) {
    const childrenIds = childrenAttr.split(',');
    childrenIds.forEach(cid => {
      const cnode = document.getElementById(cid);
      if (cnode) {
        cnode.style.display = 'none';
        cnode.classList.remove('expanded');
        hideDescendants(cid);
      }
    });
  }
}

function drawDecompLines() {
  const svg      = document.getElementById('decomp-lines');
  const colsArea = document.getElementById('decomp-cols-area');
  if (!svg || !colsArea) return;

  const rectC = colsArea.getBoundingClientRect();
  svg.innerHTML = '';

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  svg.appendChild(defs);

  const colorMap = { blue: '#3b82f6', green: '#10b981', amber: '#f59e0b', red: '#ef4444' };
  let gi = 0;

  function connect(id1, id2) {
    const el1 = document.getElementById(id1);
    const el2 = document.getElementById(id2);
    if (!el1 || !el2 || el1.style.display === 'none' || el2.style.display === 'none') return;

    const r1 = el1.getBoundingClientRect();
    const r2 = el2.getBoundingClientRect();
    const x1 = r1.right  - rectC.left + colsArea.scrollLeft;
    const y1 = r1.top    + r1.height / 2 - rectC.top  + colsArea.scrollTop;
    const x2 = r2.left   - rectC.left + colsArea.scrollLeft;
    const y2 = r2.top    + r2.height / 2 - rectC.top  + colsArea.scrollTop;

    const c1  = colorMap[el1.dataset.color] || '#64748b';
    const c2  = colorMap[el2.dataset.color] || c1;
    const gid = `dg${gi++}`;

    const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    grad.setAttribute('id', gid);
    grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%');
    grad.setAttribute('x2', '100%'); grad.setAttribute('y2', '0%');
    grad.innerHTML = `<stop offset="0%" stop-color="${c1}" stop-opacity="0.6"/>
                      <stop offset="100%" stop-color="${c2}" stop-opacity="0.6"/>`;
    defs.appendChild(grad);

    const mx   = x1 + (x2 - x1) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
    path.setAttribute('stroke', `url(#${gid})`);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
  }

  document.querySelectorAll('.decomp-node').forEach(node => {
    if (node.style.display !== 'none') {
      const ch = node.getAttribute('data-children');
      if (ch) ch.split(',').forEach(cid => connect(node.id, cid));
    }
  });
}


window.addEventListener('resize', () => {
  if (document.getElementById('decomp-cols-area')) drawDecompLines();
});
