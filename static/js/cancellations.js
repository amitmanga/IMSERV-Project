/* EXL - Module 3: Appointment Fallout */

async function loadCancellationsDashboard(force = false) {
  const region = EXL.getRegion();
  const year = EXL.getYear();
  const qs = EXL.getGlobalQs();
  const loadingTargets = ['pareto-chart', 'category-chart', 'recovery-constellation-stage', 'cancel-trend-chart', 'cancel-risk-panel'];
  EXL.setLoading(loadingTargets, true);

  try {
    const dashboard = await EXL.apiFetch('/api/cancellations/dashboard' + qs, { force });
    const kpis = dashboard?.kpis;
    const rootCauses = dashboard?.root_causes;
    const rebook = dashboard?.rebooking;
    const cancelTrends = dashboard?.trends;

    if (kpis) renderCancelKPIs(kpis);
    if (rootCauses) renderParetoChart(rootCauses);
    if (rootCauses) renderCategoryChart(rootCauses);
    if (rebook) {
      renderRebooking(rebook);
      renderSupplierRebooking(rebook);
    }
    if (cancelTrends) renderCancelTrend(cancelTrends);
    await loadCancellationRisk(false, dashboard?.prediction);
    await loadFieldScorecard(force);
  } finally {
    EXL.setLoading(loadingTargets, false);
  }
}

function renderCancelKPIs(kpis) {
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  set('can-kpi-total', EXL.fmt.num(kpis.cancellations));
  set('can-kpi-rate', EXL.fmt.pct(kpis.cancel_rate_pct));
  set('can-kpi-aborts', EXL.fmt.num(kpis.aborts));
  set('can-kpi-abort-rate', EXL.fmt.pct(kpis.abort_rate_pct));
}

function cancelEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderParetoChart(data) {
  const container = document.getElementById('pareto-chart');
  if (!container) return;
  renderReasonBreakdown(container, data.cancellation_reasons || [], data.total_cancellations || 0, {
    empty: 'No D-1 appointment cancellation reasons available',
    totalLabel: 'Appointments cancelled (D-1)',
    tone: 'cancel',
  });
}

function renderCategoryChart(data) {
  const container = document.getElementById('category-chart');
  if (!container) return;
  renderReasonBreakdown(container, data.abort_reasons || [], data.total_aborts || 0, {
    empty: 'No same-day appointment abort reasons available',
    totalLabel: 'Appointments aborted on the day of visit',
    tone: 'abort',
  });
}

