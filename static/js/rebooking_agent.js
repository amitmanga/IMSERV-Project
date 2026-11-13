/* ============================================================================
   REBOOKING AGENT — Agentic AI Workforce Rebooking Workspace
   SSE live 8-step reasoning timeline, queue, 28-day utilisation chart,
   Assisted/Autonomous mode, Mock/Live LLM toggle, Escalations & Audit CSV.
   ============================================================================ */

(() => {
  const CANONICAL_STEPS = [
    'Detect',
    'Dependencies/D36',
    'DNO',
    'Capacity',
    'Decide',
    'Rebook',
    'Message',
    'Log',
  ];

  const state = {
    initialized: false,
    mode: 'assisted',        // 'assisted' | 'autonomous'
    mockLlm: true,           // synced from /api/rebooking-agent/jobs config on first load
    configLoaded: false,
    jobs: [],
    kpis: null,
    escalations: [],
    audit: [],
    selectedJobRef: null,
    selectedDetail: null,    // {job, daily_utilisation, utilisation_threshold_pct, audit}
    timelineByStep: {},
    activeSource: null,
    runningAll: false,
    isRunning: false,
    utilThreshold: 90,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(val) {
    return String(val ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function statusPillClass(status) {
    const s = String(status || 'pending').toLowerCase().replace(/\s+/g, '_');
    return `rbk-pill rbk-pill-${s}`;
  }

  function setRunStatus(text, isRunning = false) {
    const pill = $('rbk-run-status-pill');
    if (!pill) return;
    pill.textContent = text;
    pill.classList.toggle('running', Boolean(isRunning));
  }

  function showError(msg) {
    const banner = $('rbk-error-banner');
    const txt = $('rbk-error-text');
    if (!banner || !txt) return;
    txt.textContent = msg;
    banner.hidden = false;
  }

  function hideError() {
    const banner = $('rbk-error-banner');
    if (banner) banner.hidden = true;
  }

  async function rbkFetch(url, options = {}) {
    const resp = await fetch(url, {
      cache: 'no-store',
      ...options,
    });
    const text = await resp.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_) {
        data = { error: text };
      }
    }
    if (!resp.ok || data?.ok === false) {
      throw new Error(data?.error || data?.friendly_message || `Request failed (HTTP ${resp.status})`);
    }
    return data;
  }

  function emptyTimelineMap() {
    const m = {};
    for (const s of CANONICAL_STEPS) {
      m[s] = {
        step: s,
        tool: null,
        status: 'pending',
        inputs: {},
        outputs: {},
        why: 'Waiting for agent execution...',
      };
    }
    return m;
  }

  function renderSegmentedControls() {
    const assistedBtn = $('rbk-mode-assisted');
    const autoBtn = $('rbk-mode-autonomous');
    if (assistedBtn) assistedBtn.classList.toggle('active', state.mode === 'assisted');
    if (autoBtn) autoBtn.classList.toggle('active', state.mode === 'autonomous');

    const mockBtn = $('rbk-llm-mock');
    const liveBtn = $('rbk-llm-live');
    if (mockBtn) mockBtn.classList.toggle('active', state.mockLlm === true);
    if (liveBtn) liveBtn.classList.toggle('active', state.mockLlm === false);
  }

  function renderKPIs(kpis) {
    if (!kpis) return;
    state.kpis = kpis;
    if ($('rbk-kpi-processed')) $('rbk-kpi-processed').textContent = String(kpis.jobs_processed ?? 0);
    if ($('rbk-kpi-processed-sub')) {
      const pending = Math.max((kpis.total_queue || 0) - (kpis.jobs_processed || 0), 0);
      $('rbk-kpi-processed-sub').textContent = `${pending} pending of ${kpis.total_queue || 0} in queue`;
    }
    if ($('rbk-kpi-auto-rebooked')) $('rbk-kpi-auto-rebooked').textContent = String(kpis.auto_rebooked ?? 0);
    if ($('rbk-kpi-rebooked-sub')) {
      $('rbk-kpi-rebooked-sub').textContent = `${kpis.awaiting_approval ?? 0} awaiting planner approval`;
    }
    if ($('rbk-kpi-escalated')) $('rbk-kpi-escalated').textContent = String(kpis.escalated ?? 0);
    if ($('rbk-kpi-escalated-sub')) {
      $('rbk-kpi-escalated-sub').textContent = `${kpis.open_escalations ?? 0} open planner items`;
    }
    if ($('rbk-kpi-avg-time')) {
      const secs = Number(kpis.avg_agent_seconds || 0);
      $('rbk-kpi-avg-time').textContent = secs > 0 ? `${secs.toFixed(2)}s` : '--';
    }
    if ($('rbk-kpi-benchmark-sub')) {
      const bench = Number(kpis.manual_benchmark_minutes || 12);
      const saved = Number(kpis.time_saved_minutes_per_job || bench);
      $('rbk-kpi-benchmark-sub').textContent = `vs ${bench} min manual (${saved.toFixed(1)} min saved/job)`;
    }
    if ($('rbk-kpi-sla-safe')) $('rbk-kpi-sla-safe').textContent = `${kpis.sla_safe_pct ?? 100}%`;
    if ($('rbk-kpi-sla-sub')) {
      $('rbk-kpi-sla-sub').textContent = Number(kpis.sla_safe_pct ?? 100) >= 100
        ? 'All processed jobs SLA-safe'
        : 'Includes out-of-SLA escalations';
    }
  }

  function populateQueueFilters(filters) {
    if (!filters) return;
    const regionSel = $('rbk-filter-region');
    const reasonSel = $('rbk-filter-reason');
    if (regionSel && regionSel.options.length <= 1 && Array.isArray(filters.regions)) {
      filters.regions.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r;
        opt.textContent = r;
        regionSel.appendChild(opt);
      });
    }
    if (reasonSel && reasonSel.options.length <= 1 && Array.isArray(filters.reasons)) {
      filters.reasons.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r;
        opt.textContent = r;
        reasonSel.appendChild(opt);
      });
    }
  }

  const STEP_TITLES = {
    'Detect': 'Detect & Inspect Job',
    'Dependencies/D36': 'D36 & Industry Dependencies',
    'Dependencies/D30': 'D36 & Industry Dependencies',
    'DNO': 'DNO Clearance Check',
    'Capacity': 'Engineer Capacity Search',
    'Decide': 'Optimal Slot Selection',
    'Rebook': 'Commit Rebooking',
    'Message': 'Customer Communication',
    'Log': 'Compliance Audit Trail',
  };

  const TOOL_HUMAN_NAMES = {
    get_job: 'Detect Job Details',
    check_dependencies_and_d36: 'Validate D36 & Dependencies',
    check_dependencies_and_d30: 'Validate D36 & Dependencies',
    check_dno_flow: 'Evaluate DNO Clearance',
    raise_dno_request: 'Raise DNO Request',
    get_capacity: 'Search Open Capacity',
    rank_slots: 'Rank Candidate Slots',
    rebook_job: 'Commit Rebooking',
    draft_customer_message: 'Draft Customer Notification',
    escalate_to_planner: 'Escalate to Planner',
    write_audit: 'Record Audit Log',
  };

  function humanToolName(tool) {
    if (!tool) return '--';
    return TOOL_HUMAN_NAMES[tool] || String(tool).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  const REGION_HUMAN = {
    NW: 'North West',
    NE: 'North East',
    MID: 'Midlands',
    SE: 'South East',
    SW: 'South West',
    WAL: 'Wales',
    SCO: 'Scotland',
    YRK: 'Yorkshire',
  };

  const JOB_TYPE_HUMAN = {
    NEW_INSTALL: 'New Installation',
    EXCHANGE: 'Meter Exchange',
    REPAIR: 'Repair',
    REMOVAL: 'Removal',
  };

  const SKILL_HUMAN = {
    SMETS2_ELEC: 'SMETS2 Electric',
    SMETS2_GAS: 'SMETS2 Gas',
    SMETS2_INSTALL: 'SMETS2 Installation',
    SMETS_REPAIR: 'SMETS Repair',
    DUAL_FUEL: 'Dual Fuel',
    IHD_TECH: 'IHD Technology',
  };

  const CODE_HUMAN = {
    NONE: 'None',
    CLEAR: 'Clear',
    COMPLETE: 'Complete',
    NOT_REQUIRED: 'Not Required',
    PENDING: 'Pending DNO',
    PENDING_REQUESTED: 'Requested (Pending DNO)',
    BLOCKED: 'Blocked',
    REJECTED: 'Rejected',
    PENDING_SUPPLIER: 'Pending Supplier',
    DATA_MISMATCH: 'Data Mismatch',
    EXCEPTION: 'Exception',
    ASBESTOS_CHECK: 'Asbestos Check',
    LANDLORD_CONSENT: 'Landlord Consent',
    SCAFFOLDING: 'Scaffolding',
    REVENUE_PROTECTION_HOLD: 'Revenue Protection Hold',
    COMMS_HUB_SHORTAGE: 'Comms Hub Shortage',
    THIRD_PARTY_ACCESS_PERMIT: 'Third-Party Access Permit',
    IHD_FOLLOWUP: 'IHD Follow-up',
    D36_OR_DEPENDENCY: 'D36 / Dependency Block',
    D30_OR_DEPENDENCY: 'D36 / Dependency Block',
    DNO_BLOCKED: 'DNO Blocked',
    NO_SLOT_WITHIN_SLA: 'No Slot Within SLA',
    VULNERABLE_APPROVAL: 'Vulnerable Approval',
    POLICY_EXCEPTION: 'Policy Exception',
    SIMULATED_SENT: 'Simulated Send',
    assisted: 'Assisted',
    autonomous: 'Autonomous',
  };

  const FIELD_LABELS = {
    job_ref: 'Job Ref',
    region_code: 'Region',
    region_name: 'Region',
    job_type: 'Job Type',
    sla_due_date: 'SLA Due Date',
    preferred_window: 'Preferred Window',
    preferred_time_of_day: 'Preferred Window',
    candidate_count: 'Slots Evaluated',
    within_sla_available: 'Within SLA',
    best_slot: 'Recommended Slot',
    proposed_slot: 'Proposed Slot',
    new_appointment: 'Booked Appointment',
    slot_id: 'Chosen Slot',
    mode: 'Execution Mode',
    requires_human_approval: 'Human Approval',
    skipped_high_utilisation_dates: 'Skipped High-Util Dates',
    nearest_options_count: 'Alternative Options',
    nearest_options: 'Top Alternatives',
    total_candidate_slots: 'Available Slots Found',
    utilisation_threshold_pct: 'Util Threshold',
    search_start: 'Window Start',
    search_end: 'Window End',
    sample_slots: 'Earliest Options',
    d36_status: 'D36 Workflow',
    d30_status: 'D36 Workflow',
    dependency_flags: 'Dependencies',
    blocked: 'Blocked',
    blocking_reasons: 'Blocking Reasons',
    dno_status: 'DNO Status',
    dno_required: 'DNO Needed',
    dno_lead_time_days: 'DNO Lead Time',
    earliest_slot_date: 'Earliest Allowed Date',
    dno_request_id: 'DNO Request Ref',
    is_vulnerable: 'Vulnerable / PSR',
    contact_preference: 'Contact Channel',
    channel: 'Channel',
    customer_alias: 'Customer',
    cancellation_reason: 'Cancel Reason',
    abort_reason: 'Abort Reason',
    supplier_name: 'Supplier',
    engineer_id: 'Engineer',
    rebook_flag: 'Rebook Flag',
    message_status: 'Delivery Mode',
    message_text: 'Draft Message',
    category: 'Escalation Type',
    reason: 'Reason',
    step_name: 'Stage',
    tool_name: 'Action',
    decision: 'Decision',
    reasoning_summary: 'Summary',
    audit_id: 'Audit Ref',
  };

  const SKIP_IO_KEYS = new Set([
    'ok',
    'why',
    'run_id',
    'audit_entry',
    'audit_id',
    'job_ref',
    'rebook_flag',
    'candidate_slot_ids',
    'candidate_slots',
    'daily_utilisation',
    'message_preview',
  ]);

  function humanLabel(key) {
    if (FIELD_LABELS[key]) return FIELD_LABELS[key];
    return String(key).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function renderQueue(jobs) {
    const list = $('rbk-queue-list');
    const count = $('rbk-queue-count');
    if (!list) return;
    if (count) count.textContent = String(jobs.length);

    if (!jobs.length) {
      list.innerHTML = '<div class="rbk-empty-state">No jobs match the current filters.</div>';
      return;
    }

    list.innerHTML = jobs.map(j => {
      const outcome = j.agent_outcome && j.agent_outcome !== 'PENDING' ? j.agent_outcome : 'PENDING';
      const selectedCls = j.job_ref === state.selectedJobRef ? 'selected' : '';
      const scenarioTag = j.scenario_tag
        ? `<span class="rbk-pill rbk-pill-running">${esc(j.scenario_tag)}</span>`
        : '';
      const vulnTag = j.is_vulnerable
        ? '<span class="rbk-pill rbk-pill-vuln">PSR / Vulnerable</span>'
        : '';
      const dnoTag = j.dno_status && j.dno_status !== 'NOT_REQUIRED'
        ? `<span class="rbk-pill rbk-pill-dno">DNO: ${esc(CODE_HUMAN[j.dno_status] || j.dno_status)}</span>`
        : '';

      const reg = REGION_HUMAN[j.region_code] || j.region_code;
      const jt = JOB_TYPE_HUMAN[j.job_type] || j.job_type;

      return `
        <div class="rbk-queue-item ${selectedCls}" data-job-ref="${esc(j.job_ref)}">
          <div class="rbk-q-top">
            <span class="rbk-q-ref">${esc(j.job_ref)}</span>
            <span class="${statusPillClass(outcome)}">${esc(outcome.replace(/_/g, ' '))}</span>
          </div>
          <div class="rbk-q-meta">
            <strong>${esc(reg)}</strong> &middot; ${esc(jt)} &middot; ${esc(j.supplier_name)}<br/>
            Reason: ${esc(j.reason)} &middot; SLA: ${esc(j.sla_due_date)}
            ${j.scenario_label ? `<br/><em>${esc(j.scenario_label)}</em>` : ''}
          </div>
          <div class="rbk-q-tags">
            <div class="rbk-q-tag-group">
              ${scenarioTag}
              ${vulnTag}
              ${dnoTag}
            </div>
            <button type="button" class="rbk-btn rbk-btn-sm rbk-btn-primary rbk-run-one-btn" data-run-job="${esc(j.job_ref)}">Run Agent</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function formatSlotSummary(slot) {
    if (!slot || typeof slot !== 'object') return String(slot || '--');
    const date = slot.slot_date || slot.date || '';
    const win = slot.time_window || '';
    const eng = slot.engineer_name || slot.engineer_id || '';
    const util = slot.regional_utilisation_pct !== undefined && slot.regional_utilisation_pct !== null
      ? ` (${slot.regional_utilisation_pct}% util)`
      : '';
    const parts = [date, win, eng].filter(Boolean);
    if (parts.length) return `${parts.join(' · ')}${util}`;
    if (slot.slot_id) return formatSlotIdText(slot.slot_id);
    return '--';
  }

  function formatSlotIdText(idStr) {
    const m = /^SLOT-[A-Z]+-(\d{4}-\d{2}-\d{2})-([MA])-(ENG-[A-Z0-9-]+)$/.exec(String(idStr || '').trim());
    if (!m) return String(idStr || '--');
    const win = m[2] === 'M' ? 'Morning' : 'Afternoon';
    return `${m[1]} · ${win} · ${m[3]}`;
  }

  function formatIOValue(key, val) {
    if (val === null || val === undefined || val === '') return '--';
    if (typeof val === 'boolean') {
      if (key === 'requires_human_approval') return val ? 'Required' : 'Not required';
      if (key === 'blocked') return val ? 'Yes (Blocked)' : 'No (Clear)';
      return val ? 'Yes' : 'No';
    }
    if (typeof val === 'number') {
      if (key === 'utilisation_threshold_pct' || key.endsWith('_pct')) return `${val}%`;
      if (key === 'dno_lead_time_days') return `${val} day${val === 1 ? '' : 's'}`;
      return String(val);
    }
    if (Array.isArray(val)) {
      if (!val.length) return 'None';
      if (typeof val[0] === 'object' && val[0] !== null) {
        const items = val.slice(0, 3).map(formatSlotSummary);
        return val.length > 3 ? `${items.join(' | ')} (+${val.length - 3} more)` : items.join(' | ');
      }
      const shown = val.slice(0, 4).map(x => CODE_HUMAN[String(x)] || String(x));
      return val.length > 4 ? `${shown.join(', ')} (+${val.length - 4} more)` : shown.join(', ');
    }
    if (typeof val === 'object') {
      if (val.slot_date || val.time_window || val.engineer_id || val.slot_id) {
        return formatSlotSummary(val);
      }
      return Object.entries(val)
        .filter(([sk, sv]) => !SKIP_IO_KEYS.has(sk) && sv !== null && sv !== undefined && sv !== '')
        .slice(0, 4)
        .map(([sk, sv]) => `${humanLabel(sk)}: ${formatIOValue(sk, sv)}`)
        .join('; ') || '--';
    }
    const str = String(val);
    if (key === 'slot_id') return formatSlotIdText(str);
    if (key === 'region_code' || key === 'region') return REGION_HUMAN[str] || str;
    if (key === 'job_type') return JOB_TYPE_HUMAN[str] || str;
    if (key === 'required_skill') return SKILL_HUMAN[str] || str.replace(/_/g, ' ');
    if (CODE_HUMAN[str]) return CODE_HUMAN[str];
    if (str.length > 140) return str.slice(0, 137) + '...';
    return str;
  }

  function compactKV(obj) {
    if (!obj || typeof obj !== 'object') return '--';
    const hasD36 = 'd36_status' in obj;
    const entries = Object.entries(obj).filter(([k, v]) => {
      if (SKIP_IO_KEYS.has(k)) return false;
      if (hasD36 && k === 'd30_status') return false;
      if (k === 'nearest_options_count' && Array.isArray(obj.nearest_options) && obj.nearest_options.length) return false;
      return v !== null && v !== undefined && v !== '';
    });
    if (!entries.length) return '--';
    return entries.slice(0, 6).map(([k, v]) => {
      const label = humanLabel(k);
      const formatted = formatIOValue(k, v);
      return `<div><strong>${esc(label)}:</strong> ${esc(formatted)}</div>`;
    }).join('');
  }

  function renderTimeline() {
    const container = $('rbk-timeline');
    if (!container) return;

    const steps = CANONICAL_STEPS.map(s => state.timelineByStep[s] || {
      step: s,
      tool: null,
      status: 'pending',
      inputs: {},
      outputs: {},
      why: 'Not yet executed.',
    });

    const hasAny = steps.some(s => s.status !== 'pending');
    if (!hasAny && !state.selectedJobRef) {
      container.innerHTML = '<div class="rbk-empty-state">Choose any cancelled or aborted job from the queue to inspect or stream its 8-step decision trail.</div>';
      return;
    }

    container.innerHTML = steps.map((item, idx) => {
      const st = String(item.status || 'pending').toLowerCase();
      return `
        <div class="rbk-step-card status-${esc(st)}">
          <div class="rbk-step-head">
            <div>
              <span class="rbk-step-title">${idx + 1}. ${esc(STEP_TITLES[item.step] || item.step)}</span>
            </div>
            <span class="${statusPillClass(st)}">${esc(st.replace(/_/g, ' '))}</span>
          </div>
          <div class="rbk-step-why">${esc(item.why || '--')}</div>
          <div class="rbk-step-io">
            <div class="rbk-io-box">
              <div class="rbk-io-label">Inputs</div>
              ${compactKV(item.inputs)}
            </div>
            <div class="rbk-io-box">
              <div class="rbk-io-label">Outputs</div>
              ${compactKV(item.outputs)}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderApprovalAndOutcome(job) {
    const approvalBar = $('rbk-approval-bar');
    const outcomeBanner = $('rbk-outcome-banner');
    const selectedHdr = $('rbk-selected-header');
    const runBtn = $('rbk-run-selected-btn');

    if (runBtn) runBtn.disabled = !job || state.isRunning;

    if (!job) {
      if (selectedHdr) selectedHdr.textContent = 'Select a job on the left and click Run Agent';
      if (approvalBar) approvalBar.hidden = true;
      if (outcomeBanner) outcomeBanner.hidden = true;
      return;
    }

    if (selectedHdr) {
      const reg = job.region_name || REGION_HUMAN[job.region_code] || job.region_code;
      const jt = JOB_TYPE_HUMAN[job.job_type] || job.job_type;
      const prefCh = CODE_HUMAN[job.contact_preference] || job.contact_preference;
      selectedHdr.textContent = `${job.job_ref} • ${reg} • ${jt} • Preference: ${prefCh} (${job.preferred_time_of_day || 'Any'})`;
    }

    const isAwaiting = job.agent_outcome === 'AWAITING_APPROVAL' || job.status === 'Awaiting Approval';
    if (approvalBar) {
      approvalBar.hidden = !isAwaiting;
      if (isAwaiting) {
        $('rbk-approval-title').textContent = job.is_vulnerable
          ? 'Vulnerable / PSR Customer — Mandatory Human Approval'
          : 'Assisted Mode — Planner Approval Required';
        const slot = job.proposed_slot;
        $('rbk-approval-desc').textContent = slot && slot.slot_date
          ? `Proposed slot: ${slot.slot_date} (${slot.time_window}) with ${slot.engineer_name || slot.engineer_id}. Approve to commit booking.`
          : 'Review details and approve or reject.';
      }
    }

    if (outcomeBanner) {
      if (!job.agent_outcome || job.agent_outcome === 'PENDING') {
        outcomeBanner.hidden = true;
      } else {
        outcomeBanner.hidden = false;
        if (job.agent_outcome === 'REBOOKED') {
          outcomeBanner.innerHTML = `<strong>Rebooked</strong> &mdash; Slot <strong>${esc(formatSlotIdText(job.rebooked_slot_id))}</strong> on <strong>${esc(job.rebooked_date)}</strong> (${esc(job.rebooked_window)}) with <strong>${esc(job.rebooked_engineer_id)}</strong> &middot; Booking confirmed`;
        } else if (job.agent_outcome === 'ESCALATED') {
          outcomeBanner.innerHTML = `<strong>Escalated to Planner</strong> &mdash; Review the Planner Escalation Queue below for reasons and nearest slot options.`;
        } else if (job.agent_outcome === 'REJECTED') {
          outcomeBanner.innerHTML = `<strong>Rejected by Planner</strong> &mdash; Job escalated for manual resolution.`;
        } else if (job.agent_outcome === 'AWAITING_APPROVAL') {
          const modeLabel = (job.agent_mode || state.mode) === 'autonomous' ? 'Autonomous Mode' : 'Assisted Mode';
          outcomeBanner.innerHTML = `<strong>Status:</strong> Awaiting Planner Approval (${esc(modeLabel)})`;
        } else {
          outcomeBanner.innerHTML = `<strong>Status:</strong> ${esc(String(job.agent_outcome).replace(/_/g, ' '))} (${esc(job.agent_mode || state.mode)} mode)`;
        }
      }
    }
  }

  function renderRightPane(job, dailyUtil, chosenSlot) {
    const slot = chosenSlot || (job && job.rebooked_slot_id ? {
      slot_id: job.rebooked_slot_id,
      slot_date: job.rebooked_date,
      time_window: job.rebooked_window,
      engineer_id: job.rebooked_engineer_id,
      within_sla: job.sla_safe,
    } : (job && job.proposed_slot && job.proposed_slot.slot_id ? job.proposed_slot : null));

    const slotCard = $('rbk-chosen-slot-card');
    if (slotCard) {
      if (slot && slot.slot_id) {
        const committed = Boolean(job && job.rebook_flag);
        slotCard.innerHTML = `
          <div><strong>${committed ? 'Confirmed Rebooked Slot' : 'Proposed Slot'}:</strong> <strong>${esc(slot.slot_date)}</strong> &middot; <strong>${esc(slot.time_window)}</strong></div>
          <div style="margin-top:4px;">
            Engineer: <strong>${esc(slot.engineer_name || slot.engineer_id || 'Assigned Engineer')}</strong>
          </div>
          ${slot.regional_utilisation_pct !== undefined ? `<div style="margin-top:2px;color:var(--text-secondary);">Region Utilisation: <strong>${esc(slot.regional_utilisation_pct)}%</strong> &middot; SLA: ${slot.within_sla ? 'Within SLA' : 'Check SLA'}</div>` : ''}
        `;
      } else {
        slotCard.innerHTML = '<span class="rbk-muted">No slot selected yet.</span>';
      }
    }

    // Message Preview
    const msgCh = $('rbk-msg-channel');
    const msgSim = $('rbk-msg-sim-badge');
    const msgMeta = $('rbk-msg-meta');
    const msgPrev = $('rbk-msg-preview');
    const editorWrap = $('rbk-msg-editor-wrap');
    if (editorWrap) editorWrap.hidden = true;

    const msgText = job && job.customer_message ? job.customer_message : '';
    const msgStatus = (job && job.message_status) || 'Simulated send';
    const channel = (job && (job.customer_message_channel || job.contact_preference)) || '--';

    if (msgCh) msgCh.textContent = channel;
    if (msgSim) msgSim.textContent = msgStatus.includes('Simulated') ? msgStatus : `Simulated send (${msgStatus})`;
    if (msgMeta) {
      msgMeta.textContent = job
        ? `Customer: ${job.customer_alias || job.job_ref} • Never dispatched externally`
        : 'Drafted after slot decision';
    }
    if (msgPrev) {
      msgPrev.hidden = false;
      msgPrev.textContent = '';
      if (msgText) {
        msgPrev.textContent = msgText;
      } else {
        msgPrev.innerHTML = '<span class="rbk-muted">Run the agent on a rebookable job to preview the drafted customer notification.</span>';
      }
    }

    // 28-Day Utilisation Chart
    const sub = $('rbk-util-subtitle');
    if (sub) {
      sub.textContent = job
        ? `${job.region_name || job.region_code} (${job.region_code}) • Next 28 days vs ${state.utilThreshold}% threshold`
        : `Region capacity vs ${state.utilThreshold}% threshold`;
    }

    const canvas = $('rbk-util-chart');
    if (!canvas || typeof Chart === 'undefined' || !window.EXL) return;

    if (window.EXL.destroyChart) window.EXL.destroyChart('rbkUtil');
    const existingChart = Chart.getChart ? Chart.getChart(canvas) : null;
    if (existingChart) existingChart.destroy();

    const theme = window.EXL.getTheme ? window.EXL.getTheme() : 'light';
    const palette = (window.EXL.themeChartPalettes && window.EXL.themeChartPalettes[theme]) || window.EXL.colors || {};
    const rows = Array.isArray(dailyUtil) ? dailyUtil : [];
    const chosenDate = slot && slot.slot_date ? String(slot.slot_date) : '';

    const labels = rows.map(r => (r.slot_date || '').slice(5));
    const values = rows.map(r => Number(r.utilisation_pct || 0));
    const thresholdLine = rows.map(() => state.utilThreshold);
    const barColors = rows.map(r => {
      if (r.slot_date === chosenDate) return '#16a34a';
      if (Number(r.utilisation_pct || 0) >= state.utilThreshold) return '#dc2626';
      return palette.accent || '#004EFF';
    });

    const chart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Regional Utilisation %',
            data: values,
            backgroundColor: barColors,
            borderRadius: 4,
            order: 2,
          },
          {
            type: 'line',
            label: `${state.utilThreshold}% Threshold`,
            data: thresholdLine,
            borderColor: '#f59e0b',
            borderWidth: 1.5,
            borderDash: [5, 4],
            pointRadius: 0,
            fill: false,
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              afterLabel: ctx => {
                const row = rows[ctx.dataIndex];
                if (!row || ctx.datasetIndex !== 0) return '';
                const tag = row.slot_date === chosenDate ? ' ★ CHOSEN SLOT' : '';
                return `Available slots: ${row.total_available ?? 0}${tag}`;
              },
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            max: 105,
            ticks: { callback: v => `${v}%`, font: { size: 10 } },
          },
          x: {
            ticks: { maxRotation: 45, minRotation: 0, font: { size: 10 } },
          },
        },
      },
    });
    window.EXL.registerChart('rbkUtil', chart);
  }

  function renderEscalations(escalations) {
    const list = $('rbk-escalation-list');
    const badge = $('rbk-esc-count');
    const openOnly = escalations.filter(e => e.status === 'OPEN');
    if (badge) badge.textContent = String(openOnly.length);
    if (!list) return;

    if (!escalations.length) {
      list.innerHTML = '<div class="rbk-empty-state">No escalations yet.</div>';
      return;
    }

    list.innerHTML = escalations.map(e => {
      const opts = Array.isArray(e.nearest_options) ? e.nearest_options : [];
      const optHtml = e.status === 'OPEN' && opts.length
        ? `<div class="rbk-esc-options">${opts.map(opt => `
            <div class="rbk-esc-opt">
              <span><strong>${esc(opt.slot_date)}</strong> (${esc(opt.time_window)}) &middot; ${esc(opt.engineer_name || opt.engineer_id)} &middot; Utilisation ${esc(opt.regional_utilisation_pct)}%</span>
              <button type="button" class="rbk-btn rbk-btn-sm rbk-btn-ok rbk-esc-book-btn" data-esc-id="${esc(e.escalation_id)}" data-slot-id="${esc(opt.slot_id)}">Book Option</button>
            </div>
          `).join('')}</div>`
        : '';
      const resolveBtn = e.status === 'OPEN'
        ? `<button type="button" class="rbk-btn rbk-btn-sm rbk-btn-ghost rbk-esc-resolve-btn" data-esc-id="${esc(e.escalation_id)}">Resolve</button>`
        : `<span class="rbk-pill rbk-pill-ok">${esc(e.status)}</span>`;

      return `
        <div class="rbk-esc-card">
          <div class="rbk-esc-head">
            <div>
              <strong>${esc(e.job_ref)}</strong> &middot; <span class="rbk-pill rbk-pill-blocked">${esc(CODE_HUMAN[e.category] || (e.category || '').replace(/_/g, ' '))}</span> &middot; ${esc(REGION_HUMAN[e.region_code] || e.region_code)}
            </div>
            ${resolveBtn}
          </div>
          <div style="color:var(--text-secondary);">${esc(e.reason)}</div>
          ${e.resolution_note ? `<div style="margin-top:4px;color:var(--ok);">Resolution: ${esc(e.resolution_note)}</div>` : ''}
          ${optHtml}
        </div>
      `;
    }).join('');
  }

  function renderAudit(entries) {
    const tbody = $('rbk-audit-tbody');
    if (!tbody) return;
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="rbk-muted">No matching audit entries.</td></tr>';
      return;
    }
    tbody.innerHTML = entries.map(a => `
      <tr>
        <td>${esc((a.created_at || '').replace('T', ' ').slice(0, 19))}</td>
        <td><strong>${esc(a.job_ref)}</strong></td>
        <td>${esc(a.step_name)}</td>
        <td>${esc(humanToolName(a.tool_name))}</td>
        <td><span class="${statusPillClass(a.status)}">${esc((a.status || '').replace(/_/g, ' '))}</span></td>
        <td>${esc(a.reasoning_summary || a.decision || '')}</td>
      </tr>
    `).join('');
  }

  async function refreshJobsAndKPIs() {
    const params = new URLSearchParams();
    const region = $('rbk-filter-region')?.value || '';
    const reason = $('rbk-filter-reason')?.value || '';
    const status = $('rbk-filter-status')?.value || '';
    if (region) params.set('region', region);
    if (reason) params.set('reason', reason);
    if (status) params.set('status', status);

    const data = await rbkFetch(`/api/rebooking-agent/jobs?${params.toString()}`);
    if (!state.configLoaded && data.config) {
      state.configLoaded = true;
      state.mockLlm = Boolean(data.config.mock_llm);
      state.utilThreshold = Number(data.config.utilisation_threshold_pct || 90);
      renderSegmentedControls();
    }
    state.jobs = data.jobs || [];
    populateQueueFilters(data.filters);
    renderKPIs(data.kpis);
    renderQueue(state.jobs);

    if (!state.selectedJobRef && state.jobs.length) {
      await selectJob(state.jobs[0].job_ref);
    }
  }

  async function refreshEscalations() {
    const data = await rbkFetch('/api/rebooking-agent/escalations');
    state.escalations = data.escalations || [];
    renderEscalations(state.escalations);
  }

  async function refreshAudit() {
    const params = new URLSearchParams();
    const jobRef = $('rbk-audit-job')?.value.trim() || '';
    const step = $('rbk-audit-step')?.value || '';
    const status = $('rbk-audit-status')?.value || '';
    if (jobRef) params.set('job_ref', jobRef);
    if (step) params.set('step', step);
    if (status) params.set('status', status);
    const data = await rbkFetch(`/api/rebooking-agent/audit?${params.toString()}`);
    state.audit = data.entries || [];
    renderAudit(state.audit);
  }

  async function selectJob(jobRef) {
    state.selectedJobRef = jobRef;
    renderQueue(state.jobs);
    hideError();

    const detail = await rbkFetch(`/api/rebooking-agent/jobs/${encodeURIComponent(jobRef)}`);
    state.selectedDetail = detail;
    const job = detail.job;

    state.timelineByStep = emptyTimelineMap();
    if (Array.isArray(job.last_reasoning) && job.last_reasoning.length) {
      job.last_reasoning.forEach(item => {
        const stepName = item && (item.step === 'Dependencies/D30' ? 'Dependencies/D36' : item.step);
        if (stepName) state.timelineByStep[stepName] = item;
      });
    }

    renderTimeline();
    renderApprovalAndOutcome(job);
    renderRightPane(job, detail.daily_utilisation, null);
  }

  function closeActiveStream() {
    if (state.activeSource) {
      state.activeSource.close();
      state.activeSource = null;
    }
  }

  function streamAgentForJob(jobRef, delayOverride = null) {
    return new Promise(resolve => {
      closeActiveStream();
      hideError();
      state.selectedJobRef = jobRef;
      state.isRunning = true;
      state.timelineByStep = emptyTimelineMap();
      renderQueue(state.jobs);
      renderTimeline();
      setRunStatus(`Running ${jobRef}...`, true);
      if ($('rbk-run-selected-btn')) $('rbk-run-selected-btn').disabled = true;

      const delay = delayOverride !== null ? delayOverride : (state.mockLlm ? 0.08 : 0.0);
      const url = `/api/rebooking-agent/stream/${encodeURIComponent(jobRef)}?mode=${encodeURIComponent(state.mode)}&mock_llm=${state.mockLlm}&delay=${delay}`;
      const es = new EventSource(url);
      state.activeSource = es;
      let finished = false;

      es.addEventListener('step_started', e => {
        const d = JSON.parse(e.data);
        const stepKey = d.step === 'Dependencies/D30' ? 'Dependencies/D36' : d.step;
        state.timelineByStep[stepKey] = {
          step: stepKey,
          tool: d.tool,
          status: 'running',
          inputs: {},
          outputs: {},
          why: d.why || 'Executing...',
        };
        renderTimeline();
      });

      es.addEventListener('step_completed', e => {
        const d = JSON.parse(e.data);
        const stepKey = d.step === 'Dependencies/D30' ? 'Dependencies/D36' : d.step;
        state.timelineByStep[stepKey] = d;
        renderTimeline();
      });

      es.addEventListener('run_completed', async e => {
        finished = true;
        closeActiveStream();
        const d = JSON.parse(e.data);
        if (Array.isArray(d.timeline)) {
          d.timeline.forEach(s => {
            const stepKey = s.step === 'Dependencies/D30' ? 'Dependencies/D36' : s.step;
            state.timelineByStep[stepKey] = s;
          });
        }
        state.isRunning = false;
        setRunStatus(`${jobRef}: ${d.outcome}`, false);
        renderTimeline();
        renderApprovalAndOutcome(d.job);
        renderRightPane(d.job, d.daily_utilisation, d.chosen_slot);
        await Promise.all([refreshJobsAndKPIs(), refreshEscalations(), refreshAudit()]);
        resolve({ ok: true, outcome: d.outcome });
      });

      es.addEventListener('error', e => {
        if (finished) return;
        finished = true;
        closeActiveStream();
        state.isRunning = false;
        let msg = 'Agent stream interrupted or Live LLM failed to respond.';
        if (e && e.data) {
          try {
            const payload = JSON.parse(e.data);
            msg = payload.friendly_message || payload.error || msg;
          } catch (_) { /* ignore parse error */ }
        }
        showError(msg);
        setRunStatus('Error / Timeout', false);
        refreshAudit();
        if ($('rbk-run-selected-btn')) $('rbk-run-selected-btn').disabled = false;
        resolve({ ok: false, error: msg });
      });
    });
  }

  async function runOnAll() {
    if (state.runningAll || state.isRunning) return;
    state.runningAll = true;
    const btn = $('rbk-run-all-btn');
    if (btn) btn.disabled = true;
    try {
      const targets = state.jobs.filter(j => !j.agent_outcome || j.agent_outcome === 'PENDING');
      const queue = targets.length ? targets : state.jobs;
      for (let i = 0; i < queue.length; i += 1) {
        setRunStatus(`Batch ${i + 1}/${queue.length}: ${queue[i].job_ref}`, true);
        const res = await streamAgentForJob(queue[i].job_ref, 0.02);
        if (!res.ok) break;
      }
      setRunStatus('Batch complete', false);
    } finally {
      state.runningAll = false;
      if (btn) btn.disabled = false;
    }
  }

  async function approveSelected() {
    if (!state.selectedJobRef) return;
    hideError();
    const btn = $('rbk-btn-approve');
    if (btn) btn.disabled = true;
    try {
      const edited = !$('rbk-msg-editor-wrap')?.hidden ? $('rbk-msg-textarea')?.value : undefined;
      const data = await rbkFetch(`/api/rebooking-agent/jobs/${encodeURIComponent(state.selectedJobRef)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edited ? { edited_message: edited } : {}),
      });
      renderKPIs(data.kpis);
      await Promise.all([selectJob(state.selectedJobRef), refreshJobsAndKPIs(), refreshEscalations(), refreshAudit()]);
      setRunStatus(`Approved ${state.selectedJobRef}`, false);
    } catch (err) {
      showError(err.message || 'Failed to approve & execute booking.');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function rejectSelected() {
    if (!state.selectedJobRef) return;
    hideError();
    const btn = $('rbk-btn-reject');
    if (btn) btn.disabled = true;
    try {
      const data = await rbkFetch(`/api/rebooking-agent/jobs/${encodeURIComponent(state.selectedJobRef)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Rejected by planner in Assisted review' }),
      });
      renderKPIs(data.kpis);
      await Promise.all([selectJob(state.selectedJobRef), refreshJobsAndKPIs(), refreshEscalations(), refreshAudit()]);
      setRunStatus(`Rejected ${state.selectedJobRef}`, false);
    } catch (err) {
      showError(err.message || 'Failed to reject booking proposal.');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function saveEditedMessage() {
    if (!state.selectedJobRef) return;
    hideError();
    const text = $('rbk-msg-textarea')?.value.trim();
    if (!text) return;
    try {
      await rbkFetch(`/api/rebooking-agent/jobs/${encodeURIComponent(state.selectedJobRef)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if ($('rbk-msg-editor-wrap')) $('rbk-msg-editor-wrap').hidden = true;
      await selectJob(state.selectedJobRef);
    } catch (err) {
      showError(err.message || 'Failed to save customer message.');
    }
  }

  async function resolveEscalation(escId, slotId = null) {
    hideError();
    try {
      const data = await rbkFetch(`/api/rebooking-agent/escalations/${encodeURIComponent(escId)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slotId ? { slot_id: slotId, resolution_note: `Planner booked ${slotId}` } : { resolution_note: 'Resolved manually by planner' }),
      });
      renderKPIs(data.kpis);
      await Promise.all([refreshJobsAndKPIs(), refreshEscalations(), refreshAudit()]);
      if (state.selectedJobRef) await selectJob(state.selectedJobRef);
    } catch (err) {
      showError(err.message || 'Failed to resolve escalation.');
    }
  }

  async function resetDemo() {
    closeActiveStream();
    hideError();
    try {
      const data = await rbkFetch('/api/rebooking-agent/reset', { method: 'POST' });
      state.selectedJobRef = null;
      state.timelineByStep = emptyTimelineMap();
      renderKPIs(data.kpis);
      await Promise.all([refreshJobsAndKPIs(), refreshEscalations(), refreshAudit()]);
      setRunStatus('Demo Reset Ready', false);
    } catch (err) {
      showError(err.message || 'Failed to reset demo queue.');
    }
  }

  function exportAuditCSV() {
    const params = new URLSearchParams();
    const jobRef = $('rbk-audit-job')?.value.trim() || '';
    const step = $('rbk-audit-step')?.value || '';
    const status = $('rbk-audit-status')?.value || '';
    if (jobRef) params.set('job_ref', jobRef);
    if (step) params.set('step', step);
    if (status) params.set('status', status);
    params.set('format', 'csv');
    window.location.href = `/api/rebooking-agent/audit?${params.toString()}`;
  }

  function bindEventsOnce() {
    if (state.initialized) return;
    state.initialized = true;

    $('rbk-mode-assisted')?.addEventListener('click', () => {
      state.mode = 'assisted';
      renderSegmentedControls();
    });
    $('rbk-mode-autonomous')?.addEventListener('click', () => {
      state.mode = 'autonomous';
      renderSegmentedControls();
    });
    $('rbk-llm-mock')?.addEventListener('click', () => {
      state.mockLlm = true;
      renderSegmentedControls();
    });
    $('rbk-llm-live')?.addEventListener('click', () => {
      state.mockLlm = false;
      renderSegmentedControls();
    });

    $('rbk-run-all-btn')?.addEventListener('click', runOnAll);
    $('rbk-reset-btn')?.addEventListener('click', resetDemo);
    $('rbk-run-selected-btn')?.addEventListener('click', () => {
      if (state.selectedJobRef) streamAgentForJob(state.selectedJobRef);
    });
    $('rbk-retry-mock-btn')?.addEventListener('click', () => {
      state.mockLlm = true;
      renderSegmentedControls();
      hideError();
      if (state.selectedJobRef) streamAgentForJob(state.selectedJobRef);
    });

    ['rbk-filter-region', 'rbk-filter-reason', 'rbk-filter-status'].forEach(id => {
      $(id)?.addEventListener('change', refreshJobsAndKPIs);
    });
    ['rbk-audit-step', 'rbk-audit-status'].forEach(id => {
      $(id)?.addEventListener('change', refreshAudit);
    });
    $('rbk-audit-job')?.addEventListener('input', refreshAudit);
    $('rbk-audit-export-btn')?.addEventListener('click', exportAuditCSV);

    $('rbk-btn-approve')?.addEventListener('click', approveSelected);
    $('rbk-btn-reject')?.addEventListener('click', rejectSelected);
    $('rbk-btn-edit-msg')?.addEventListener('click', () => {
      const wrap = $('rbk-msg-editor-wrap');
      const ta = $('rbk-msg-textarea');
      if (!wrap || !ta) return;
      ta.value = state.selectedDetail?.job?.customer_message || $('rbk-msg-preview')?.textContent || '';
      wrap.hidden = false;
    });
    $('rbk-btn-cancel-msg')?.addEventListener('click', () => {
      if ($('rbk-msg-editor-wrap')) $('rbk-msg-editor-wrap').hidden = true;
    });
    $('rbk-btn-save-msg')?.addEventListener('click', saveEditedMessage);

    $('rbk-queue-list')?.addEventListener('click', e => {
      const runBtn = e.target.closest('.rbk-run-one-btn');
      if (runBtn) {
        e.stopPropagation();
        const ref = runBtn.dataset.runJob;
        if (ref) streamAgentForJob(ref);
        return;
      }
      const card = e.target.closest('.rbk-queue-item');
      if (card && card.dataset.jobRef) {
        selectJob(card.dataset.jobRef);
      }
    });

    $('rbk-escalation-list')?.addEventListener('click', e => {
      const bookBtn = e.target.closest('.rbk-esc-book-btn');
      if (bookBtn) {
        resolveEscalation(bookBtn.dataset.escId, bookBtn.dataset.slotId);
        return;
      }
      const resBtn = e.target.closest('.rbk-esc-resolve-btn');
      if (resBtn) {
        resolveEscalation(resBtn.dataset.escId, null);
      }
    });
  }

  async function loadRebookingAgentDashboard() {
    bindEventsOnce();
    renderSegmentedControls();
    await Promise.all([refreshJobsAndKPIs(), refreshEscalations(), refreshAudit()]);
    if (state.selectedJobRef) {
      await selectJob(state.selectedJobRef);
    }
  }

  window.loadRebookingAgentDashboard = loadRebookingAgentDashboard;
})();
