/* EXL — Field Engineer Scorecard */

const FE = {
  data:     null,
  month:    0,        // 0 = full year, 1–12 = specific month
  search:   '',
  sortCol:  'success_rate',
  sortDir:  -1,       // -1 descending, +1 ascending
  expanded: null,     // engineer id currently expanded
};

const FE_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Thresholds ────────────────────────────────────────────────────────────────
function feStatusLabel(sr) {
  if (sr >= 87) return { label: 'Star Performer', cls: 'fe-badge--star' };
  if (sr >= 78) return { label: 'On Track',       cls: 'fe-badge--ok'   };
  if (sr >= 68) return { label: 'Developing',     cls: 'fe-badge--warn' };
  return              { label: 'Needs Support',   cls: 'fe-badge--crit' };
}

function feBarColor(sr) {
  if (sr >= 85) return 'var(--fe-green)';
  if (sr >= 70) return 'var(--fe-amber)';
  return 'var(--fe-red)';
}

function feProdColor(p) {
  if (p >= 75) return 'var(--fe-green)';
  if (p >= 60) return 'var(--fe-amber)';
  return 'var(--fe-red)';
}

function feLeavesColor(lv, isYear) {
  const hi = isYear ? 25 : 4;
  const md = isYear ? 15 : 2;
  if (lv <= md) return 'var(--fe-green)';
  if (lv <= hi) return 'var(--fe-amber)';
  return 'var(--fe-red)';
}

// ── Data aggregation ──────────────────────────────────────────────────────────
function feAggregate(eng) {
  const rows = FE.month === 0
    ? eng.monthly
    : eng.monthly.filter(m => m.month_num === FE.month);
  if (!rows.length) return null;

  const sum = k => rows.reduce((s, r) => s + r[k], 0);
  const allocated  = sum('total_allocated');
  const bookings   = sum('total_bookings');
  const success    = sum('success_jobs');
  const aborts     = sum('abort_jobs');
  const cancelled  = sum('cancelled_jobs');
  const leaves     = sum('leaves_taken');

  return {
    id:           eng.id,
    name:         eng.name,
    allocated,
    bookings,
    success,
    aborts,
    cancelled,
    leaves,
    success_rate: bookings  ? +(success / bookings  * 100).toFixed(1) : 0,
    productivity: allocated ? +(success / allocated * 100).toFixed(1) : 0,
    monthly:      eng.monthly,
  };
}

// ── Load & render ─────────────────────────────────────────────────────────────
async function loadFieldScorecard(force) {
  if (FE.data && !force) { feRender(); return; }
  EXL.setLoading(['fe-kpi-strip', '.fe-table-wrap'], true);
  try {
    const res = await fetch('/api/field-engineers');
    FE.data = await res.json();
    feBuildMonthChips();
    feRender();
  } catch (e) {
    const tb = document.getElementById('fe-tbody');
    if (tb) tb.innerHTML = `<tr><td colspan="10" class="fe-err">Failed to load engineer data</td></tr>`;
  } finally {
    EXL.setLoading(['fe-kpi-strip', '.fe-table-wrap'], false);
  }
}

function feBuildMonthChips() {
  const bar = document.querySelector('.fe-month-bar');
  if (!bar || !FE.data || !FE.data.engineers || !FE.data.engineers[0]) return;
  
  const months = FE.data.engineers[0].monthly;
  let html = `<button class="fe-month-chip ${FE.month === 0 ? 'active' : ''}" data-m="0" onclick="feSetMonth(0)">Past 12 Months</button>`;
  
  months.forEach(m => {
    const isActive = FE.month === m.month_num ? 'active' : '';
    html += `<button class="fe-month-chip ${isActive}" data-m="${m.month_num}" onclick="feSetMonth(${m.month_num})">${m.month} '${String(m.year).slice(-2)}</button>`;
  });
  
  bar.innerHTML = html;
}

function feSetMonth(m) {
  FE.month = m;
  document.querySelectorAll('.fe-month-chip').forEach(c => {
    c.classList.toggle('active', +c.dataset.m === m);
  });
  feRender();
}

function feSearch(q) {
  FE.search = q.toLowerCase().trim();
  feRender();
}

