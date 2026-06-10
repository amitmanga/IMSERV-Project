/* EXL — Module 5: Financial Scenario Planning */

async function loadFinancialDashboard() {
  const region = EXL.getRegion();
  const year   = EXL.getYear();
  const qs     = EXL.getGlobalQs();
  const loadingTargets = ['fin-monthly-chart', 'fin-jobtype-chart', 'forecast-profit-chart'];
  EXL.setLoading(loadingTargets, true);

  try {
    const [kpis, forecast] = await Promise.all([
      EXL.apiFetch('/api/financial/kpis' + qs),
      EXL.apiFetch('/api/financial/forecast-profitability' + qs),
    ]);

    if (kpis)     renderFinancialKPIs(kpis);
    if (kpis)     renderMonthlyChart(kpis.monthly_trend || []);
    if (kpis)     renderJobTypeChart(kpis.job_type_breakdown || []);
    if (kpis)     hydrateScenarioDefaults(kpis);
    if (forecast) renderForecastProfit(forecast);
  } finally {
    EXL.setLoading(loadingTargets, false);
  }
}

function hydrateScenarioDefaults(kpis) {
  const selectedMonth = document.getElementById('global-month');
  const periodLabel = selectedMonth?.value
    ? selectedMonth.options[selectedMonth.selectedIndex]?.textContent
    : 'Forecast Period';
  const fields = {
    'sc-name': `Base Case ${periodLabel}`,
    'sc-volume': Math.round(kpis.total_requests || 0),
    'sc-completion': Math.round(kpis.completion_rate || 68),
    'sc-cancel': Math.round(kpis.cancellation_rate || 15),
    'sc-abort': Math.round(kpis.abort_rate || 8),
  };

  Object.entries(fields).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el && value !== 0) el.value = value;
  });
  updateRangeVal('sc-completion', 'sc-completion-val', '%');
  updateRangeVal('sc-cancel', 'sc-cancel-val', '%');
  updateRangeVal('sc-abort', 'sc-abort-val', '%');
}

function renderFinancialKPIs(kpis) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('fin-kpi-revenue',    EXL.fmt.gbpM(kpis.total_revenue_gbp));
  set('fin-kpi-cost',       EXL.fmt.gbpM(kpis.total_cost_gbp));
  set('fin-kpi-margin',     EXL.fmt.gbpM(kpis.total_margin_gbp));
  set('fin-kpi-margin-pct', EXL.fmt.pct(kpis.margin_pct));
  set('fin-kpi-cpp',        EXL.fmt.gbp(kpis.avg_cost_per_completion));

  const mpCard = document.getElementById('fin-kpi-margin-pct')?.closest('.kpi-card');
  if (mpCard) {
    mpCard.className = `kpi-card ${kpis.margin_pct > 20 ? 'ok' : (kpis.margin_pct > 12 ? 'warn' : 'crit')}`;
  }
}

function renderMonthlyChart(trend) {
  const ctx = document.getElementById('fin-monthly-chart');
  if (!ctx || !trend.length) return;
  const labels = trend.map(t => t.month.substring(0, 7));
  EXL.destroyChart('fin-monthly');
  EXL.registerChart('fin-monthly', new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Meter Delivery Revenue GBP', data: trend.map(t => t.revenue),  backgroundColor: 'rgba(0,80,113,0.55)', yAxisID: 'y'  },
        { label: 'Meter Delivery Cost GBP',    data: trend.map(t => t.cost),     backgroundColor: 'rgba(217,48,37,0.45)', yAxisID: 'y'  },
        { label: 'Margin %',   data: trend.map(t => t.margin_pct),borderColor: EXL.colors.accent, type: 'line', fill: false, tension: 0.4, pointRadius: 0, yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: EXL.chartDefaults.plugins,
      scales: {
        ...EXL.chartDefaults.scales,
        y:  { ...EXL.chartDefaults.scales.y, ticks: { ...EXL.chartDefaults.scales.y.ticks, callback: v => '£' + (v/1000).toFixed(0) + 'k' } },
        y1: { ...EXL.chartDefaults.scales.y, position: 'right', grid: { display: false },
               ticks: { ...EXL.chartDefaults.scales.y.ticks, callback: v => v + '%' } },
      },
    },
  }));
}

