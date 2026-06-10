/* EXL — 21-Day Roster Pivot Table (split-panel) */

const RT = { data: null, search: '', expandedRegions: new Set() };
const SLOTS = ['morning', 'afternoon', 'evening'];
const RT_REGION_NAMES = {
  EM: 'East Midlands',
  MID: 'Midlands',
  NE: 'North East',
  NW: 'North West',
  SE: 'South East',
  SW: 'South West',
  WM: 'West Midlands',
  Y: 'Yorkshire',
  YRK: 'Yorkshire',
};

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadRosterTimeline(force) {
  if (RT.data && !force) { rtRender(); return; }
  EXL.setLoading('#view-field-ops .pt-outer', true);
  const lb = document.getElementById('pt-lbody');
  if (lb) lb.innerHTML = '<tr><td colspan="5" class="loading" style="padding:40px;text-align:center"><span class="spinner"></span></td></tr>';
  try {
    const res  = await fetch('/api/roster/timeline');
    RT.data    = await res.json();
    rtRender();
  } catch {
    if (lb) lb.innerHTML = '<tr><td colspan="5" style="padding:28px;text-align:center;color:var(--fe-red)">Failed to load roster data</td></tr>';
  } finally {
    EXL.setLoading('#view-field-ops .pt-outer', false);
  }
}

function rtSetSearch(q) { RT.search = q.toLowerCase().trim(); rtRenderPivot(); }

function rtRegionName(code) {
  return RT_REGION_NAMES[code] || code;
}

function rtToggleRegion(region) {
  if (RT.expandedRegions.has(region)) {
    RT.expandedRegions.delete(region);
  } else {
    RT.expandedRegions.add(region);
  }
  rtRenderPivot();
}

function rtEscapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function rtSelectedRegions() {
  const region = EXL.getRegion();
  if (!region) return null;
  const map = {
    MID: ['MID', 'WM', 'EM'],
    YRK: ['YRK', 'Y'],
  };
  return map[region] || [region];
}

// ── Top-level render ──────────────────────────────────────────────────────────
function rtRender() {
  if (!RT.data) return;

  // Date-range badge
  const el = document.getElementById('rt-date-range');
  if (el && RT.data.days.length) {
    const f = RT.data.days[0], l = RT.data.days[RT.data.days.length - 1];
    el.textContent = `${f.weekday} ${f.day} ${f.month} — ${l.weekday} ${l.day} ${l.month} ${RT.data.generated.slice(0, 4)}`;
  }

  // Sync left-header height to right-header after browser paints
  rtBuildRightHeader();
  rtRenderPivot();
  rtSetupScrollSync();
}

// ── Build right header (day names + M/A/E) and set table widths ───────────────
function rtBuildRightHeader() {
  const days = RT.data.days;
  const rdEl = document.getElementById('pt-rdays');
  const rsEl = document.getElementById('pt-rslots');
  if (!rdEl || !rsEl) return;

  // colgroup ensures table-layout:fixed respects exact slot widths
  const COL_W = 44;
  const colgroup = `<colgroup>${days.map(() =>
    `<col style="width:${COL_W}px"><col style="width:${COL_W}px"><col style="width:${COL_W}px">`
  ).join('')}</colgroup>`;

  rdEl.innerHTML = days.map(d => {
    const wk = d.is_weekend ? ' pt-day--wknd' : '';
    return `<th class="pt-day-th${wk}" colspan="3">${d.weekday} <strong>${d.day}</strong><span class="pt-mon"> ${d.month}</span></th>`;
  }).join('');

  rsEl.innerHTML = days.map(d => {
    const wk = d.is_weekend ? ' pt-slot--wknd' : '';
    return `<th class="pt-slot-th pt-s-m${wk}" style="width:${COL_W}px">M</th>
            <th class="pt-slot-th pt-s-a${wk}" style="width:${COL_W}px">A</th>
            <th class="pt-slot-th pt-s-e${wk}" style="width:${COL_W}px">E</th>`;
  }).join('');

  // Inject colgroup into the right header table
  const rhTable = document.querySelector('#pt-rh table');
  if (rhTable) {
    const existing = rhTable.querySelector('colgroup');
    if (existing) existing.remove();
    rhTable.insertAdjacentHTML('afterbegin', colgroup);
  }

  // Set explicit min-width on right tables so the browser can't shrink them
  rtApplyTableWidths();

  // Sync left-panel spacer row height to right slot-header row after paint
  requestAnimationFrame(() => {
    const rsRow = document.getElementById('pt-rslots');
    const lsRow = document.getElementById('pt-lslot-spacer');
    const rdRow = document.getElementById('pt-rdays');
    const lhRow = document.getElementById('pt-lhead-row');
    const lh = document.getElementById('pt-lh') || document.querySelector('.pt-lh');
    const rh = document.getElementById('pt-rh');
    if (rsRow && lsRow) {
      const h = rsRow.getBoundingClientRect().height;
      lsRow.style.height = h + 'px';
      const th = lsRow.querySelector('th');
      if (th) th.style.height = h + 'px';
    }
    if (rdRow && lhRow) {
      lhRow.style.height = rdRow.getBoundingClientRect().height + 'px';
    }
    if (lh && rh) {
      lh.style.height = `${rh.getBoundingClientRect().height}px`;
    }
  });
}