function feSort(col) {
  if (FE.sortCol === col) FE.sortDir *= -1;
  else { FE.sortCol = col; FE.sortDir = -1; }
  feRender();
}

function feToggle(id) {
  FE.expanded = FE.expanded === id ? null : id;
  feRender();
}

// ── Render ────────────────────────────────────────────────────────────────────
function feRender() {
  if (!FE.data || !FE.data.engineers) return;

  const isYear = FE.month === 0;
  let rows = FE.data.engineers
    .map(feAggregate)
    .filter(r => r !== null)
    .filter(r => !FE.search || r.name.toLowerCase().includes(FE.search));

  const col = FE.sortCol;
  rows.sort((a, b) => {
    const av = col === 'name' ? a.name.localeCompare(b.name) : (a[col] ?? 0) - (b[col] ?? 0);
    return typeof av === 'number' ? av * FE.sortDir : (FE.sortDir === -1 ? av : -av);
  });

  feRenderKPIs(rows, isYear);
  feRenderTable(rows, isYear);
  feRenderSortIndicators();
}

function feRenderKPIs(rows, isYear) {
  const strip = document.getElementById('fe-kpi-strip');
  if (!strip || !rows.length) return;

  const avgSR   = rows.reduce((s, r) => s + r.success_rate, 0) / rows.length;
  const avgProd = rows.reduce((s, r) => s + r.productivity, 0) / rows.length;
  const avgLv   = rows.reduce((s, r) => s + r.leaves,        0) / rows.length;
  const stars   = rows.filter(r => r.success_rate >= 87).length;

  strip.innerHTML = `
    <div class="fe-kpi-card">
      <div class="fe-kpi-val" style="color:${feBarColor(avgSR)}">${avgSR.toFixed(1)}%</div>
      <div class="fe-kpi-lbl">Avg Success Rate</div>
    </div>
    <div class="fe-kpi-card">
      <div class="fe-kpi-val" style="color:${feProdColor(avgProd)}">${avgProd.toFixed(1)}%</div>
      <div class="fe-kpi-lbl">Avg Productivity</div>
    </div>
    <div class="fe-kpi-card">
      <div class="fe-kpi-val" style="color:${feLeavesColor(avgLv, false)}">${avgLv.toFixed(1)}</div>
      <div class="fe-kpi-lbl">${isYear ? 'Avg Leaves (Annual)' : 'Avg Leaves (Month)'}</div>
    </div>
    <div class="fe-kpi-card">
      <div class="fe-kpi-val" style="color:var(--fe-gold)">${stars}</div>
      <div class="fe-kpi-lbl">Star Performers</div>
    </div>
    <div class="fe-kpi-card">
      <div class="fe-kpi-val">${rows.length}</div>
      <div class="fe-kpi-lbl">Engineers Shown</div>
    </div>
  `;
}

function feBar(pct, color, label) {
  const w = Math.min(pct, 100).toFixed(1);
  return `
    <div class="fe-bar-cell">
      <div class="fe-bar-track">
        <div class="fe-bar-fill" style="width:${w}%;background:${color}"></div>
      </div>
      <span class="fe-bar-lbl">${label}</span>
    </div>`;
}

function feRenderTable(rows, isYear) {
  const tb = document.getElementById('fe-tbody');
  if (!tb) return;
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="10" class="fe-no-data">No engineers match your filter</td></tr>';
    return;
  }

  const html = rows.map((r, i) => {
    const status = feStatusLabel(r.success_rate);
    const isExp  = FE.expanded === r.id;
    const srColor = feBarColor(r.success_rate);
    const prColor = feProdColor(r.productivity);
    const lvColor = feLeavesColor(r.leaves, isYear);

    const rowClass = i % 2 === 0 ? 'fe-row' : 'fe-row fe-row--alt';
    const expIcon  = isExp ? '▼' : '▶';

    let html = `
      <tr class="${rowClass} ${isExp ? 'fe-row--expanded' : ''}" onclick="feToggle('${r.id}')" style="cursor:pointer">
        <td class="fe-td fe-td-rank">
          <span class="fe-rank">${i + 1}</span>
        </td>
        <td class="fe-td fe-td-name">
          <span class="fe-exp-icon">${expIcon}</span>
          <span class="fe-name">${r.name}</span>
          <span class="fe-eng-id">${r.id}</span>
        </td>
        <td class="fe-td fe-td-num">${r.allocated.toLocaleString()}</td>
        <td class="fe-td fe-td-num">${r.bookings.toLocaleString()}</td>
        <td class="fe-td fe-td-num">${r.success.toLocaleString()}</td>
        <td class="fe-td fe-td-bar">
          ${feBar(r.success_rate, srColor, r.success_rate.toFixed(1) + '%')}
        </td>
        <td class="fe-td fe-td-bar">
          ${feBar(r.productivity, prColor, r.productivity.toFixed(1) + '%')}
        </td>
        <td class="fe-td fe-td-num">
          <span class="fe-lv-badge" style="color:${lvColor}">${r.leaves}</span>
        </td>
        <td class="fe-td fe-td-num">${r.aborts}</td>
        <td class="fe-td">
          <span class="fe-badge ${status.cls}">${status.label}</span>
        </td>
      </tr>`;

    if (isExp) {
      html += feMonthlyExpansion(r);
    }
    return html;
  }).join('');

  tb.innerHTML = html;
}