function renderJobTypeChart(breakdown) {
  const ctx = document.getElementById('fin-jobtype-chart');
  if (!ctx || !breakdown.length) return;
  const labels = breakdown.map(j => j.job_type.replace('_', ' '));
  EXL.destroyChart('fin-jobtype');
  EXL.registerChart('fin-jobtype', new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Revenue GBP', data: breakdown.map(j => j.revenue), backgroundColor: 'rgba(0,80,113,0.6)'   },
        { label: 'Cost GBP',    data: breakdown.map(j => j.cost),    backgroundColor: 'rgba(217,48,37,0.45)' },
        { label: 'Margin GBP',  data: breakdown.map(j => j.margin),  backgroundColor: 'rgba(0,80,113,0.55)'},
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: EXL.chartDefaults.plugins,
      scales: { ...EXL.chartDefaults.scales },
    },
  }));
}

function renderForecastProfit(data) {
  const ctx = document.getElementById('forecast-profit-chart');
  if (!ctx || !data.monthly_forecast?.length) return;
  const mf = data.monthly_forecast;

  // Dynamic y1 range — tight padding around actual margin values so fluctuations are visible
  const margins = mf.map(m => m.margin_pct).filter(v => v != null);
  const marginMin = Math.min(...margins);
  const marginMax = Math.max(...margins);
  const pad = Math.max((marginMax - marginMin) * 0.5, 1.0);  // at least ±1% padding
  const y1Min = Math.floor((marginMin - pad) * 10) / 10;
  const y1Max = Math.ceil((marginMax  + pad) * 10) / 10;

  EXL.destroyChart('forecast-profit');
  EXL.registerChart('forecast-profit', new Chart(ctx, {
    type: 'line',
    data: {
      labels: mf.map(m => m.month),
      datasets: [
        { label: 'Forecast Revenue GBP', data: mf.map(m => m.revenue), borderColor: EXL.colors.ok,      fill: false, tension: 0.4, pointRadius: 0, borderDash: [5,3] },
        { label: 'Forecast Cost GBP',    data: mf.map(m => m.cost),    borderColor: EXL.colors.crit,    fill: false, tension: 0.4, pointRadius: 0, borderDash: [5,3] },
        { label: 'Forecast Margin %',   data: mf.map(m => m.margin_pct), borderColor: EXL.colors.accent, fill: false, tension: 0.4, pointRadius: 3, yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { ...EXL.chartDefaults.plugins },
      scales: {
        ...EXL.chartDefaults.scales,
        y:  { ...EXL.chartDefaults.scales.y, ticks: { ...EXL.chartDefaults.scales.y.ticks, callback: v => '£' + (v/1000).toFixed(0) + 'k' } },
        y1: { ...EXL.chartDefaults.scales.y, position: 'right', grid: { display: false },
              min: y1Min, max: y1Max,
              ticks: { ...EXL.chartDefaults.scales.y.ticks, callback: v => v.toFixed(1) + '%' } },
      },
    },
  }));
}

function updateRangeVal(rangeId, valId, suffix) {
  const range = document.getElementById(rangeId);
  const valEl = document.getElementById(valId);
  if (range && valEl) valEl.textContent = range.value + (suffix || '');
}

async function runScenario() {
  const payload = {
    scenario_name:          document.getElementById('sc-name')?.value      || 'Scenario',
    job_volume:             parseInt(document.getElementById('sc-volume')?.value || 85000),
    completion_rate_pct:    parseFloat(document.getElementById('sc-completion')?.value || 68),
    cancel_rate_pct:        parseFloat(document.getElementById('sc-cancel')?.value || 15),
    abort_rate_pct:         parseFloat(document.getElementById('sc-abort')?.value || 8),
    revenue_uplift_pct:     parseFloat(document.getElementById('sc-revenue-uplift')?.value || 0),
    cost_uplift_pct:        parseFloat(document.getElementById('sc-cost-uplift')?.value || 0),
    engineer_count:         parseInt(document.getElementById('sc-engineers')?.value || 300),
    productivity_jobs_per_day: 4.0,
    region_code: EXL.getRegion() || null,
  };

  const panel = document.getElementById('scenario-results');
  if (panel) panel.style.display = 'block';
  EXL.setLoading('waterfall-chart', true);

  try {
    const resp = await fetch('/api/financial/scenario', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) return;
    const data = await resp.json();
    renderScenarioResults(data);
  } finally {
    EXL.setLoading('waterfall-chart', false);
  }
}

function renderScenarioResults(data) {
  const panel = document.getElementById('scenario-results');
  if (panel) panel.style.display = 'block';

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const title = document.getElementById('sc-result-title');
  if (title) {
    title.removeAttribute('data-icon-ready');
    title.textContent = `Appointment Scenario: ${data.scenario_name}`;
    EXL.hydrateIcons(title.parentElement || document);
  }
  set('sc-res-revenue',    EXL.fmt.gbpM(data.revenue_gbp));
  set('sc-res-cost',       EXL.fmt.gbpM(data.total_cost_gbp));
  set('sc-res-margin',     EXL.fmt.gbpM(data.margin_gbp));
  set('sc-res-margin-pct', EXL.fmt.pct(data.margin_pct));
  set('sc-res-cpp',        EXL.fmt.gbp(data.cost_per_completion));
  set('sc-res-capacity',   data.capacity_rag);

  // Pricing & Cost Assumptions
  renderScenarioAssumptions(data);

  // Waterfall chart
  const ctx = document.getElementById('waterfall-chart');
  if (ctx && data.waterfall) {
    const wf = data.waterfall;
    const colors = wf.map(b => b.type === 'base' ? 'rgba(0,80,113,0.7)' : (b.type === 'cost' ? 'rgba(217,48,37,0.65)' : (b.value >= 0 ? 'rgba(0,80,113,0.65)' : 'rgba(217,48,37,0.5)')));
    EXL.destroyChart('waterfall');
    EXL.registerChart('waterfall', new Chart(ctx, {
      type: 'bar',
      data: {
        labels: wf.map(b => b.label),
        datasets: [{ data: wf.map(b => Math.abs(b.value)), backgroundColor: colors }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { ...EXL.chartDefaults.plugins, legend: { display: false } },
        scales: {
          ...EXL.chartDefaults.scales,
          y: { ...EXL.chartDefaults.scales.y, ticks: { ...EXL.chartDefaults.scales.y.ticks, callback: v => '£' + (v/1000).toFixed(0) + 'k' } },
        },
      },
    }));
  }
}

function renderScenarioAssumptions(data) {
  const panel = document.getElementById('sc-assumptions');
  if (!panel || !data.job_type_contributions) return;
  panel.style.display = 'block';

  const fmt   = EXL.fmt;
  const contribs = data.job_type_contributions;
  const assumptions = data.assumptions || {};

  // ── Revenue breakdown table ─────────────────────────────────────────────────
  const revTbody = document.querySelector('#sc-revenue-breakdown tbody');
  const revTfoot = document.querySelector('#sc-revenue-breakdown tfoot');
  if (revTbody) {
    revTbody.innerHTML = contribs.map(c => `
      <tr>
        <td><span class="job-type-badge">${c.job_type.replace('_',' ')}</span></td>
        <td>${c.weight_pct}%</td>
        <td>${c.jobs.toLocaleString()}</td>
        <td>${fmt.gbp(c.revenue_per_job)}</td>
        <td class="text-right text-ok"><strong>${fmt.gbpM(c.revenue)}</strong></td>
      </tr>`).join('');
  }
  if (revTfoot) {
    const uplift = assumptions.revenue_uplift_pct !== 0
      ? ` <span class="uplift-badge">+${assumptions.revenue_uplift_pct}% uplift applied</span>` : '';
    revTfoot.innerHTML = `<tr class="assumptions-total-row">
      <td colspan="4"><strong>Total Revenue</strong>${uplift}</td>
      <td class="text-right"><strong>${fmt.gbpM(data.revenue_gbp)}</strong></td>
    </tr>`;
  }

  // ── Cost breakdown table ────────────────────────────────────────────────────
  const costTbody = document.querySelector('#sc-cost-breakdown tbody');
  const costTfoot = document.querySelector('#sc-cost-breakdown tfoot');
  if (costTbody) {
    const rows = contribs.map(c => `
      <tr>
        <td><span class="job-type-badge">${c.job_type.replace('_',' ')}</span></td>
        <td>${c.jobs.toLocaleString()}</td>
        <td>${fmt.gbp(c.cost_per_job)}</td>
        <td class="text-right"><strong>${fmt.gbpM(c.direct_cost)}</strong></td>
      </tr>`);
    rows.push(`
      <tr class="assumptions-abort-row">
        <td><span class="job-type-badge abort">Same-Day Appointment Aborts</span></td>
        <td>${(data.aborts || 0).toLocaleString()}</td>
        <td>${fmt.gbp(assumptions.abort_cost_per_job || 38)}</td>
        <td class="text-right"><strong>${fmt.gbpM(data.abort_cost_total)}</strong></td>
      </tr>`);
    costTbody.innerHTML = rows.join('');
  }
  if (costTfoot) {
    const uplift = assumptions.cost_uplift_pct !== 0
      ? ` <span class="uplift-badge">+${assumptions.cost_uplift_pct}% uplift applied</span>` : '';
    costTfoot.innerHTML = `
      <tr class="assumptions-subtotal-row">
        <td colspan="3">Direct Cost subtotal${uplift}</td>
        <td class="text-right">${fmt.gbpM(data.direct_cost_gbp)}</td>
      </tr>
      <tr class="assumptions-subtotal-row">
        <td colspan="3">Overhead (${assumptions.overhead_pct || 22}% on direct cost)</td>
        <td class="text-right">${fmt.gbpM(data.overhead_gbp)}</td>
      </tr>
      <tr class="assumptions-total-row">
        <td colspan="3"><strong>Total Cost</strong></td>
        <td class="text-right"><strong>${fmt.gbpM(data.total_cost_gbp)}</strong></td>
      </tr>`;
  }

  // ── Formula note ────────────────────────────────────────────────────────────
  const note = document.getElementById('sc-formula-note');
  if (note) {
    note.innerHTML =
      `<strong>Formula:</strong> &nbsp;
       Revenue = executed appointments × rate/executed appointment &nbsp;·&nbsp;
       Total Cost = (direct cost + same-day abort cost) × 1.${assumptions.overhead_pct || 22} overhead &nbsp;·&nbsp;
       Margin = Revenue − Total Cost &nbsp;·&nbsp;
       Cost/Executed Appointment = Total Cost ÷ ${(data.completions || 0).toLocaleString()} executed appointments`;
  }
}

function resetScenario() {
  const defaults = { 'sc-completion': 68, 'sc-cancel': 15, 'sc-abort': 8, 'sc-revenue-uplift': 0, 'sc-cost-uplift': 0 };
  Object.entries(defaults).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });
  updateRangeVal('sc-completion', 'sc-completion-val', '%');
  updateRangeVal('sc-cancel',     'sc-cancel-val',     '%');
  updateRangeVal('sc-abort',      'sc-abort-val',      '%');
  updateRangeVal('sc-revenue-uplift', 'sc-rev-val',    '%');
  updateRangeVal('sc-cost-uplift', 'sc-cost-val',      '%');

  const panel = document.getElementById('scenario-results');
  if (panel) panel.style.display = 'none';
  const assumptions = document.getElementById('sc-assumptions');
  if (assumptions) assumptions.style.display = 'none';
}