// ── Force explicit pixel min-width on both right tables ───────────────────────
function rtApplyTableWidths() {
  const COL_W  = 44;
  const minW   = RT.data.days.length * 3 * COL_W;   // e.g. 21×3×44 = 2772px

  [document.querySelector('#pt-rh table'),
   document.querySelector('#pt-rb table'),
   document.querySelector('#pt-rf table')].forEach(el => {
    if (el) el.style.minWidth = minW + 'px';
  });
}

function rtSyncRows(leftSelector, rightSelector) {
  const leftRows = Array.from(document.querySelectorAll(leftSelector));
  const rightRows = Array.from(document.querySelectorAll(rightSelector));
  leftRows.forEach((leftRow, i) => {
    const rightRow = rightRows[i];
    if (!rightRow) return;
    leftRow.style.height = '';
    rightRow.style.height = '';
    leftRow.querySelectorAll('td,th').forEach(cell => { cell.style.height = ''; });
    rightRow.querySelectorAll('td,th').forEach(cell => { cell.style.height = ''; });
    const height = Math.ceil(Math.max(
      leftRow.getBoundingClientRect().height,
      rightRow.getBoundingClientRect().height,
    ));
    leftRow.style.height = `${height}px`;
    rightRow.style.height = `${height}px`;
    leftRow.querySelectorAll('td,th').forEach(cell => { cell.style.height = `${height}px`; });
    rightRow.querySelectorAll('td,th').forEach(cell => { cell.style.height = `${height}px`; });
  });
}

function rtSyncSplitRowHeights() {
  rtSyncRows('#pt-lbody tr', '#pt-rbody tr');
  rtSyncRows('#pt-lfoot tr', '#pt-rfoot tr');
}

// ── Render left and right body/footer ─────────────────────────────────────────
function rtRegionSummary(region, engineers, days) {
  const totals = { cap: 0, booked: 0 };
  const dayTotals = {};
  days.forEach(day => {
    dayTotals[day.date] = {
      morning: { cap: 0, booked: 0, avail: 0, status: 'low', jobs: {} },
      afternoon: { cap: 0, booked: 0, avail: 0, status: 'low', jobs: {} },
      evening: { cap: 0, booked: 0, avail: 0, status: 'low', jobs: {} },
    };
  });

  engineers.forEach(eng => {
    eng.days.forEach(day => {
      SLOTS.forEach(slot => {
        const s = day[slot];
        if (!s || s.status === 'leave' || s.status === 'off') return;
        const t = dayTotals[day.date]?.[slot];
        if (!t) return;
        t.cap += s.cap || 0;
        t.booked += s.booked || 0;
        t.avail += s.avail || 0;
        totals.cap += s.cap || 0;
        totals.booked += s.booked || 0;
        Object.entries(s.jobs || {}).forEach(([kind, count]) => {
          t.jobs[kind] = (t.jobs[kind] || 0) + count;
        });
      });
    });
  });

  days.forEach(day => {
    SLOTS.forEach(slot => {
      const t = dayTotals[day.date][slot];
      const pct = t.cap ? t.booked / t.cap : 0;
      t.status = pct >= 1 ? 'full' : pct >= 0.67 ? 'high' : pct >= 0.34 ? 'mid' : 'low';
    });
  });

  const util = totals.cap ? Number(((totals.booked / totals.cap) * 100).toFixed(1)) : 0;
  return {
    id: `REG-${region}`,
    name: rtRegionName(region),
    region,
    shift: `${engineers.length} engineers`,
    util,
    days: days.map(day => ({
      date: day.date,
      morning: dayTotals[day.date].morning,
      afternoon: dayTotals[day.date].afternoon,
      evening: dayTotals[day.date].evening,
    })),
  };
}

function rtGroupEngineers(engineers, days) {
  const groups = new Map();
  engineers.forEach(eng => {
    if (!groups.has(eng.region)) groups.set(eng.region, []);
    groups.get(eng.region).push(eng);
  });
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([region, list]) => ({
      region,
      engineers: list.sort((a, b) => a.id.localeCompare(b.id)),
      summary: rtRegionSummary(region, list, days),
    }));
}