function feMonthlyExpansion(r) {
  const monthsData = r.monthly;

  const headerCells = monthsData.map(d => `<th class="fe-exp-th">${d.month} '${String(d.year).slice(-2)}</th>`).join('');
  const allocRow    = monthsData.map(d => `<td class="fe-exp-td">${d.total_allocated}</td>`).join('');
  const bkRow       = monthsData.map(d => `<td class="fe-exp-td">${d.total_bookings}</td>`).join('');
  const sucRow      = monthsData.map(d => `<td class="fe-exp-td">${d.success_jobs}</td>`).join('');
  
  const srRow = monthsData.map(d => {
    const c = feBarColor(d.success_rate);
    return `<td class="fe-exp-td" style="color:${c};font-weight:600">${d.success_rate}%</td>`;
  }).join('');
  
  const lvRow = monthsData.map(d => {
    const c = feLeavesColor(d.leaves_taken, false);
    return `<td class="fe-exp-td" style="color:${c}">${d.leaves_taken}</td>`;
  }).join('');

  // Mini sparkline bars for success rate
  const sparkRow = monthsData.map(d => {
    const h = Math.round(d.success_rate * 0.32); // max ~31px at 100%
    const c = feBarColor(d.success_rate);
    return `<td class="fe-exp-td fe-exp-spark-td">
      <div class="fe-exp-bar-wrap">
        <div class="fe-exp-bar" style="height:${h}px;background:${c}"></div>
        <span class="fe-exp-bar-lbl">${d.success_rate}%</span>
      </div>
    </td>`;
  }).join('');

  return `
    <tr class="fe-exp-row">
      <td colspan="10" class="fe-exp-cell">
        <div class="fe-exp-inner">
          <div class="fe-exp-title">Monthly Breakdown — ${r.name}</div>
          <div class="fe-exp-scroll">
            <table class="fe-exp-table">
              <thead>
                <tr>
                  <th class="fe-exp-th fe-exp-label-th">Metric</th>
                  ${headerCells}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td class="fe-exp-label">Success Rate</td>
                  ${sparkRow}
                </tr>
                <tr class="fe-exp-alt">
                  <td class="fe-exp-label">Allocated</td>
                  ${allocRow}
                </tr>
                <tr>
                  <td class="fe-exp-label">Bookings</td>
                  ${bkRow}
                </tr>
                <tr class="fe-exp-alt">
                  <td class="fe-exp-label">Success</td>
                  ${sucRow}
                </tr>
                <tr>
                  <td class="fe-exp-label">Rate %</td>
                  ${srRow}
                </tr>
                <tr class="fe-exp-alt">
                  <td class="fe-exp-label">Leaves</td>
                  ${lvRow}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </td>
    </tr>`;
}

function feRenderSortIndicators() {
  document.querySelectorAll('.fe-th[data-col]').forEach(th => {
    const isSorted = th.dataset.col === FE.sortCol;
    th.classList.toggle('fe-th--sorted', isSorted);
    const arrow = th.querySelector('.fe-sort-arrow');
    if (arrow) arrow.textContent = isSorted ? (FE.sortDir === -1 ? ' ↓' : ' ↑') : ' ↕';
  });
}
