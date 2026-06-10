/* EXL - Main Application Controller */

const VIEW_CONFIG = {
  journey: { title: 'Smart Meter Appointment Journey Overview', breadcrumb: 'EXL / Appointments / Appointment Journey', loader: loadJourneyDashboard },
  forecasting: { title: 'Appointment and Resource Planning', breadcrumb: 'EXL / Planning / Contact Attempt Forecast and Capacity', loader: loadFieldOpsDashboard },
  cancellations: { title: 'Appointment Fallout Risk and Recovery', breadcrumb: 'EXL / Appointments / Risk and Recovery', loader: loadCancellationsDashboard },
  'field-ops': { title: 'Appointment and Resource Planning', breadcrumb: 'EXL / Planning / Contact Attempt Forecast and Capacity', loader: loadFieldOpsDashboard },
  financial: { title: 'Appointment and Resource Financial Planning', breadcrumb: 'EXL / Finance / Scenario Impact', loader: loadFinancialDashboard },
  timeslot:  { title: 'Dialler Performance', breadcrumb: 'EXL / Appointments / Dialler Performance', loader: loadTimeslotDashboard },
  meterview: { title: 'Single Meter View', breadcrumb: 'EXL / Meters / Single Meter View', loader: loadMeterViewDashboard },
};

const VIEW_LOADING_TARGETS = {
  journey: [
    'journey-kpis',
    'funnel-chart',
    'journey-trend-chart',
    'regional-heatmap-grid',
    'decomposition-tree-container',
    'supplier-behaviour-grid',
  ],
  timeslot: [
    'ts-summary-kpis',
    'ts-outcome-grid',
    'ts-channel-grid',
    'ts-biz-wrap',
    'ts-attempts-grid',
    'ts-agent-grid',
  ],
  cancellations: [
    'cancel-kpis',
    'pareto-chart',
    'category-chart',
    'recovery-constellation-stage',
    'cancel-trend-chart',
    'cancel-risk-panel',
    'fe-kpi-strip',
    '.fe-table-wrap',
  ],
  'field-ops': [
    '#view-field-ops .pt-outer',
    'lt-kpi-strip',
    'lt-trend-chart',
    'lt-region-chart',
    'lt-slot-m-chart',
    'lt-slot-a-chart',
    'lt-slot-e-chart',
    'lt-detail-body',
    'capacity-forecast-chart',
    'resource-gap-chart',
    'capacity-matrix-chart',
    'patch-plan-body',
    'engineer-perf-body',
    'optimise-body',
  ],
  financial: [
    'fin-kpis',
    'fin-monthly-chart',
    'fin-jobtype-chart',
    'forecast-profit-chart',
  ],
  meterview: [
    'mv-results',
  ],
};

let _currentView = 'journey';
let _sidebarResizeObserver = null;
let _globalFilterOptions = { months: [], forecast_months: [] };
const _viewLoadKeys = new Map();

function getViewYear(viewName) {
  return ['forecasting', 'field-ops', 'financial'].includes(viewName) ? 2026 : 2025;
}

function getViewLoadKey(viewName) {
  return `${viewName}|${EXL.getRegion()}|${EXL.getMonth()}|${getViewYear(viewName)}`;
}

function invalidateLoadedViews() {
  _viewLoadKeys.clear();
  if (typeof invalidateForecastLoadState === 'function') invalidateForecastLoadState();
  if (typeof invalidateOpsLoadState === 'function') invalidateOpsLoadState();
}

function loadViewData(viewName, force = false) {
  const config = VIEW_CONFIG[viewName];
  if (!config?.loader) return Promise.resolve();

  const key = getViewLoadKey(viewName);
  if (!force && _viewLoadKeys.get(viewName) === key) {
    return Promise.resolve();
  }

  _viewLoadKeys.set(viewName, key);
  setViewLoading(viewName, true);
  const result = config.loader(force);
  if (result?.then) {
    return Promise.resolve(result)
      .catch(err => {
        _viewLoadKeys.delete(viewName);
        throw err;
      })
      .finally(() => setViewLoading(viewName, false));
  }
  if (!result?.then) {
    setViewLoading(viewName, false);
  }
  return result;
}

function setViewLoading(viewName, isLoading, label = 'Loading...') {
  const targets = VIEW_LOADING_TARGETS[viewName] || [];
  if (targets.length && window.EXL?.setLoading) {
    EXL.setLoading(targets, isLoading, label);
  }
}

function syncSidebarWidth() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const width = Math.ceil(sidebar.getBoundingClientRect().width);
  document.documentElement.style.setProperty('--nav-current-width', `${width}px`);
}

function initFluidSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  updateSidebarControls();
  syncSidebarWidth();
  if ('ResizeObserver' in window) {
    _sidebarResizeObserver?.disconnect();
    _sidebarResizeObserver = new ResizeObserver(syncSidebarWidth);
    _sidebarResizeObserver.observe(sidebar);
  }
  window.addEventListener('resize', syncSidebarWidth);
  document.fonts?.ready?.then(syncSidebarWidth);
}

function updateSidebarControls() {
  const sidebar = document.getElementById('sidebar');
  const collapsed = sidebar?.classList.contains('collapsed') || false;
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  const icon = collapsed ? 'panelLeftOpen' : 'panelLeftClose';

  document.querySelectorAll('#sidebar-toggle, #sidebar-header-toggle').forEach(control => {
    control.setAttribute('aria-expanded', String(!collapsed));
    control.setAttribute('title', label);
  });

  document.querySelectorAll('.sidebar-toggle-label').forEach(el => {
    el.textContent = collapsed ? 'Expand Sidebar' : 'Collapse Sidebar';
  });

  document.querySelectorAll('.sidebar-toggle-icon').forEach(el => {
    if (window.EXL?.iconSvg) {
      el.innerHTML = EXL.iconSvg(icon);
      el.classList.add('modern-icon');
      el.dataset.iconReady = 'true';
    }
  });
}

function switchPlanningSubtab(tab) {
  document.querySelectorAll('.pst-panel').forEach(p => p.classList.remove('pst-panel--active'));
  document.querySelectorAll('.pst-btn').forEach(b => b.classList.remove('pst-btn--active'));
  const panel = document.getElementById('pstab-' + tab);
  if (panel) panel.classList.add('pst-panel--active');
  const btn = document.querySelector(`.pst-btn[data-tab="${tab}"]`);
  if (btn) btn.classList.add('pst-btn--active');
  if (tab === 'shortterm') loadRosterTimeline();
  if (tab === 'longterm')  loadLongTermPlanning();
}

function activateSidebarSubnav(viewName, tabName) {
  document.querySelectorAll('.nav-subitem').forEach(n => n.classList.remove('active'));
  if (!viewName || !tabName) return;
  const item = document.querySelector(`.nav-subitem[data-parent="${viewName}"][data-subtab="${tabName}"]`);
  if (item) item.classList.add('active');
}

function switchView(viewName, navEl) {
  if (viewName === 'forecasting') viewName = 'field-ops';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item[data-view]').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.nav-subitem').forEach(n => n.classList.remove('active'));

  const view = document.getElementById('view-' + viewName);
  if (view) view.classList.add('active');
  const mainNav = navEl?.dataset?.view === viewName
    ? navEl
    : document.querySelector(`.nav-item[data-view="${viewName}"]`);
  if (mainNav) mainNav.classList.add('active');

  const config = VIEW_CONFIG[viewName];
  if (config) {
    const titleEl = document.getElementById('page-title');
    const breadEl = document.getElementById('page-breadcrumb');
    if (titleEl) titleEl.textContent = config.title;
    if (breadEl) breadEl.textContent = config.breadcrumb;
  }

  _currentView = viewName;
  updateHeaderFiltersForView(viewName);
  refreshGlobalMonthOptions(viewName);
  loadViewData(viewName);
  if (viewName === 'field-ops') activateSidebarSubnav(viewName, typeof _activeOpsTab !== 'undefined' ? _activeOpsTab : 'capacity');
}

function updateHeaderFiltersForView(viewName) {
  const regionSel = document.getElementById('global-region');
  const monthSel = document.getElementById('global-month');
  if (!regionSel && !monthSel) return;

  const hideRegion = viewName === 'meterview';
  const hideMonth = viewName === 'field-ops' || viewName === 'forecasting' || viewName === 'timeslot';
  const clearAndToggle = (select, hidden) => {
    if (!select) return;
    if (hidden && select.value) select.value = '';
    select.hidden = hidden;
    select.disabled = hidden;
    select.setAttribute('aria-hidden', String(hidden));
  };

  clearAndToggle(regionSel, hideRegion);
  clearAndToggle(monthSel, hideMonth || viewName === 'meterview');
}

function monthOptionsForView(viewName) {
  return viewName === 'financial'
    ? (_globalFilterOptions.forecast_months || [])
    : (_globalFilterOptions.months || []);
}

function refreshGlobalMonthOptions(viewName = _currentView) {
  const monthSel = document.getElementById('global-month');
  if (!monthSel) return;
  const previous = monthSel.value;
  const options = monthOptionsForView(viewName);
  const allLabel = viewName === 'financial' ? 'All Future Months' : 'All Months';
  monthSel.innerHTML = `<option value="">${allLabel}</option>`;
  options.forEach(({ value, label }) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    monthSel.appendChild(opt);
  });
  monthSel.value = options.some(opt => opt.value === previous) ? previous : '';
}