function rtRenderPivot() {
  if (!RT.data) return;

  const days = RT.data.days;
  let engs   = RT.data.engineers;

  if (RT.search) engs = engs.filter(e =>
    e.name.toLowerCase().includes(RT.search) || e.id.toLowerCase().includes(RT.search));
  const selectedRegions = rtSelectedRegions();
  if (selectedRegions) engs = engs.filter(e => selectedRegions.includes(e.region));

  const shiftCls = {
    'Early':    'pt-sh--early',
    'Late':     'pt-sh--late',
    'Full Day': 'pt-sh--full',
  };
  const utilCls = u => u >= 85 ? 'rt-util--crit' : u >= 65 ? 'rt-util--warn' : 'rt-util--ok';

  // ── Left body ──
  let lb = '';
  let rb = '';
  const NCOLS = days.length * 3;

  if (!engs.length) {
    lb = `<tr><td colspan="5" class="pt-empty">No engineers match the filter</td></tr>`;
    rb = `<tr><td colspan="${NCOLS}" class="pt-empty"> </td></tr>`;
  } else {
    let rowIndex = 0;
    rtGroupEngineers(engs, days).forEach(group => {
      const expanded = Boolean(RT.search) || RT.expandedRegions.has(group.region);
      const alt = rowIndex % 2 ? ' pt-row--alt' : '';
      const caret = expanded ? '▾' : '▸';
      const regionName = rtRegionName(group.region);
      const toggleTitle = `${expanded ? 'Collapse' : 'Expand'} ${regionName} engineers`;
      const escapedRegion = rtEscapeAttr(group.region);

      lb += `<tr class="pt-row pt-row--region${alt}" onclick="rtToggleRegion('${escapedRegion}')" title="${rtEscapeAttr(toggleTitle)}">
        <td class="pt-ltd pt-region-cell" colspan="5">
          <button type="button" class="pt-region-toggle" aria-expanded="${expanded}">
            <span class="pt-region-caret">${caret}</span>
            <span class="pt-region-title">${regionName}</span>
            <span class="pt-region-name">${group.engineers.length} engineers</span>
            <span class="rt-util ${utilCls(group.summary.util)}">${group.summary.util}%</span>
          </button>
        </td>
      </tr>`;

      rb += `<tr class="pt-row pt-row--region${alt}" onclick="rtToggleRegion('${escapedRegion}')" title="${rtEscapeAttr(toggleTitle)}">
        ${group.summary.days.map(day => rtSlotCells(day, true)).join('')}
      </tr>`;
      rowIndex += 1;

      if (expanded) {
        group.engineers.forEach(eng => {
          const engAlt = rowIndex % 2 ? ' pt-row--alt' : '';
          lb += `<tr class="pt-row pt-row--engineer${engAlt}">
            <td class="pt-ltd pt-c-id">${eng.id}</td>
            <td class="pt-ltd pt-c-name">${eng.name}</td>
            <td class="pt-ltd pt-c-reg"><span class="pt-region-full" title="${rtEscapeAttr(eng.region)}">${rtRegionName(eng.region)}</span></td>
            <td class="pt-ltd pt-c-shift"><span class="pt-shift ${shiftCls[eng.shift] || ''}">${eng.shift}</span></td>
            <td class="pt-ltd pt-c-util"><span class="rt-util ${utilCls(eng.util)}">${eng.util}%</span></td>
          </tr>`;

          rb += `<tr class="pt-row pt-row--engineer${engAlt}">
            ${eng.days.map(day => rtSlotCells(day)).join('')}
          </tr>`;
          rowIndex += 1;
        });
      }
    });
  }

  document.getElementById('pt-lbody').innerHTML = lb;
  document.getElementById('pt-rbody').innerHTML = rb;

  // ── Footer totals ──
  rtRenderFooter(days, engs);

  // Re-apply table widths in case the body table was rebuilt
  rtApplyTableWidths();
  requestAnimationFrame(rtSyncSplitRowHeights);
}

