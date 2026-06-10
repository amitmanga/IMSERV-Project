/* EXL — Module 2: Contact Centre Forecasting */

let _forecastChart = null;
let _activeForecastTab = 'forecast';
let _lastForecastData = null;
let _activeForecastModel = '';
let _forecastPlanningRates = { contactToVisitRate: 0, abandonRate: 0 };
const _forecastTabLoadKeys = new Map();

function getForecastTabLoadKey(tabName = _activeForecastTab) {
  const region = EXL.getRegion();
  const year = EXL.getYear();
  const channel = tabName === 'forecast'
    ? (document.getElementById('forecast-channel-filter')?.value || '')
    : '';
  return `${tabName}|${region}|${year}|${channel}`;
}

function invalidateForecastLoadState() {
  _forecastTabLoadKeys.clear();
}

async function loadForecastingDashboard(force = false) {
  const region = EXL.getRegion();
  const planningQs = EXL.getGlobalQs({ year: 2025 });
  configureForecastPlanningCards();
  EXL.setLoading([
    'forecast-chart',
    'model-accuracy-body',
    'model-comparison-chart',
  ], true);

  try {
    const [planningKpis, kpis, funnel] = await Promise.all([
      EXL.apiFetch('/api/forecasting/planning-target-kpis' + planningQs),
      EXL.apiFetch('/api/forecasting/channel-kpis' + planningQs),
      EXL.apiFetch('/api/forecasting/funnel' + planningQs),
    ]);

    if (planningKpis) renderForecastPlanningKPIs(planningKpis);
    if (kpis) storeForecastPlanningRates(kpis, funnel);

    await loadActiveForecastTabData(false, force);
  } finally {
    EXL.setLoading([
      'forecast-chart',
      'model-accuracy-body',
      'model-comparison-chart',
    ], false);
  }
}

function setForecastKPI(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function configureForecastPlanningCards() {
  const cards = [
    { oldId: 'fc-kpi-volume', tone: 'info', label: '2025 Accuracy', valueId: 'fc-kpi-accuracy', deltaId: 'fc-kpi-accuracy-delta' },
    { oldId: 'fc-kpi-bookings', tone: 'ok', label: '2025 Total Visits vs Target', valueId: 'fc-kpi-visits', deltaId: 'fc-kpi-visits-delta' },
    { oldId: 'fc-kpi-conversion', tone: 'ok', label: '2025 Success Rate vs Target', valueId: 'fc-kpi-success', deltaId: 'fc-kpi-success-delta' },
    { oldId: 'fc-kpi-abandon', tone: 'warn', label: '2025 Fallout Rate vs Target', valueId: 'fc-kpi-fallout', deltaId: 'fc-kpi-fallout-delta' },
  ];

  cards.forEach(spec => {
    if (document.getElementById(spec.valueId)) return;
    const currentValue = document.getElementById(spec.oldId);
    const card = currentValue?.closest('.kpi-card');
    if (!card) return;
    card.className = `kpi-card ${spec.tone}`;
    card.innerHTML = `
      <div class="kpi-label">${spec.label}</div>
      <div class="kpi-value" id="${spec.valueId}">--</div>
      <div class="kpi-delta neu" id="${spec.deltaId}">Target --</div>
      <div class="kpi-icon"></div>
    `;
  });

  EXL.hydrateIcons?.(document.getElementById('forecast-kpis') || document);
}

function setForecastDelta(id, text, tone = 'neu') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `kpi-delta ${tone}`;
}

function setForecastCardTone(valueId, tone) {
  const card = document.getElementById(valueId)?.closest('.kpi-card');
  if (!card) return;
  card.className = `kpi-card ${tone}`;
}

