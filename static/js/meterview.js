/* EXL — Single Meter View */

function loadMeterViewDashboard() {
  // No auto-load — waits for agent to enter MPXN
}

function mvTryExample(mpxn) {
  const inp = document.getElementById('mv-mpxn-input');
  if (inp) inp.value = mpxn;
  mvSearch();
}

async function mvSearch() {
  const inp = document.getElementById('mv-mpxn-input');
  const mpxn = inp ? inp.value.trim().replace(/\s/g, '') : '';
  if (!mpxn) { mvShowError('Please enter a Meter Point Number (MPXN)'); return; }

  mvShowError('');
  const results = document.getElementById('mv-results');
  if (results) {
    results.style.display = 'block';
    EXL.setLoading('mv-results', true, 'Searching meter...');
  }

  const btn = document.querySelector('.mv-search-btn');
  if (btn) { btn.textContent = 'Searching…'; btn.disabled = true; }

  try {
    const res  = await fetch(`/api/meter-view?mpxn=${encodeURIComponent(mpxn)}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      mvShowError(data.error || 'Meter not found');
      if (results) results.style.display = 'none';
      return;
    }
    mvRenderAll(data);
    results?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    mvShowError('Failed to connect. Please try again.');
    if (results) results.style.display = 'none';
  } finally {
    EXL.setLoading('mv-results', false);
    if (btn) { btn.textContent = 'Search Meter'; btn.disabled = false; }
  }
}

function mvShowError(msg) {
  const el = document.getElementById('mv-search-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

// ── Master render ─────────────────────────────────────────────────────────────
function mvRenderAll(d) {
  const mpxnEl = document.getElementById('mv-result-mpxn');
  const jobsEl = document.getElementById('mv-total-jobs');
  if (mpxnEl) mpxnEl.textContent = d.mpxn;
  if (jobsEl) jobsEl.textContent = `${d.total_jobs} job${d.total_jobs !== 1 ? 's' : ''} on record`;

  mvRenderMeterDetails(d.meter_details);
  mvRenderInsights(d.insights);
  mvRenderMopDetails(d.mop_details);
  mvRenderDcDetails(d.dc_details);
  mvRenderMopVisits(d.last_mop_visits);
  mvRenderDcVisits(d.last_dc_visits);
  mvRenderDiallerContacts(d.last_dialler_contacts);
}

// ── Panel renders ─────────────────────────────────────────────────────────────
function mvRenderMeterDetails(m) {
  const el = document.getElementById('mv-meter-details');
  if (!el) return;
  el.innerHTML = `
    ${mvRow('MPXN',              m.mpxn,           true)}
    ${mvRow('MSN',               m.msn)}
    ${mvRow('Meter Type',        m.meter_type)}
    ${mvRow('Fuel Type',         m.fuel_type)}
    ${mvRow('Supplier',          m.supplier)}
    ${mvRow('Region',            m.region)}
    ${mvRow('Patch',             m.patch)}
    ${mvRow('Last Read',         m.last_read + ' kWh')}
  `;
}

function mvRenderInsights(ins) {
  const el = document.getElementById('mv-insights');
  if (!el) return;
  el.innerHTML = `
    ${mvBool('Seal Visible',        ins.seal_visible)}
    ${mvBool('No Seal Tampering',   ins.no_seal_tampering)}
    ${mvBool('No Physical Damage',  ins.no_physical_damage)}
    ${mvBool('No Wiring Issue',     ins.no_wiring_issue)}
    <div class="mv-summary-block">
      <div class="mv-summary-label">Last 3 Visit Summary</div>
      <div class="mv-summary-text">${ins.visit_summary}</div>
    </div>
  `;
}

function mvRenderMopDetails(m) {
  const el = document.getElementById('mv-mop-details');
  if (!el) return;
  const sc = m.last_job_status === 'Completed' ? 'mv-status--ok'
           : m.last_job_status === 'Cancelled'  ? 'mv-status--warn'
           : m.last_job_status === 'Aborted On Day' ? 'mv-status--crit' : '';
  el.innerHTML = `
    ${mvRow('Last Job Date',      mvDate(m.last_job_date))}
    ${mvRow('Last Job Type',      m.last_job_type)}
    <div class="mv-field-row">
      <span class="mv-label">Last Job Status</span>
      <span class="mv-status-pill ${sc}">${m.last_job_status}</span>
    </div>
    ${m.reason !== '—' ? mvRow('Reason', m.reason) : ''}
    ${['D155','D149','D268','D11','D150'].map(f => mvRow(f, m.flows?.[f] ? 'Yes' : 'No')).join('')}
  `;
}

function mvRenderDcDetails(d) {
  const el = document.getElementById('mv-dc-details');
  if (!el) return;
  el.innerHTML = `
    ${mvRow('Last Visit Date',       mvDate(d.last_visit_date))}
    <div class="mv-field-row">
      <span class="mv-label">Last Visit VNR Status</span>
      <span class="${d.vnr_status ? 'mv-tick' : 'mv-cross'}">${d.vnr_status ? '✓ Read Captured' : '✗ VNR'}</span>
    </div>
    ${mvRow('Last Read Captured',    d.last_read_captured !== '—' ? d.last_read_captured + ' kWh' : '—')}
    ${mvRow('Last Channel',          d.last_channel)}
    ${['D155','D149','D268','D11','D150','D86'].map(f => mvRow(f, d.flows?.[f] ? 'Yes' : 'No')).join('')}
    ${mvRow('Last D10 Received',     mvDate(d.last_d10_date))}
  `;
}

// ── History tables ────────────────────────────────────────────────────────────
function mvRenderMopVisits(rows) {
  const tb = document.getElementById('mv-mop-visits-body');
  if (!tb) return;
  if (!rows || !rows.length) {
    tb.innerHTML = '<tr><td colspan="5" class="mv-empty-td">No MOP visit history found</td></tr>';
    return;
  }
  tb.innerHTML = rows.map((v, i) => `
    <tr class="${i % 2 ? 'mv-tr--alt' : ''}">
      <td class="mv-td">${mvDate(v.date)}</td>
      <td class="mv-td"><span class="mv-mini ${v.appointment_status === 'Yes' ? 'mv-ok' : 'mv-warn'}">${v.appointment_status}</span></td>
      <td class="mv-td"><span class="mv-outcome ${mvOutcomeClass(v.status)}">${v.status}</span></td>
      <td class="mv-td">${v.outcome}</td>
      <td class="mv-td mv-td--reason">${v.reason !== '—' ? v.reason : '<span class="mv-na">—</span>'}</td>
    </tr>`).join('');
}

function mvRenderDcVisits(rows) {
  const tb = document.getElementById('mv-dc-visits-body');
  if (!tb) return;
  if (!rows || !rows.length) {
    tb.innerHTML = '<tr><td colspan="4" class="mv-empty-td">No DC visit history found</td></tr>';
    return;
  }
  tb.innerHTML = rows.map((v, i) => `
    <tr class="${i % 2 ? 'mv-tr--alt' : ''}">
      <td class="mv-td">${mvDate(v.date)}</td>
      <td class="mv-td"><span class="mv-mini ${v.read === 'Yes' ? 'mv-ok' : 'mv-warn'}">${v.read}</span></td>
      <td class="mv-td"><span class="mv-outcome ${mvOutcomeClass(v.status)}">${v.status}</span></td>
      <td class="mv-td mv-td--reason">${v.reason !== '—' ? v.reason : '<span class="mv-na">—</span>'}</td>
    </tr>`).join('');
}

function mvRenderDiallerContacts(rows) {
  const tb = document.getElementById('mv-dialler-body');
  if (!tb) return;
  if (!rows || !rows.length) {
    tb.innerHTML = '<tr><td colspan="3" class="mv-empty-td">No dialler contact history found</td></tr>';
    return;
  }
  tb.innerHTML = rows.map((c, i) => {
    const sCls = c.status === 'Connected' ? 'mv-ok' : c.status === 'No Answer' ? 'mv-warn' : 'mv-neutral';
    return `<tr class="${i % 2 ? 'mv-tr--alt' : ''}">
      <td class="mv-td">${c.channel}</td>
      <td class="mv-td"><span class="mv-mini ${sCls}">${c.status}</span></td>
      <td class="mv-td">${c.outcome}</td>
    </tr>`;
  }).join('');
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
function mvRow(label, value, mono) {
  return `<div class="mv-field-row">
    <span class="mv-label">${label}</span>
    <span class="mv-value${mono ? ' mv-value--mono' : ''}">${value || '—'}</span>
  </div>`;
}

function mvBool(label, val) {
  return `<div class="mv-field-row">
    <span class="mv-label">${label}</span>
    <span class="${val ? 'mv-tick' : 'mv-cross'}">${val ? '✓' : '✗'}</span>
  </div>`;
}

function mvDate(d) {
  if (!d || d === '—') return '—';
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return d; }
}

function mvOutcomeClass(s) {
  if (!s) return '';
  const l = s.toLowerCase();
  if (l === 'completed') return 'mv-ok';
  if (l === 'scheduled' || l === 'booked') return 'mv-neutral';
  if (l === 'cancelled') return 'mv-warn';
  if (l.includes('abort') || l === 'pending') return 'mv-crit';
  return '';
}

function mvDcClass(s) {
  if (!s) return '';
  if (s === 'Read Captured') return 'mv-ok';
  if (s.includes('No Answer')) return 'mv-warn';
  return 'mv-crit';
}

// ── Enter-key shortcut ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('mv-mpxn-input');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') mvSearch(); });
});