function onRegionChange() {
  invalidateLoadedViews();
  refreshCurrentView();
  if (document.getElementById('pstab-shortterm')?.classList.contains('pst-panel--active')) {
    if (typeof loadRosterTimeline === 'function') loadRosterTimeline();
  }
  if (document.getElementById('pstab-longterm')?.classList.contains('pst-panel--active')) {
    if (typeof loadLongTermPlanning === 'function') loadLongTermPlanning();
  }
}

function onMonthChange() {
  invalidateLoadedViews();
  refreshCurrentView();
}

function onJourneySupplierChange() {
  if (typeof loadJourneySuppliersOnly === 'function') loadJourneySuppliersOnly(true);
}

async function populateGlobalFilters() {
  try {
    const data = await fetch('/api/filters').then(r => r.json());
    _globalFilterOptions = {
      months: data.months || [],
      forecast_months: data.forecast_months || data.months || [],
    };

    refreshGlobalMonthOptions(_currentView);

    const supplierSel = document.getElementById('journey-supplier-filter');
    if (supplierSel) {
      (data.suppliers || []).forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        supplierSel.appendChild(opt);
      });
    }
  } catch (e) {
    console.warn('Could not load global filters:', e);
  }
}

function onYearChange() {
  invalidateLoadedViews();
  refreshCurrentView();
}

function refreshCurrentView(force = true) {
  if (force) invalidateLoadedViews();
  loadViewData(_currentView, force);
}

function exportCurrentView() {
  const links = {
    journey: '/api/journey/kpis',
    forecasting: '/api/forecasting/channel-kpis',
    cancellations: '/api/cancellations/kpis',
    'field-ops': '/api/field-ops/kpis',
    financial: '/api/financial/kpis',
  };
  const url = links[_currentView];
  if (url) window.open(url + '?format=csv', '_blank');
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.toggle('collapsed');
  updateSidebarControls();
  requestAnimationFrame(syncSidebarWidth);
  window.setTimeout(syncSidebarWidth, 280);
}

function openAiPanel() {
  const overlay = document.getElementById('ai-modal');
  if (!overlay) return;
  overlay.classList.add('open');
  loadAiModal();
}

function closeAiPanel() {
  const overlay = document.getElementById('ai-modal');
  if (overlay) overlay.classList.remove('open');
}

async function loadAiModal() {
  const body = document.getElementById('ai-modal-body');
  if (!body) return;
  body.innerHTML = '<div class="loading"><span class="spinner"></span> Generating AI insights...</div>';

  const year = EXL.getYear();
  const ai = await EXL.apiFetch('/api/ai/dashboard?year=' + year + '&max=15');
  const recs = ai?.recommendations;
  if (recs && typeof updateAiTriggerState === 'function') updateAiTriggerState(recs);

  if (!recs) {
    body.innerHTML = '<div class="empty-state"><div class="empty-icon"></div><div class="empty-title">Could not load recommendations</div></div>';
    EXL.hydrateIcons(body);
    return;
  }

  const summaryHtml = ai?.summary ? `
    <div class="ai-summary-bar mb-16">
      <div class="ai-icon"></div>
      <div class="ai-text">${ai.summary}</div>
    </div>
  ` : '';

  const recsHtml = (recs.recommendations || []).map(r => `
    <div class="rec-card ${r.priority}">
      <div class="rec-icon"></div>
      <div class="rec-body">
        <div class="rec-title">${r.title}</div>
        <div class="rec-desc">${r.body}</div>
        <div class="rec-meta">
          <span class="priority ${r.priority}">${r.priority}</span>
          ${r.region_code ? `<span class="stat-chip">Region: <strong>${r.region_code}</strong></span>` : ''}
          ${r.metric_value != null ? `<span class="rec-metric">${r.metric_label}: ${r.metric_value}</span>` : ''}
          ${r.action_required ? '<span class="rag Red">Action Required</span>' : ''}
        </div>
      </div>
    </div>
  `).join('');

  body.innerHTML = summaryHtml + `
    <div class="d-flex gap-8 mb-12 flex-wrap">
      <span class="stat-chip">Critical: <strong>${recs.critical_count}</strong></span>
      <span class="stat-chip">High: <strong>${recs.high_count}</strong></span>
      <span class="stat-chip">Action Required: <strong>${recs.action_required_count}</strong></span>
    </div>
    <div class="rec-list">${recsHtml}</div>
  `;
  EXL.hydrateIcons(body);
}

document.getElementById('ai-modal')?.addEventListener('click', function (e) {
  if (e.target === this) closeAiPanel();
});

let _chatbotHistory = [];
let _chatbotBusy = false;

function escapeChatHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function formatChatInlineMarkdown(value = '') {
  return escapeChatHtml(value)
    .replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n][\s\S]*?[^_\n])__/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
}