function renderForecastPlanningKPIs(kpis) {
  configureForecastPlanningCards();

  const accuracy = Number(kpis.daily_accuracy_pct ?? kpis.visit_target_accuracy_pct) || 0;
  const dailyMape = Number(kpis.daily_mape) || 0;
  const dailyModel = kpis.daily_accuracy_model || 'Daily backtest';
  const visits = Number(kpis.total_visits) || 0;
  const visitTarget = Number(kpis.total_visits_target) || 0;
  const visitDelta = Number(kpis.total_visits_delta) || 0;
  const success = Number(kpis.success_rate) || 0;
  const successTarget = Number(kpis.success_rate_target) || 0;
  const successDelta = Number(kpis.success_rate_delta) || 0;
  const fallout = Number(kpis.fallout_rate) || 0;
  const falloutTarget = Number(kpis.fallout_rate_target) || 0;
  const falloutDelta = Number(kpis.fallout_rate_delta) || 0;
  const accuracyTone = accuracy > 85 ? 'pos' : (accuracy >= 75 ? 'neu' : 'neg');
  const accuracyCardTone = accuracy > 85 ? 'ok' : (accuracy >= 75 ? 'warn' : 'crit');
  const signedNumber = (value) => `${value >= 0 ? '+' : ''}${EXL.fmt.num(value)}`;
  const signedRateGap = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;

  setForecastKPI('fc-kpi-accuracy', EXL.fmt.pct(accuracy));
  setForecastDelta('fc-kpi-accuracy-delta', `${dailyModel} MAPE ${dailyMape.toFixed(2)}%`, accuracyTone);
  setForecastCardTone('fc-kpi-accuracy', accuracyCardTone);

  const visitTone = visitDelta >= 0 ? 'pos' : (visitTarget && Math.abs(visitDelta) <= visitTarget * 0.05 ? 'neu' : 'neg');
  setForecastKPI('fc-kpi-visits', signedNumber(visitDelta));
  setForecastDelta('fc-kpi-visits-delta', `${EXL.fmt.num(visits)} actual vs ${EXL.fmt.num(visitTarget)} target`, visitTone);
  setForecastCardTone('fc-kpi-visits', visitTone === 'pos' ? 'ok' : (visitTone === 'neu' ? 'warn' : 'crit'));

  const successTone = successDelta >= 0 ? 'pos' : (successDelta >= -2 ? 'neu' : 'neg');
  setForecastKPI('fc-kpi-success', signedRateGap(successDelta));
  setForecastDelta('fc-kpi-success-delta', `${EXL.fmt.pct(success)} actual vs ${EXL.fmt.pct(successTarget)} target`, successTone);
  setForecastCardTone('fc-kpi-success', successTone === 'pos' ? 'ok' : (successTone === 'neu' ? 'warn' : 'crit'));

  const falloutTone = falloutDelta <= 0 ? 'pos' : (falloutDelta <= 2 ? 'neu' : 'neg');
  setForecastKPI('fc-kpi-fallout', signedRateGap(falloutDelta));
  setForecastDelta('fc-kpi-fallout-delta', `${EXL.fmt.pct(fallout)} actual vs ${EXL.fmt.pct(falloutTarget)} target`, falloutTone);
  setForecastCardTone('fc-kpi-fallout', falloutTone === 'pos' ? 'ok' : (falloutTone === 'neu' ? 'warn' : 'crit'));
}

function storeForecastPlanningRates(kpis, funnel) {
  const f = funnel?.funnel || {};
  const visits = f.visits ?? Math.max((f.bookings ?? kpis.total_bookings ?? 0) - (f.cancellations ?? 0), 0);
  const contactToVisitRate = kpis.total_volume ? (visits / kpis.total_volume) * 100 : kpis.conversion_rate;
  _forecastPlanningRates = {
    contactToVisitRate: Number(contactToVisitRate) || 0,
    abandonRate: Number(kpis.abandon_rate) || 0,
  };
}