// ── Footer: total capacity / booked / remaining per day-slot ─────────────────
function rtRenderFooter(days, engs) {
  const totals = {};
  days.forEach(d => {
    totals[d.date] = {
      morning:   { cap: 0, booked: 0, avail: 0 },
      afternoon: { cap: 0, booked: 0, avail: 0 },
      evening:   { cap: 0, booked: 0, avail: 0 },
    };
  });
  engs.forEach(eng => {
    eng.days.forEach(day => {
      if (!totals[day.date]) return;
      SLOTS.forEach(slot => {
        const s = day[slot];
        if (!s || s.status === 'leave' || s.status === 'off') return;
        totals[day.date][slot].cap    += s.cap;
        totals[day.date][slot].booked += s.booked;
        totals[day.date][slot].avail  += s.avail;
      });
    });
  });

  const selectedRegionText = document.getElementById('global-region')?.selectedOptions?.[0]?.textContent || '';
  const regionLabel = selectedRegionText && selectedRegionText !== 'All Regions' ? selectedRegionText : 'National';
  const metrics = [
    { label: 'Capacity', key: 'cap',    cls: () => 'pt-fc--cap' },
    { label: 'Booked',   key: 'booked', cls: () => 'pt-fc--booked' },
    { label: 'Remaining', key: 'avail', cls: (v, t) => {
        const pct = t.cap > 0 ? v / t.cap : 0;
        return pct >= 0.40 ? 'pt-fc--hi' : pct >= 0.15 ? 'pt-fc--md' : 'pt-fc--lo';
      }
    },
    { label: 'Utilisation %', key: 'util', cls: (_v, t) => {
        const pct = t.cap > 0 ? Math.round((t.booked / t.cap) * 100) : 0;
        return pct >= 85 ? 'pt-fc--util-hi' : pct >= 65 ? 'pt-fc--util-md' : 'pt-fc--util-lo';
      },
      value: (t) => t.cap > 0 ? `${Math.round((t.booked / t.cap) * 100)}%` : '—',
    },
  ];

  let lf = '';
  let rf = '';
  metrics.forEach((m, mi) => {
    let fcells = '';
    days.forEach(d => {
      SLOTS.forEach((slot, si) => {
        const t   = totals[d.date][slot];
        const val = m.value ? m.value(t) : t[m.key];
        const ec  = si === 2 ? ' pt-fce' : '';
        const sc  = ['pt-fc-m','pt-fc-a','pt-fc-e'][si];
        const vc  = m.cls(val, t);
        fcells += `<td class="pt-fc ${sc}${ec} ${vc}">${val}</td>`;
      });
    });

    lf += `<tr class="pt-foot-row">
      <td class="pt-ltd pt-fl-label pt-fl-region" colspan="2">${mi === 0 ? regionLabel : ''}</td>
      <td class="pt-ltd pt-fl-label pt-fl-summary" colspan="2">${mi === 0 ? 'Summary' : ''}</td>
      <td class="pt-ltd pt-c-util pt-fl-label">${m.label}</td>
    </tr>`;
    rf += `<tr class="pt-foot-row">${fcells}</tr>`;
  });

  document.getElementById('pt-lfoot').innerHTML = lf;
  document.getElementById('pt-rfoot').innerHTML = rf;
}

// ── 3 slot cells for one day ──────────────────────────────────────────────────
function rtSlotCells(day, isSummary = false) {
  return SLOTS.map((slot, si) => {
    const sc  = ['pt-sc-m','pt-sc-a','pt-sc-e'][si];
    const ec  = si === 2 ? ' pt-sc--edge' : '';
    const s   = day[slot];
    if (!s) return `<td class="pt-sc ${sc} pt-sc--off${ec}">—</td>`;
    if (s.status === 'leave') return `<td class="pt-sc ${sc} pt-sc--leave${ec}" title="On Leave">Lv</td>`;
    if (s.status === 'off' || s.cap === 0) return `<td class="pt-sc ${sc} pt-sc--off${ec}">—</td>`;

    const fill = `pt-sc--${s.status}`;
    const jobEntries = Object.entries(s.jobs || {}).filter(([, count]) => count > 0);
    const jobText = jobEntries.length
      ? jobEntries.map(([kind, count]) => `- ${kind}: ${count}`).join('\n')
      : '- No booked jobs';
    const pct = s.cap ? Math.round((s.booked / s.cap) * 100) : 0;
    const tipPrefix = isSummary ? `${slot} region summary` : slot;
    const tip = `${tipPrefix}: ${s.booked}/${s.cap} booked, ${s.avail} free\nBooked job types:\n${jobText}`;
    return `<td class="pt-sc ${sc} ${fill}${ec}" title="${rtEscapeAttr(tip)}">
      <span class="pt-util-pct">${pct}%</span>
    </td>`;
  }).join('');
}

// ── Scroll sync ───────────────────────────────────────────────────────────────
function rtSetupScrollSync() {
  const rb = document.getElementById('pt-rb');
  const lb = document.getElementById('pt-lb');
  const rh = document.getElementById('pt-rh');
  const rf = document.getElementById('pt-rf');
  if (!rb) return;

  let syncing = false;
  rb.addEventListener('scroll', () => {
    if (syncing) return;
    syncing = true;
    if (lb) lb.scrollTop  = rb.scrollTop;   // vertical sync to left body
    if (rh) rh.scrollLeft = rb.scrollLeft;   // horizontal sync to right header
    if (rf) rf.scrollLeft = rb.scrollLeft;   // horizontal sync to fixed footer
    syncing = false;
  });
}