function renderReasonBreakdown(container, rows, total, config) {
  const top = rows.slice(0, 8);

  if (!top.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-title">${cancelEscape(config.empty)}</div></div>`;
    return;
  }

  const maxCount = Math.max(...top.map(d => d.count), 1);
  const topShare = top[0]?.pct || 0;
  const supplierColors = [
    '#5B8DEF', '#02C2B7', '#F4D25A', '#FB8281', '#A374FF', 
    '#FF9D4A', '#24D28A', '#E85B9E', '#7F8FA4', '#4A6B7C',
    '#C4A1FF', '#FF6B6B', '#48DBFB', '#1DD1A1', '#FECA57'
  ];
  
  const rowsHtml = top.map((r, idx) => {
    const influence = Math.max(3, r.count / maxCount * 100);
    
    let segmentsHtml = '';
    let combinedTooltip = '';
    if (r.suppliers && r.suppliers.length > 0) {
      combinedTooltip = r.suppliers.map(sup => `${cancelEscape(sup.name)}: ${EXL.fmt.num(sup.count)}`).join('&#10;');
      segmentsHtml = r.suppliers.map((sup, sIdx) => {
        const w = (sup.count / Math.max(r.count, 1)) * 100;
        const bg = sup.name === 'Others' ? '#bdc3c7' : supplierColors[sIdx % supplierColors.length];
        return `<span style="display: block; height: 100%; width: ${w}%; background: ${bg};"></span>`;
      }).join('');
    }

    return `
      <div class="reason-breakdown-row ${idx === 0 ? 'primary' : ''}" style="--influence:${influence}%; --delay:${idx * 45}ms;" title="${combinedTooltip}">
        <div class="cause-rank">${idx + 1}</div>
        <div class="reason-breakdown-main">
          <span>${cancelEscape(r.reason)}</span>
          <em>${cancelEscape(r.category)}</em>
          <i><b style="display: flex; background: none;">${segmentsHtml}</b></i>
        </div>
        <div class="reason-breakdown-metric">
          <strong>${EXL.fmt.num(r.count)}</strong>
          <small>${EXL.fmt.pct(r.pct)}</small>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="reason-breakdown ${config.tone}">
      <div class="reason-breakdown-total">
        <span>${cancelEscape(config.totalLabel)}</span>
        <strong>${EXL.fmt.num(total)}</strong>
        <em>${EXL.fmt.num(top.length)} reasons shown</em>
      </div>
      <div class="reason-breakdown-list">
        ${rowsHtml}
      </div>
    </div>
    <div class="cause-summary-strip">
      <div><span>Top reason</span><strong>${cancelEscape(top[0].reason)}</strong></div>
      <div><span>Top reason rate</span><strong>${EXL.fmt.pct(topShare)}</strong></div>
      <div><span>Shown volume</span><strong>${EXL.fmt.num(top.reduce((sum, r) => sum + r.count, 0))}</strong></div>
    </div>
  `;
}

function renderCancelTrend(data) {
  const container = document.getElementById('cancel-trend-chart');
  if (!container) return;

  const actuals = (data.monthly_trend || []).slice(-18);
  const forecast = (data.forecast || []).slice(0, 6);
  const all = [...actuals, ...forecast];
  if (!all.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-title">No trend data available</div></div>';
    return;
  }

  const values = all.map(t => t.cancel_rate);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(max - min, 0.1);
  const point = (v, idx, len) => {
    const x = 6 + idx * (88 / Math.max(len - 1, 1));
    const y = 86 - ((v - min) / spread) * 66;
    return { x, y };
  };
  const pathFrom = points => points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');

  const actualPoints = actuals.map((t, i) => point(t.cancel_rate, i, all.length));
  const forecastPoints = forecast.map((t, i) => point(t.cancel_rate, actuals.length + i, all.length));
  const actualPath = pathFrom(actualPoints);
  const forecastPath = pathFrom(
    forecastPoints.length && actualPoints.length
      ? [actualPoints[actualPoints.length - 1], ...forecastPoints]
      : forecastPoints
  );
  const fillPath = actualPoints.length
    ? `${actualPath} L ${actualPoints[actualPoints.length - 1].x.toFixed(2)} 92 L ${actualPoints[0].x.toFixed(2)} 92 Z`
    : '';

  const nodes = all.map((t, idx) => {
    const p = point(t.cancel_rate, idx, all.length);
    const isForecast = idx >= actuals.length;
    return `<span class="pulse-node ${isForecast ? 'forecast' : ''}" style="--x:${p.x}%; --y:${p.y}%;" title="${cancelEscape(t.month)} ${EXL.fmt.pct(t.cancel_rate)}"></span>`;
  }).join('');

  const latest = actuals[actuals.length - 1] || all[all.length - 1];
  const lastForecast = forecast[forecast.length - 1];
  const drift = lastForecast ? lastForecast.cancel_rate - latest.cancel_rate : 0;
  const driftLabel = drift < -0.2 ? 'Cooling' : (drift > 0.2 ? 'Heating' : 'Stable');

  container.innerHTML = `
    <div class="pulse-stage">
      <svg class="pulse-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        ${fillPath ? `<path class="pulse-fill" d="${fillPath}" />` : ''}
        <path class="pulse-path actual" d="${actualPath}" />
        <path class="pulse-path forecast" d="${forecastPath}" />
      </svg>
      ${nodes}
      <div class="pulse-readout">
        <span>Latest Actual</span>
        <strong>${EXL.fmt.pct(latest.cancel_rate)}</strong>
        <em>${cancelEscape(latest.month)}</em>
      </div>
      <div class="pulse-forecast-badge ${driftLabel.toLowerCase()}">
        <span>Forecast drift</span>
        <strong>${driftLabel}</strong>
        <em>${drift >= 0 ? '+' : ''}${drift.toFixed(2)} pts</em>
      </div>
    </div>
  `;
}

function renderCancelRegional(data) {
  const container = document.getElementById('cancel-regional-chart');
  if (!container || !data || !data.length) return;

  const sorted = [...data].sort((a, b) => (b.cancel_rate + b.abort_rate) - (a.cancel_rate + a.abort_rate));
  const maxLoss = Math.max(...sorted.map(r => r.cancel_rate + r.abort_rate), 1);
  const cells = sorted.map((r, idx) => {
    const loss = r.cancel_rate + r.abort_rate;
    const heat = Math.min(1, loss / maxLoss);
    const cancelDeg = Math.min(360, r.cancel_rate * 10);
    const abortDeg = Math.min(360, r.abort_rate * 10);
    return `
      <div class="region-risk-tile ${String(r.rag || 'green').toLowerCase()}" style="--heat:${heat}; --cancel:${cancelDeg}deg; --abort:${abortDeg}deg;">
        <div class="region-risk-orbit">
          <span class="region-cancel-ring"></span>
          <span class="region-abort-ring"></span>
          <strong>${cancelEscape(r.region_code)}</strong>
        </div>
        <div class="region-risk-copy">
          <span>Appointment fallout pressure</span>
          <strong>${EXL.fmt.pct(loss)}</strong>
          <em><b>${EXL.fmt.pct(r.cancel_rate)}</b> D-1 cancelled</em>
          <em><b>${EXL.fmt.pct(r.abort_rate)}</b> same-day aborted</em>
        </div>
        <small>#${idx + 1}</small>
      </div>
    `;
  }).join('');

  container.innerHTML = `<div class="regional-risk-grid">${cells}</div>`;
}

async function loadCancellationRisk(showLoading = true, providedData = null) {
  if (showLoading) EXL.setLoading('cancel-risk-panel', true);
  const data = providedData || await EXL.apiFetch('/api/cancellations/predict' + EXL.getGlobalQs());
  const panel = document.getElementById('cancel-risk-panel');
  if (!panel || !data) {
    if (showLoading) EXL.setLoading('cancel-risk-panel', false);
    return;
  }

  let gaugeColor = 'var(--ok)';
  let shadowColor = 'rgba(2, 129, 120, 0.2)';
  if (data.risk_level === 'Critical') {
    gaugeColor = 'var(--crit)';
    shadowColor = 'rgba(251, 130, 129, 0.2)';
  } else if (data.risk_level === 'High') {
    gaugeColor = 'var(--warn)';
    shadowColor = 'rgba(244, 210, 90, 0.2)';
  }

  const trendColor = data.trend_direction === 'Rising' ? 'var(--crit)' : 'var(--ok)';
  const trendIcon = data.trend_direction === 'Rising' ? 'Up' : 'Down';

  const driversHtml = (data.drivers || []).map(d => {
    const dotColor = d.impact === 'Critical' ? 'var(--crit)' : (d.impact === 'High' ? 'var(--warn)' : 'var(--ok)');
    return `
      <div style="background:var(--bg-card); border:1px solid var(--border); border-radius:20px; padding:6px 12px; font-size:12px; color:var(--text-secondary); display:flex; align-items:center; gap:6px; box-shadow: 0 2px 8px rgba(0,0,0,0.2);">
        <span style="width:8px; height:8px; border-radius:50%; background:${dotColor};"></span>
        ${cancelEscape(d.driver)} <strong style="color:var(--text-primary)">${cancelEscape(d.value)}</strong>
      </div>
    `;
  }).join('') || '<span style="color:var(--text-muted); font-size:12px;">None identified</span>';
  const scopeLabel = data.region_code === 'ALL' ? 'All regions' : `${cancelEscape(data.region_code)} region`;

  panel.innerHTML = `
    <div class="risk-prediction-card">
      <div class="risk-gauge-block">
        <div class="risk-gauge" style="--risk-color:${gaugeColor}; --risk-score:${data.risk_score}%; --risk-shadow:${shadowColor};">
          <div>
            <span>Score</span>
            <strong>${data.risk_score}</strong>
          </div>
        </div>
        <strong class="risk-level" style="color:${gaugeColor};">${cancelEscape(data.risk_level)}</strong>
        <span class="risk-scope">${scopeLabel}</span>
      </div>

      <div class="risk-prediction-detail">
        <div class="risk-metric-grid">
          <div><span>D-1 Cancellation Rate</span><strong>${EXL.fmt.pct(data.cancel_rate)}</strong></div>
          <div><span>Same-Day Abort Rate</span><strong>${EXL.fmt.pct(data.abort_rate)}</strong></div>
          <div><span>Trend</span><strong style="color:${trendColor};">${cancelEscape(data.trend_direction)} <small>${trendIcon}</small></strong></div>
        </div>
        <div class="risk-recommendation">
          <span>AI Recommendation</span>
          <strong>${cancelEscape(data.recommendations?.[0] || 'Maintain current operational strategies.')}</strong>
        </div>
        <div class="risk-drivers">
          <span>Primary Risk Drivers</span>
          <div>
            ${driversHtml}
          </div>
        </div>
      </div>
    </div>
  `;
  if (showLoading) EXL.setLoading('cancel-risk-panel', false);
}

/* ── Recovery Constellation ───────────────────────────────── */

// Singleton tooltip element shared across all constellation nodes
let _rcTooltip = null;
function getRcTooltip() {
  if (!_rcTooltip) {
    _rcTooltip = document.createElement('div');
    _rcTooltip.className = 'rc-tooltip';
    _rcTooltip.style.display = 'none';
    document.body.appendChild(_rcTooltip);
  }
  return _rcTooltip;
}

function showRcTooltip(node, svgEl, evt) {
  const tip = getRcTooltip();
  const sc  = node.score;
  const scColor = sc >= 70 ? '#028178' : sc >= 50 ? '#F4D25A' : '#FB8281';
  const notRebooked = node.not_rebooked ?? (node.total_cancellations - node.rebooked_count);
  const failedRebooks = node.failed_rebooks ?? (node.rebooked_count - node.completed_rebooks);

  tip.innerHTML = `
    <div class="rct-header">
      <span class="rct-region">${cancelEscape(node.region_code)}</span>
      <span class="rct-score" style="color:${scColor}">${sc}<small>/100</small></span>
    </div>
    <div class="rct-divider"></div>
    <div class="rct-row">
      <span class="rct-dot cancel"></span>
      <span class="rct-label">Appointments Cancelled (D-1)</span>
      <strong class="rct-val">${(node.total_cancellations || 0).toLocaleString()}</strong>
    </div>
    <div class="rct-row">
      <span class="rct-dot rebook"></span>
      <span class="rct-label">Rebooked</span>
      <strong class="rct-val">${(node.rebooked_count || 0).toLocaleString()} <em>of ${(node.total_cancellations || 0).toLocaleString()}</em></strong>
    </div>
    <div class="rct-row">
      <span class="rct-dot success"></span>
      <span class="rct-label">Executed Successfully After Rebook</span>
      <strong class="rct-val">${(node.completed_rebooks || 0).toLocaleString()} <em>of ${(node.rebooked_count || 0).toLocaleString()}</em></strong>
    </div>
    <div class="rct-row">
      <span class="rct-dot fail"></span>
      <span class="rct-label">Failed Rebooks</span>
      <strong class="rct-val">${failedRebooks.toLocaleString()}</strong>
    </div>
    <div class="rct-row">
      <span class="rct-dot lost"></span>
      <span class="rct-label">Not Rebooked</span>
      <strong class="rct-val">${notRebooked.toLocaleString()}</strong>
    </div>
    <div class="rct-divider"></div>
    <div class="rct-row">
      <span class="rct-dot lag"></span>
      <span class="rct-label">Avg Rebook Lag</span>
      <strong class="rct-val">${node.avg_rebook_lag_days} days</strong>
    </div>
    <div class="rct-row">
      <span class="rct-dot fast"></span>
      <span class="rct-label">Fast Rebooks (&lt;½ lag)</span>
      <strong class="rct-val">${node.fast_rebook_pct ?? '—'}%</strong>
    </div>
    <div class="rct-bar-wrap">
      <div class="rct-bar-track">
        <div class="rct-bar-fill rebook"  style="width:${node.rebook_rate_pct}%" title="Rebook rate"></div>
      </div>
      <div class="rct-bar-track">
        <div class="rct-bar-fill success" style="width:${node.rebook_success_pct}%" title="Success rate"></div>
      </div>
    </div>
    <div class="rct-bar-labels">
      <span>Rebook ${node.rebook_rate_pct}%</span>
      <span>Success ${node.rebook_success_pct}%</span>
    </div>
  `;
  tip.style.display = 'block';
  positionRcTooltip(tip, evt);
}

function positionRcTooltip(tip, evt) {
  const margin = 14;
  const vpW = window.innerWidth, vpH = window.innerHeight;
  const tw = tip.offsetWidth || 240, th = tip.offsetHeight || 300;
  let x = evt.clientX + margin;
  let y = evt.clientY - th / 2;
  if (x + tw > vpW - 8) x = evt.clientX - tw - margin;
  if (y < 8) y = 8;
  if (y + th > vpH - 8) y = vpH - th - 8;
  tip.style.left = x + 'px';
  tip.style.top  = y + 'px';
}

function hideRcTooltip() {
  const tip = getRcTooltip();
  tip.style.display = 'none';
}

function renderRebooking(data) {
  const stage = document.getElementById('recovery-constellation-stage');
  if (!stage) return;

  const rows = data.rebook_data || [];
  if (!rows.length) {
    stage.innerHTML = '<div class="empty-state"><div class="empty-title">No rebooking data available</div></div>';
    return;
  }

  // Composite recovery score: rebook rate × 0.45 + success × 0.40 + lag speed bonus × 0.15
  const scored = rows.map(r => {
    const lagPenalty = Math.max(0, 1 - (r.avg_rebook_lag_days - 8) / 20);
    const score = Math.round(r.rebook_rate_pct * 0.45 + r.rebook_success_pct * 0.40 + lagPenalty * 15);
    return { ...r, score };
  });

  const boardMaxLag = Math.max(...scored.map(r => r.avg_rebook_lag_days), 1);
  const boardCount = scored.length;
  const boardScore = Math.round(scored.reduce((s, r) => s + r.score, 0) / boardCount);
  const boardRebook = data.overall_rebook_rate || 0;
  const boardLag = data.avg_rebook_lag_days || 0;
  const boardScoreColor = boardScore >= 70 ? '#028178' : boardScore >= 50 ? '#F4D25A' : '#FB8281';
  const rankedBoard = [...scored].sort((a, b) => b.score - a.score);
  const insightFor = r => {
    if (r.score >= 70) return `Strong recovery pipeline. ${cancelEscape(r.region_code)} converts D-1 cancelled appointments efficiently - ${r.completed_rebooks ?? '-'} rebooks executed successfully.`;
    if (r.score >= 50) return `Moderate recovery. ${cancelEscape(r.region_code)} rebooked ${r.rebooked_count ?? '-'} of ${r.total_cancellations ?? '-'} D-1 cancelled appointments but success rate needs improvement.`;
    return `Recovery at risk. Only ${r.rebooked_count ?? '-'} of ${r.total_cancellations ?? '-'} D-1 cancelled appointments were rebooked - targeted outreach recommended.`;
  };

  const regionTiles = rankedBoard.map((r, i) => {
    const tone = r.score >= 70 ? 'strong' : r.score >= 50 ? 'steady' : 'risk';
    const regionScoreColor = r.score >= 70 ? '#028178' : r.score >= 50 ? '#F4D25A' : '#FB8281';
    const lagPct = Math.max(6, Math.min(100, r.avg_rebook_lag_days / boardMaxLag * 100));
    return `
      <button type="button" class="rc-region-card ${tone}" data-idx="${i}"
              style="--score-color:${regionScoreColor}; --rebook:${r.rebook_rate_pct}%; --success:${r.rebook_success_pct}%; --lag:${lagPct}%;">
        <span class="rc-card-rank">#${i + 1}</span>
        <span class="rc-card-score">${r.score}</span>
        <span class="rc-card-region">${cancelEscape(r.region_code)}</span>
        <span class="rc-card-status">${tone === 'strong' ? 'Strong' : tone === 'steady' ? 'Recovering' : 'At risk'}</span>
        <span class="rc-card-count"><b>${EXL.fmt.num(r.rebooked_count)}</b> / ${EXL.fmt.num(r.total_cancellations)}</span>
        <span class="rc-card-lag">${r.avg_rebook_lag_days}d lag</span>
        <span class="rc-card-bar rebook"><i></i><em>Rebook ${r.rebook_rate_pct}%</em></span>
        <span class="rc-card-bar success"><i></i><em>Success ${r.rebook_success_pct}%</em></span>
        <span class="rc-card-meta">${EXL.fmt.num(r.completed_rebooks)} executed successfully</span>
      </button>
    `;
  }).join('');

  stage.innerHTML = `
    <div class="rc-board-shell">
      <div class="rc-overview-card" style="--score-color:${boardScoreColor}; --rebook:${boardRebook}%; --lag:${Math.max(6, Math.min(100, boardLag / boardMaxLag * 100))}%;">
        <div class="rc-overview-ring">
          <strong>${boardScore}</strong>
          <span>Score</span>
        </div>
        <div class="rc-overview-copy">
          <span>Network recovery pulse</span>
          <strong>${boardRebook}% avg rebook rate</strong>
          <em>${boardLag.toFixed(1)}d average lag across ${boardCount} regions</em>
        </div>
        <div class="rc-overview-bars">
          <div><span>Rebook rate</span><i class="rebook"></i><b>${boardRebook}%</b></div>
          <div><span>Lag pressure</span><i class="lag"></i><b>${boardLag.toFixed(1)}d</b></div>
        </div>
        <div class="rc-overview-stats">
          <div><span>Regions</span><strong>${boardCount}</strong></div>
          <div><span>Avg Rebook Rate</span><strong>${boardRebook}%</strong></div>
          <div><span>Avg Lag</span><strong>${boardLag.toFixed(1)}d</strong></div>
        </div>
        <div class="rc-overview-ranking">
          ${rankedBoard.slice(0, 3).map((r, i) => `
            <div>
              <span>#${i + 1}</span>
              <strong>${cancelEscape(r.region_code)}</strong>
              <em style="color:${r.score>=70?'#028178':r.score>=50?'#F4D25A':'#FB8281'}">${r.score}</em>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="rc-region-board">
        ${regionTiles}
      </div>
    </div>
  `;

  stage.querySelectorAll('.rc-region-card').forEach(el => {
    el.addEventListener('mouseenter', evt => {
      const r = rankedBoard[+el.dataset.idx];
      if (r) showRcTooltip(r, null, evt);
    });
    el.addEventListener('mousemove', evt => positionRcTooltip(getRcTooltip(), evt));
    el.addEventListener('mouseleave', hideRcTooltip);
    el.addEventListener('click', () => {
      const r = rankedBoard[+el.dataset.idx];
      if (!r) return;
      const scColor = r.score >= 70 ? '#028178' : r.score >= 50 ? '#F4D25A' : '#FB8281';
      const set = (id, v) => { const item = document.getElementById(id); if (item) item.textContent = v; };
      set('rd-region', r.region_code);
      set('rd-rebook', `${r.rebooked_count ?? '-'} / ${r.total_cancellations ?? '-'} (${r.rebook_rate_pct}%)`);
      set('rd-lag', `${r.avg_rebook_lag_days} days`);
      set('rd-success', `${r.completed_rebooks ?? '-'} executed successfully (${r.rebook_success_pct}%)`);
      set('rd-score', r.score);
      const scoreEl = document.getElementById('rd-score');
      if (scoreEl) scoreEl.style.color = scColor;
      set('rd-insight', insightFor(r));

      const strip = document.getElementById('recovery-detail-strip');
      if (strip) { strip.style.display = ''; strip.classList.add('rc-strip-flash'); }
      setTimeout(() => strip?.classList.remove('rc-strip-flash'), 600);

      stage.querySelectorAll('.rc-region-card').forEach(card => card.classList.remove('rc-node-active'));
      el.classList.add('rc-node-active');
    });
  });
  return;

  const maxLag = Math.max(...scored.map(r => r.avg_rebook_lag_days), 1);
  const n = scored.length;
  // Wide orbit tuned to the landscape card so the graph uses the available viewport.
  const cx = 125, cy = 38, Rx = 100, Ry = 23;
  const angle = i => (i / n) * 2 * Math.PI - Math.PI / 2;

  const nodes = scored.map((r, i) => {
    const a = angle(i);
    // Variable distance from centre based on recovery score (higher score = further out)
    const d = 0.84 + (r.score / 100) * 0.32;
    return { ...r, x: cx + Rx * d * Math.cos(a), y: cy + Ry * d * Math.sin(a), a };
  });

  function arcPath(cx, cy, r, startAngle, endAngle) {
    const s = { x: cx + r * Math.cos(startAngle), y: cy + r * Math.sin(startAngle) };
    const e = { x: cx + r * Math.cos(endAngle),   y: cy + r * Math.sin(endAngle)   };
    const large = (endAngle - startAngle) > Math.PI ? 1 : 0;
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  }

  const overallScore  = Math.round(scored.reduce((s, r) => s + r.score, 0) / n);
  const overallRebook = data.overall_rebook_rate || 0;
  const overallLag    = data.avg_rebook_lag_days || 0;
  const scoreColor    = overallScore >= 70 ? '#028178' : overallScore >= 50 ? '#F4D25A' : '#FB8281';
  const arcStart      = -Math.PI / 2;

  const nodesSvg = nodes.map((nd, i) => {
    const delay       = i * 80;
    const rebookFrac  = nd.rebook_rate_pct / 100;
    const successFrac = nd.rebook_success_pct / 100;
    const lagFrac     = 1 - (nd.avg_rebook_lag_days / maxLag);
    const nColor      = nd.score >= 70 ? '#028178' : nd.score >= 50 ? '#F4D25A' : '#FB8281';
    const glowId      = `glow-${i}`;
    const r1 = 5.0, r2 = 4.0, r3 = 3.0;

    const rebookArc  = arcPath(nd.x, nd.y, r1, arcStart, arcStart + rebookFrac  * 2 * Math.PI);
    const successArc = arcPath(nd.x, nd.y, r2, arcStart, arcStart + successFrac * 2 * Math.PI);
    const lagArc     = arcPath(nd.x, nd.y, r3, arcStart, arcStart + lagFrac     * 2 * Math.PI);

    // Use actual direction from center to node for accurate spokes
    const dLen = Math.hypot(nd.x - cx, nd.y - cy) || 1;
    const dX = (nd.x - cx) / dLen, dY = (nd.y - cy) / dLen;
    const spokeX1 = cx + 4.5 * dX, spokeY1 = cy + 4.5 * dY;
    const spokeX2 = nd.x - 6 * dX,  spokeY2 = nd.y - 6 * dY;

    return `
      <defs>
        <filter id="${glowId}" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="1.4" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <line class="rc-spoke" x1="${spokeX1.toFixed(2)}" y1="${spokeY1.toFixed(2)}"
            x2="${spokeX2.toFixed(2)}" y2="${spokeY2.toFixed(2)}" style="animation-delay:${delay}ms" />
      <circle cx="${nd.x.toFixed(2)}" cy="${nd.y.toFixed(2)}" r="${r1}" class="rc-track" />
      <circle cx="${nd.x.toFixed(2)}" cy="${nd.y.toFixed(2)}" r="${r2}" class="rc-track" />
      <circle cx="${nd.x.toFixed(2)}" cy="${nd.y.toFixed(2)}" r="${r3}" class="rc-track" />
      <path d="${rebookArc}"  class="rc-arc rebook"  style="animation-delay:${delay+120}ms" />
      <path d="${successArc}" class="rc-arc success" style="animation-delay:${delay+180}ms" />
      <path d="${lagArc}"     class="rc-arc lag"     style="animation-delay:${delay+240}ms" />
      <circle class="rc-node-dot" cx="${nd.x.toFixed(2)}" cy="${nd.y.toFixed(2)}" r="2.4"
              fill="${nColor}" filter="url(#${glowId})"
              style="animation-delay:${delay}ms" data-idx="${i}" />
      <text class="rc-label" x="${nd.x.toFixed(2)}" y="${(nd.y + (nd.y > cy ? 8 : -8)).toFixed(2)}"
            text-anchor="middle" style="animation-delay:${delay}ms">${cancelEscape(nd.region_code)}</text>
      <text class="rc-score-label" x="${nd.x.toFixed(2)}" y="${(nd.y + (nd.y > cy ? 10.6 : -10.6)).toFixed(2)}"
            text-anchor="middle" fill="${nColor}" style="animation-delay:${delay}ms">${nd.score}</text>
      <text class="rc-mini-rebook" x="${nd.x.toFixed(2)}" y="${(nd.y + (nd.y > cy ? 13 : -13)).toFixed(2)}"
            text-anchor="middle" style="animation-delay:${delay + 60}ms">${nd.rebooked_count ?? '—'}/${nd.total_cancellations ?? '—'}</text>
      <text class="rc-mini-lag" x="${nd.x.toFixed(2)}" y="${(nd.y + (nd.y > cy ? 15.2 : -15.2)).toFixed(2)}"
            text-anchor="middle" style="animation-delay:${delay + 80}ms">${nd.avg_rebook_lag_days}d lag</text>
    `;
  }).join('');

  const hitTargets = nodes.map((nd, i) => `
    <circle class="rc-hit" cx="${nd.x.toFixed(2)}" cy="${(nd.y + (nd.y > cy ? 8 : -8)).toFixed(2)}" r="11" data-idx="${i}" />
  `).join('');

  const coreSvg = `
    <circle class="rc-core-glow" cx="${cx}" cy="${cy}" r="10" />
    <circle class="rc-core"      cx="${cx}" cy="${cy}" r="7.5"  />
    <text class="rc-core-pct" x="${cx}" y="${(cy - 1).toFixed(2)}" text-anchor="middle">${overallScore}</text>
    <text class="rc-core-sub"  x="${cx}" y="${(cy + 3).toFixed(2)}" text-anchor="middle">SCORE</text>
  `;

  // Keep a sorted copy for ranking — sort scored BEFORE building HTML
  const ranked = [...scored].sort((a, b) => b.score - a.score);

  stage.innerHTML = `
    <svg class="rc-svg" viewBox="-8 -2 266 82" preserveAspectRatio="xMidYMid meet" aria-label="Recovery Constellation">
      <ellipse class="rc-orbit rc-orbit-outer" cx="${cx}" cy="${cy}" rx="${Rx}" ry="${Ry}" />
      <ellipse class="rc-orbit rc-orbit-mid"   cx="${cx}" cy="${cy}" rx="${(Rx * 0.55).toFixed(1)}" ry="${(Ry * 0.55).toFixed(1)}" />
      ${nodesSvg}
      ${hitTargets}
      ${coreSvg}
    </svg>
    <div class="rc-summary-panel">
      <div class="rc-summary-score" style="--score-color:${scoreColor}">${overallScore}<span>/ 100</span></div>
      <div class="rc-summary-label">Network Recovery Score</div>
      <div class="rc-summary-stats">
        <div><span>Avg Rebook Rate</span><strong>${overallRebook}%</strong></div>
        <div><span>Avg Lag</span><strong>${overallLag.toFixed(1)}d</strong></div>
        <div><span>Regions</span><strong>${n}</strong></div>
      </div>
      <div class="rc-summary-ranking">
        ${ranked.slice(0, 3).map((r, i) => `
          <div class="rc-rank-row">
            <span class="rc-rank-badge">#${i + 1}</span>
            <span class="rc-rank-region">${cancelEscape(r.region_code)}</span>
            <span class="rc-rank-score" style="color:${r.score>=70?'#028178':r.score>=50?'#F4D25A':'#FB8281'}">${r.score}</span>
          </div>
        `).join('')}
      </div>
      <div class="rc-hint">Hover to inspect · Click to pin</div>
    </div>
  `;

  // ── Events: hover = tooltip, click = pin detail strip ────────
  const svgEl = stage.querySelector('.rc-svg');

  stage.querySelectorAll('.rc-hit').forEach(el => {
    el.addEventListener('mouseenter', evt => {
      const nd = nodes[+el.dataset.idx];
      if (nd) showRcTooltip(nd, svgEl, evt);
      // pulse the matching dot
      stage.querySelectorAll(`.rc-node-dot[data-idx="${el.dataset.idx}"]`).forEach(d => d.classList.add('rc-node-hover'));
    });
    el.addEventListener('mousemove', evt => positionRcTooltip(getRcTooltip(), evt));
    el.addEventListener('mouseleave', () => {
      hideRcTooltip();
      stage.querySelectorAll('.rc-node-dot').forEach(d => d.classList.remove('rc-node-hover'));
    });
    el.addEventListener('click', () => {
      const idx = +el.dataset.idx;
      const r   = nodes[idx];
      if (!r) return;
      const sc      = r.score;
      const scColor = sc >= 70 ? '#028178' : sc >= 50 ? '#F4D25A' : '#FB8281';
      const insight = sc >= 70
        ? `Strong recovery pipeline. ${cancelEscape(r.region_code)} converts D-1 cancelled appointments efficiently — ${r.completed_rebooks ?? '—'} rebooks executed successfully.`
        : sc >= 50
        ? `Moderate recovery. ${cancelEscape(r.region_code)} rebooked ${r.rebooked_count ?? '—'} of ${r.total_cancellations ?? '—'} D-1 cancelled appointments but success rate needs improvement.`
        : `Recovery at risk. Only ${r.rebooked_count ?? '—'} of ${r.total_cancellations ?? '—'} D-1 cancelled appointments were rebooked — targeted outreach recommended.`;

      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('rd-region',  r.region_code);
      set('rd-rebook',  `${r.rebooked_count ?? '—'} / ${r.total_cancellations ?? '—'} (${r.rebook_rate_pct}%)`);
      set('rd-lag',     `${r.avg_rebook_lag_days} days`);
      set('rd-success', `${r.completed_rebooks ?? '—'} executed successfully (${r.rebook_success_pct}%)`);
      set('rd-score',   sc);
      const scoreEl = document.getElementById('rd-score');
      if (scoreEl) scoreEl.style.color = scColor;
      set('rd-insight', insight);

      const strip = document.getElementById('recovery-detail-strip');
      if (strip) { strip.style.display = ''; strip.classList.add('rc-strip-flash'); }
      setTimeout(() => strip?.classList.remove('rc-strip-flash'), 600);

      stage.querySelectorAll('.rc-node-dot').forEach(d => d.classList.remove('rc-node-active'));
      stage.querySelectorAll('.rc-hit').forEach(d => d.classList.remove('rc-node-active'));
      stage.querySelectorAll(`[data-idx="${idx}"]`).forEach(d => d.classList.add('rc-node-active'));
    });
  });
}

function renderSupplierRebooking(data) {
  const stage = document.getElementById('supplier-recovery-stage');
  if (!stage) return;

  const rows = data.supplier_rebook_data || [];
  if (!rows.length) {
    stage.innerHTML = '<div class="empty-state"><div class="empty-title">No supplier rebooking data available</div></div>';
    return;
  }

  const cardsHtml = rows.map((r, i) => {
    return `
      <div class="rc-supplier-card">
        <div class="rc-supplier-header">
          <div class="rc-supplier-rank">#${i + 1}</div>
          <div class="rc-supplier-name" title="${cancelEscape(r.supplier_name)}">${cancelEscape(r.supplier_name)}</div>
          <div class="rc-supplier-volume">${EXL.fmt.num(r.rebooked_count)} / ${EXL.fmt.num(r.total_cancellations)}</div>
        </div>
        <div class="rc-supplier-main-metric">
          <div class="rc-supplier-main-metric-label">
            <span>Rebook Rate</span>
            <span>${r.rebook_rate_pct}%</span>
          </div>
          <div class="rc-supplier-bar-bg">
            <div class="rc-supplier-bar-fill" style="width: ${r.rebook_rate_pct}%;"></div>
          </div>
        </div>
        <div class="rc-supplier-secondary-metrics">
          <div class="rc-supplier-sec-metric">
            <span>Success Rate</span>
            <strong style="color: ${r.rebook_success_pct >= 70 ? '#028178' : r.rebook_success_pct >= 50 ? '#F4D25A' : '#FB8281'}">${r.rebook_success_pct}%</strong>
          </div>
          <div class="rc-supplier-sec-metric" style="text-align: right;">
            <span>Avg Lag</span>
            <strong style="color: ${r.avg_rebook_lag_days <= 10 ? '#028178' : r.avg_rebook_lag_days <= 15 ? '#F4D25A' : '#FB8281'}">${r.avg_rebook_lag_days}d</strong>
          </div>
        </div>
      </div>
    `;
  }).join('');

  stage.innerHTML = cardsHtml;
}