function renderForecastKPIs(data, forecastValues) {
  const values = forecastValues || [];
  const forecastContacts = Math.round(values.reduce((sum, value) => sum + (Number(value) || 0), 0));
  const visitRate = _forecastPlanningRates.contactToVisitRate;
  const projectedVisits = Math.round(forecastContacts * visitRate / 100);

  setForecastKPI('fc-kpi-volume', EXL.fmt.num(forecastContacts));
  setForecastKPI('fc-kpi-bookings', EXL.fmt.num(projectedVisits));
  setForecastKPI('fc-kpi-conversion', EXL.fmt.pct(visitRate));
  setForecastKPI('fc-kpi-abandon', EXL.fmt.pct(_forecastPlanningRates.abandonRate));
}

function renderChannelBreakdown(kpis) {
  const channels = kpis.channel_breakdown || [];

  // Doughnut chart
  const ctx = document.getElementById('channel-breakdown-chart');
  if (ctx && channels.length) {
    const colours = ['#FB4E0B','#004EFF','#A100FF','#005071','#808080','#62676F'];
    EXL.destroyChart('channel-breakdown');
    EXL.registerChart('channel-breakdown', new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: channels.map(c => c.channel),
        datasets: [{
          data: channels.map(c => c.volume),
          backgroundColor: colours.slice(0, channels.length),
          borderColor: '#FFFFFF',
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          ...EXL.chartDefaults.plugins,
          legend: { position: 'right', labels: { color: '#62676F', font: { size: 11 }, padding: 10 } },
        },
      },
    }));
  }

  // Table
  const tbody = document.getElementById('channel-table-body');
  if (tbody) {
    tbody.innerHTML = channels.map(c => `
      <tr>
        <td><strong>${c.channel}</strong></td>
        <td>${EXL.fmt.num(c.volume)}</td>
        <td>${EXL.fmt.num(c.bookings)}</td>
        <td><strong class="text-ok">${EXL.fmt.pct(c.conversion_pct)}</strong></td>
        <td><span class="text-warn">${EXL.fmt.pct(c.abandon_pct)}</span></td>
      </tr>
    `).join('');
  }
}

async function loadForecast() {
  const channel = document.getElementById('forecast-channel-filter')?.value || '';
  const qs = EXL.getGlobalQs({ channel, weeks: 52 });
  EXL.setLoading(['forecast-chart', 'model-accuracy-body', 'model-comparison-chart'], true);

  try {
    const data = await EXL.apiFetch('/api/forecasting/forecast' + qs);
    if (!data) return;
    _lastForecastData = data;
    _forecastTabLoadKeys.set('forecast', getForecastTabLoadKey('forecast'));

    renderForecastChart(data);
    renderModelAccuracy(data.model_accuracy || {});
    renderModelComparison(data);
  } finally {
    EXL.setLoading(['forecast-chart', 'model-accuracy-body', 'model-comparison-chart'], false);
  }
}

function setForecastModel(model, el) {
  _activeForecastModel = model || '';
  document.querySelectorAll('#forecast-model-toggle button').forEach(btn => btn.classList.remove('active'));
  if (el) el.classList.add('active');
  onForecastModelChange();
}

function onForecastModelChange() {
  EXL.setLoading('forecast-chart', true);
  if (_lastForecastData) {
    renderForecastChart(_lastForecastData);
    requestAnimationFrame(() => EXL.setLoading('forecast-chart', false));
  } else {
    loadForecast();
  }
}

function renderForecastModelToggle(modelForecasts) {
  const toggle = document.getElementById('forecast-model-toggle');
  if (!toggle) return;

  if (_activeForecastModel && !modelForecasts[_activeForecastModel]) {
    _activeForecastModel = '';
  }

  const models = [''].concat(Object.keys(modelForecasts || {}));
  toggle.innerHTML = models.map(model => {
    const label = model || 'Ensemble P50';
    const active = model === _activeForecastModel ? ' active' : '';
    return `<button type="button" class="${active}" data-model="${model}" onclick="setForecastModel('${model}', this)">${label}</button>`;
  }).join('');
}