function formatChatMarkdown(value = '') {
  const lines = String(value).replace(/\r\n?/g, '\n').split('\n');
  const parts = [];
  let paragraph = [];
  let listType = null;

  const closeParagraph = () => {
    if (!paragraph.length) return;
    parts.push(`<p>${paragraph.map(formatChatInlineMarkdown).join('<br>')}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listType) return;
    parts.push(`</${listType}>`);
    listType = null;
  };
  const ensureList = type => {
    closeParagraph();
    if (listType === type) return;
    closeList();
    parts.push(`<${type}>`);
    listType = type;
  };

  lines.forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) {
      closeParagraph();
      closeList();
      return;
    }

    const bullet = line.match(/^[-*\u2022]\s+(.+)$/);
    if (bullet) {
      ensureList('ul');
      parts.push(`<li>${formatChatInlineMarkdown(bullet[1])}</li>`);
      return;
    }

    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      ensureList('ol');
      parts.push(`<li>${formatChatInlineMarkdown(numbered[1])}</li>`);
      return;
    }

    closeList();
    paragraph.push(line);
  });

  closeParagraph();
  closeList();
  return parts.join('');
}

function toggleChatbot(forceOpen) {
  const widget = document.getElementById('chatbot-widget');
  const launcher = document.getElementById('chatbot-launcher');
  const input = document.getElementById('chatbot-input');
  if (!widget) return;

  const open = forceOpen == null ? !widget.classList.contains('open') : Boolean(forceOpen);
  widget.classList.toggle('open', open);
  launcher?.setAttribute('aria-expanded', String(open));
  if (open) window.setTimeout(() => input?.focus(), 120);
}

function setChatbotStatus(label, busy = false) {
  const status = document.getElementById('chatbot-status');
  const send = document.getElementById('chatbot-send');
  const input = document.getElementById('chatbot-input');
  if (status) status.textContent = label;
  if (send) send.disabled = busy;
  if (input) input.disabled = busy;
  _chatbotBusy = busy;
}

function appendChatMessage(role, content, options = {}) {
  const messages = document.getElementById('chatbot-messages');
  if (!messages) return null;
  const item = document.createElement('div');
  item.className = `chatbot-message ${role}${options.pending ? ' pending' : ''}`;
  const html = role === 'assistant'
    ? formatChatMarkdown(content)
    : escapeChatHtml(content).replace(/\n/g, '<br>');
  item.innerHTML = `<div class="chatbot-bubble">${html}</div>`;
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
  return item;
}

function activeViewName() {
  return (document.querySelector('.view.active')?.id || 'view-journey').replace(/^view-/, '');
}

async function sendChatbotMessage(event) {
  event?.preventDefault();
  if (_chatbotBusy) return;

  const input = document.getElementById('chatbot-input');
  const text = event?.question || input?.value.trim();
  if (!text) return;

  if (input) {
    input.value = '';
    input.style.height = '';
  }
  appendChatMessage('user', text);
  _chatbotHistory.push({ role: 'user', content: text });

  const pending = appendChatMessage('assistant', 'Thinking...', { pending: true });
  setChatbotStatus('Contacting Hugging Face', true);

  try {
    const resp = await fetch('/api/chatbot/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: _chatbotHistory.slice(-10),
        region: EXL.getRegion(),
        year: EXL.getYear(),
        view: activeViewName(),
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    const reply = data.reply || 'I could not find a response from the model.';
    pending?.remove();
    appendChatMessage('assistant', reply);
    _chatbotHistory.push({ role: 'assistant', content: reply });
    _chatbotHistory = _chatbotHistory.slice(-12);
    setChatbotStatus('Hugging Face LLM', false);
  } catch (err) {
    pending?.remove();
    appendChatMessage('assistant', `Chatbot is not ready: ${err.message}`);
    setChatbotStatus('Configuration needed', false);
  }
}

function initChatbotWidget() {
  const iconTargets = [
    ['chatbot-launcher-icon', 'bot'],
    ['chatbot-title-icon', 'bot'],
    ['chatbot-close-icon', 'xCircle'],
    ['chatbot-send-icon', 'send'],
  ];
  iconTargets.forEach(([id, icon]) => {
    const el = document.getElementById(id);
    if (el && window.EXL?.iconSvg) {
      el.innerHTML = EXL.iconSvg(icon);
      el.dataset.iconReady = 'true';
    }
  });

  const input = document.getElementById('chatbot-input');
  input?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChatbotMessage(event);
    }
  });
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 92)}px`;
  });

  document.querySelectorAll('.chatbot-suggestion').forEach(button => {
    button.addEventListener('click', () => {
      const question = button.dataset.question || button.textContent;
      sendChatbotMessage({ preventDefault() {}, question });
    });
  });
}

document.addEventListener('DOMContentLoaded', function () {
  initFluidSidebar();
  initChatbotWidget();
  updateHeaderFiltersForView(_currentView);
  populateGlobalFilters();
  loadViewData('journey');
});