function updateForecastTitle(activeModel) {
  const title = document.getElementById('forecast-chart-title');
  if (!title) return;
  const modelLabel = activeModel ? activeModel : 'Ensemble P50';
  title.textContent = `52-Week Smart Meter Contact Attempt Forecast - 2026 ${modelLabel}`;
  title.removeAttribute('data-icon-ready');
  EXL.hydrateIcons?.(title.parentElement || title);
}

function renderForecastChart(data) {
  const ctx = document.getElementById('forecast-chart');
  if (!ctx) return;

  const modelForecasts = data.model_forecasts || {};
  const modelColors = { Prophet: '#005071', ARIMA: '#004EFF', XGBoost: '#FB4E0B', LightGBM: '#62676F' };
  renderForecastModelToggle(modelForecasts);
  const activeModel = _activeForecastModel;
  updateForecastTitle(activeModel);
  const centralForecast = activeModel && modelForecasts[activeModel]
    ? modelForecasts[activeModel].slice(0, data.labels.length)
    : data.p50;
  const centralLabel = activeModel ? `${activeModel} Contact Attempt Forecast` : 'P50 Contact Attempt Forecast';
  const centralColor = activeModel ? (modelColors[activeModel] || EXL.colors.accent) : EXL.colors.accent;
  const isLightTheme = EXL.getTheme?.() !== 'dark';
  const bandBorderColor = isLightTheme ? 'rgba(178,128,0,0.72)' : 'rgba(251,78,11,0.5)';
  const bandFillColor = isLightTheme ? 'rgba(178,128,0,0.10)' : 'rgba(251,78,11,0.06)';

  const horizon = Math.min(52, data.labels?.length || centralForecast.length || 0);
  const weekLabels = Array.from({ length: horizon }, (_, i) => `W${i + 1}`);
  const actual2025 = (data.history_values || []).slice(0, horizon);
  const forecast2026 = centralForecast.slice(0, horizon);
  renderForecastKPIs(data, forecast2026);
  const p10Band = activeModel
    ? forecast2026.map(v => Math.round(v * 0.8))
    : (data.p10 || []).slice(0, horizon);
  const p90Band = activeModel
    ? forecast2026.map(v => Math.round(v * 1.2))
    : (data.p90 || []).slice(0, horizon);

  EXL.destroyChart?.('forecast');
  EXL.registerChart('forecast', new Chart(ctx, {
    type: 'line',
    data: {
      labels: weekLabels,
      datasets: [
        {
          label: '2025 Actual Contact Attempts',
          data: actual2025,
          borderColor: '#004EFF',
          backgroundColor: 'rgba(74,197,187,0.08)',
          fill: false,
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 2.5,
        },
        {
          label: activeModel ? `2026 ${activeModel} Contact Attempt Forecast` : '2026 Ensemble Contact Attempt Forecast (P50)',
          data: forecast2026,
          borderColor: centralColor,
          backgroundColor: 'rgba(0,78,255,0.10)',
          fill: false,
          tension: 0.4,
          pointRadius: 0,
          borderWidth: activeModel ? 2.75 : 2.5,
          borderDash: activeModel ? [] : [6,3],
        },
        {
          label: 'P90 Optimistic',
          data: p90Band,
          borderColor: bandBorderColor,
          backgroundColor: bandFillColor,
          fill: '+1', tension: 0.4, pointRadius: 0, borderWidth: 1, borderDash: [3,3],
        },
        {
          label: 'P10 Conservative',
          data: p10Band,
          borderColor: bandBorderColor,
          backgroundColor: bandFillColor,
          fill: false, tension: 0.4, pointRadius: 0, borderWidth: 1, borderDash: [3,3],
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: EXL.chartDefaults.plugins,
      scales: {
        ...EXL.chartDefaults.scales,
        x: { ...EXL.chartDefaults.scales.x, ticks: { ...EXL.chartDefaults.scales.x.ticks, maxTicksLimit: 13 } },
      },
    },
  }));
}

function renderModelAccuracy(accuracy) {
  const tbody = document.getElementById('model-accuracy-body');
  if (!tbody) return;
  const models = Object.keys(accuracy);
  if (!models.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted">No accuracy data</td></tr>';
    return;
  }
  tbody.innerHTML = models.map(m => {
    const d = accuracy[m];
    return `
      <tr>
        <td><strong>${m}</strong></td>
        <td>${d.mae?.toFixed(1) || '—'}</td>
        <td>${d.rmse?.toFixed(1) || '—'}</td>
        <td><span class="${d.mape < 6 ? 'text-ok' : (d.mape < 10 ? 'text-warn' : 'text-crit')}">${d.mape?.toFixed(2) || '—'}%</span></td>
      </tr>
    `;
  }).join('');
}

function renderModelAccuracyVisual(accuracy) {
  const container = document.getElementById('model-accuracy-body');
  if (!container) return false;
  const rows = Object.entries(accuracy || {})
    .map(([model, d]) => ({ model, ...d }))
    .sort((a, b) => (a.mape ?? 999) - (b.mape ?? 999));

  if (!rows.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-title">No accuracy data</div></div>';
    return true;
  }

  const maxMae = Math.max(...rows.map(d => d.mae || 0), 1);
  const maxRmse = Math.max(...rows.map(d => d.rmse || 0), 1);
  container.innerHTML = rows.map((d, idx) => {
    const accuracyPct = Math.max(0, 100 - (d.mape || 0));
    const tone = accuracyPct > 85 ? 'strong' : (accuracyPct >= 75 ? 'steady' : 'risk');
    const barColor = tone === 'strong' ? '#005071' : tone === 'steady' ? '#FB4E0B' : '#D93025';
    const maePct = Math.max(4, (d.mae || 0) / maxMae * 100);
    const rmsePct = Math.max(4, (d.rmse || 0) / maxRmse * 100);
    const label = tone === 'strong' ? 'High accuracy' : tone === 'steady' ? 'Planning fit' : 'Watch variance';
    return `
      <div class="model-accuracy-row ${tone}" style="--accuracy:${accuracyPct}%; --mae:${maePct}%; --rmse:${rmsePct}%; --model-color:${barColor};">
        <div class="model-accuracy-main">
          <span class="model-rank">#${idx + 1}</span>
          <div>
            <strong>${d.model}</strong>
            <em>${label}</em>
          </div>
          <b>${accuracyPct.toFixed(1)}%</b>
        </div>
        <div class="model-accuracy-bar"><i></i></div>
        <div class="model-accuracy-metrics">
          <span>MAE <strong>${d.mae?.toFixed(1) || '-'}</strong><i class="mae"></i></span>
          <span>RMSE <strong>${d.rmse?.toFixed(1) || '-'}</strong><i class="rmse"></i></span>
          <span>MAPE <strong>${d.mape?.toFixed(2) || '-'}%</strong></span>
        </div>
      </div>
    `;
  }).join('');
  return true;
}

const _renderModelAccuracyTable = renderModelAccuracy;
renderModelAccuracy = function renderModelAccuracy(accuracy) {
  if (!renderModelAccuracyVisual(accuracy)) _renderModelAccuracyTable(accuracy);
};

function renderModelComparison(data) {
  const ctx = document.getElementById('model-comparison-chart');
  if (!ctx || !data.model_forecasts) return;
  const modelColors = { Prophet: '#005071', ARIMA: '#004EFF', XGBoost: '#FB4E0B', LightGBM: '#62676F' };
  const datasets = Object.entries(data.model_forecasts).map(([m, vals]) => ({
    label: m,
    data: vals.slice(0, 26),
    borderColor: modelColors[m] || EXL.colors.accent,
    fill: false, tension: 0.4, pointRadius: 0, borderWidth: 1.5,
  }));
  EXL.destroyChart('model-comparison');
  EXL.registerChart('model-comparison', new Chart(ctx, {
    type: 'line',
    data: { labels: data.labels.slice(0, 26), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: EXL.chartDefaults.plugins,
      scales: EXL.chartDefaults.scales,
    },
  }));
}



async function loadConversionTrend() {
  EXL.setLoading('conversion-trend-chart', true);
  const funnel = await EXL.apiFetch('/api/forecasting/funnel' + EXL.getGlobalQs());
  if (!funnel) {
    EXL.setLoading('conversion-trend-chart', false);
    return;
  }

  const ctx = document.getElementById('conversion-trend-chart');
  if (!ctx) {
    EXL.setLoading('conversion-trend-chart', false);
    return;
  }

  const trend = funnel.weekly_trend || [];
  const labels  = trend.map(t => t.week.substring(0, 10));
  const visits = trend.map(t => t.visits ?? Math.max((t.bookings || 0) - (t.cancellations || 0), 0));
  const cp = trend.map(t => t.completions);
  const cr = trend.map(t => t.completion_rate);

  EXL.destroyChart('conversion-trend');
  EXL.registerChart('conversion-trend', new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Total Visits',           data: visits, backgroundColor: 'rgba(0,80,113,0.5)',  yAxisID: 'y' },
        { label: 'Executed Successfully',  data: cp,     backgroundColor: 'rgba(0,80,113,0.5)',yAxisID: 'y' },
        { label: 'Success Rate %',         data: cr,     borderColor: EXL.colors.accent, type: 'line', fill: false, tension: 0.4, pointRadius: 0, yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: EXL.chartDefaults.plugins,
      scales: {
        ...EXL.chartDefaults.scales,
        y:  { ...EXL.chartDefaults.scales.y, position: 'left' },
        y1: { ...EXL.chartDefaults.scales.y, position: 'right', grid: { display: false },
               ticks: { ...EXL.chartDefaults.scales.y.ticks, callback: v => v + '%' } },
      },
    },
  }));
  EXL.setLoading('conversion-trend-chart', false);
}

function switchForecastTab(name, el) {
  _activeForecastTab = name;
  document.querySelectorAll('.forecast-tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('#view-forecasting .tab-item').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('#forecasting-subnav .nav-subitem').forEach(t => t.classList.remove('active'));
  const panel = document.getElementById('ftab-' + name);
  if (panel) panel.classList.add('active');
  if (el) el.classList.add('active');
  if (typeof activateSidebarSubnav === 'function') activateSidebarSubnav('forecasting', name);
  requestAnimationFrame(() => loadActiveForecastTabData());
}

function switchForecastSidebarTab(name, el) {
  if (_currentView !== 'forecasting') {
    switchView('forecasting', document.querySelector('.nav-item[data-view="forecasting"]'));
  }
  switchForecastTab(name, el);
}

function loadActiveForecastTabData(showLoading = true, force = false) {
  const key = getForecastTabLoadKey(_activeForecastTab);
  if (!force && _forecastTabLoadKeys.get(_activeForecastTab) === key) {
    return Promise.resolve();
  }
  _forecastTabLoadKeys.set(_activeForecastTab, key);

  if (_activeForecastTab === 'overview') {
    return loadForecastingOverview(showLoading);
  }
  if (_activeForecastTab === 'funnel') {
    return loadConversionTrend();
  }
  return loadForecast();
}

async function loadForecastingOverview(showLoading = true) {
  if (showLoading) EXL.setLoading('channel-breakdown-chart', true);
  try {
    const kpis = await EXL.apiFetch('/api/forecasting/channel-kpis' + EXL.getGlobalQs());
    if (kpis) renderChannelBreakdown(kpis);
    if (kpis) _forecastTabLoadKeys.set('overview', getForecastTabLoadKey('overview'));
  } finally {
    if (showLoading) EXL.setLoading('channel-breakdown-chart', false);
  }
}
