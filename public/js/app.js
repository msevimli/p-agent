/* plife — client-side application logic */
(() => {
  'use strict';

  // ------------------------------------------------------------------ state
  const state = {
    sessions: [],
    currentId: null,
    currentMessages: [],
    streaming: false,
    settings: { temperature: 0.7, top_p: 0.95, max_tokens: 2048, advanced: true },
    // Reasoning effort/visibility controller (Off|Default|Low|Medium|High),
    // persisted; 'off' hides thinking panels AND asks the backend to disable
    // reasoning (reasoning_effort:'none' / no budget). Migrates the earlier
    // binary pagent.showReasoning preference ('0' -> off).
    reasoningLevel: (() => {
      try {
        const v = localStorage.getItem('pagent.reasoningLevel');
        if (v && ['off', 'default', 'low', 'medium', 'high'].includes(v)) return v;
        if (localStorage.getItem('pagent.showReasoning') === '0') return 'off';
        return 'default';
      } catch { return 'default'; }
    })(),
    context: { window: 8192, inputTokens: 0, outputTokens: 0, source: 'estimated' },
    lastUsage: null, // { sessionId, prompt_tokens, completion_tokens } from llama
    pendingDeleteId: null, // session awaiting inline delete confirmation
    abortController: null, // AbortController for the active stream
    // Per-session active-turn registry: sessionId -> stream record while a
    // request is running for that session (see sendMessage/reattachStreamUI).
    // A stream keeps consuming into its record even while the user views
    // another session — switching back re-attaches the buffers to fresh DOM.
    activeStreams: {},
    view: 'chat', // 'chat' | 'files' — which panel is shown in the main area
    fsDir: '', // current directory in the File Explorer (workspace-relative; '' = root)
    attachments: [], // [{ id, name, size }] queued for the next chat message
    // Models-panel accordion: per-category ('cloud'|'local'|'cascade') open
    // state. null until the first render, which seeds it smartly (only the
    // section holding the active model or a cascade role expands); the
    // delegated toggle handler updates it after that, so re-renders preserve
    // the user's manual choices.
    modelsSections: null,
    // Models-panel tabs: 'models' | 'templates'.
    modelsTab: 'models',
    // Launch-template cache [{ id, name, description, builtin, args }].
    templates: [],
  };

  // ------------------------------------------------------------- dom refs
  const $ = (sel) => document.querySelector(sel);
  const messagesEl = $('#messages');
  const emptyStateEl = $('#emptyState');
  const sessionListEl = $('#sessionList');
  const promptInput = $('#promptInput');
  const sendBtn = $('#sendBtn');
  const genTimerEl = $('#genTimer');
  const skillPickerEl = $('#skillPicker');
  const statusDot = $('#statusDot');
  const statusText = $('#statusText');
  const statusPill = $('#statusPill');
  const modelStatusMenu = $('#modelStatusMenu');
  const msmDot = $('#msmDot');
  const msmName = $('#msmName');
  const msmPhase = $('#msmPhase');
  const msmDetail = $('#msmDetail');
  const msmMemory = $('#msmMemory');
  const msmWarmupBtn = $('#msmWarmupBtn');
  const msmEjectBtn = $('#msmEjectBtn');
  const msmManageBtn = $('#msmManageBtn');
  const ramRings = document.querySelectorAll('.metric-ring.ram');
  const ramPcts = document.querySelectorAll('.metric-pct.ram');
  const ramPills = document.querySelectorAll('.metric-pill.ram');
  const cpuRings = document.querySelectorAll('.metric-ring.cpu');
  const cpuPcts = document.querySelectorAll('.metric-pct.cpu');
  const cpuPills = document.querySelectorAll('.metric-pill.cpu');
  const contextBtn = $('#contextBtn');
  const contextRing = $('#contextRing');
  const contextSummary = $('#contextSummary');
  const contextPopover = $('#contextPopover');
  const settingsPopover = $('#settingsPopover');
  const reasoningMenu = $('#reasoningMenu');
  const reasoningLevelLabel = $('#reasoningLevelLabel');
  const genSettingsBtn = $('#genSettingsBtn');
  const tempRange = $('#tempRange');
  const tempVal = $('#tempVal');
  const toppRange = $('#toppRange');
  const toppVal = $('#toppVal');
  const maxTokensInput = $('#maxTokensInput');
  const resetSettingsBtn = $('#resetSettings');
  const advParamsToggle = $('#advParamsToggle');
  const advParamsHint = $('#advParamsHint');

  // File Explorer / Skills / view-switching refs
  const chatViewEl = $('#chatView');
  const fileExplorerViewEl = $('#fileExplorerView');
  const skillsViewEl = $('#skillsView');
  const fileExplorerBtn = $('#fileExplorerBtn');
  const skillsBtn = $('#skillsBtn');
  const fsList = $('#fsList');
  const fsBreadcrumb = $('#fsBreadcrumb');
  const fsBackChat = $('#fsBackChat');
  const skillsListEl = $('#skillsList');
  const skillsBackChat = $('#skillsBackChat');
  const skillsRefresh = $('#skillsRefresh');

  // Models view + editor modal refs
  const modelsViewEl = $('#modelsView');
  const modelsBtn = $('#modelsBtn');
  const modelsListEl = $('#modelsList');
  const modelsBackChat = $('#modelsBackChat');
  const modelsRefresh = $('#modelsRefresh');
  const modelsAddBtn = $('#modelsAddBtn');
  const modalEl = $('#modelModal');

  // System view refs
  const systemViewEl = $('#systemView');
  const systemBtn = $('#systemBtn');
  const systemBackChat = $('#systemBackChat');
  const systemRefresh = $('#systemRefresh');
  const systemPromptText = $('#systemPromptText');
  const systemSaveBtn = $('#systemSaveBtn');
  const systemResetBtn = $('#systemResetBtn');
  const systemSourceBadge = $('#systemSourceBadge');
  const systemSaveState = $('#systemSaveState');
  const modelForm = $('#modelForm');
  const modelFormError = $('#modelFormError');
  const modelModalTitle = $('#modelModalTitle');
  const modelId = $('#modelId');
  const modelName = $('#modelName');
  const modelSlug = $('#modelSlug');
  const modelEndpoint = $('#modelEndpoint');
  const modelModelId = $('#modelModelId');
  const modelCtx = $('#modelCtx');
  const modelApiKey = $('#modelApiKey');
  const modelRole = $('#modelRole');
  const modelTemplate = $('#modelTemplate');
  // Templates tab + editor modal refs
  const modelsTabBtn = $('#modelsTabBtn');
  const templatesTabBtn = $('#templatesTabBtn');
  const templatesListEl = $('#templatesList');
  const templatesAddBtn = $('#templatesAddBtn');
  const templatesRefresh = $('#templatesRefresh');
  const modelsExplainer = $('#modelsExplainer');
  const templatesExplainer = $('#templatesExplainer');
  const templateModalEl = $('#templateModal');
  const templateForm = $('#templateForm');
  const templateFormError = $('#templateFormError');
  const templateModalTitle = $('#templateModalTitle');
  const templateIdEl = $('#templateId');
  const templateName = $('#templateName');
  const templateDesc = $('#templateDesc');
  const templateArgs = $('#templateArgs');
  const templateLockedNote = $('#templateLockedNote');

  // Automations view + editor modal refs
  const automationsViewEl = $('#automationsView');
  const automationsBtn = $('#automationsBtn');
  const automationsListEl = $('#automationsList');
  const autoPauseToggle = $('#autoPauseToggle');
  const autoPauseHint = $('#autoPauseHint');
  const automationsBackChat = $('#automationsBackChat');
  const automationsRefresh = $('#automationsRefresh');
  const automationsAddBtn = $('#automationsAddBtn');
  const autoModalEl = $('#automationModal');
  const autoForm = $('#automationForm');
  const autoFormError = $('#automationFormError');
  const autoModalTitle = $('#automationModalTitle');
  const autoId = $('#automationId');
  const autoName = $('#autoName');
  const autoDesc = $('#autoDesc');
  const autoScheduleType = $('#autoScheduleType');
  const autoIntervalMin = $('#autoIntervalMin');
  const autoCron = $('#autoCron');
  const autoActionType = $('#autoActionType');
  const autoSkill = $('#autoSkill');
  const autoScript = $('#autoScript');
  const autoPrompt = $('#autoPrompt');
  const autoArgs = $('#autoArgs');
  const autoMaxTokens = $('#autoMaxTokens');

  // Library view + preview modal + chat attach refs
  const libraryViewEl = $('#libraryView');
  const libraryBtn = $('#libraryBtn');
  const libraryListEl = $('#libraryList');
  const libraryBackChat = $('#libraryBackChat');
  const libraryRefresh = $('#libraryRefresh');
  const libraryUploadBtn = $('#libraryUploadBtn');
  const libraryFileInput = $('#libraryFileInput');
  const libViewModalEl = $('#libraryViewModal');
  const libViewTitle = $('#libViewTitle');
  const libViewMeta = $('#libViewMeta');
  const libViewBody = $('#libViewBody');
  const libViewDownload = $('#libViewDownload');
  const attachBtn = $('#attachBtn');
  const attachPopover = $('#attachPopover');
  const attachListEl = $('#attachList');
  const attachUploadBtn = $('#attachUploadBtn');
  const attachFileInput = $('#attachFileInput');
  const attachChipsEl = $('#attachChips');

  // Channels view refs
  const channelsViewEl = $('#channelsView');
  const channelsBtn = $('#channelsBtn');
  const channelsListEl = $('#channelsList');
  const channelsBackChat = $('#channelsBackChat');
  const channelsRefresh = $('#channelsRefresh');
  const chanToggle = $('#chanToggle');
  const chanStatusBadge = $('#chanStatusBadge');
  const chanToken = $('#chanToken');
  const chanTokenSave = $('#chanTokenSave');
  const chanIds = $('#chanIds');
  const chanIdsSave = $('#chanIdsSave');
  const chanTest = $('#chanTest');
  const chanTestResult = $('#chanTestResult');
  const chanMeta = $('#chanMeta');

  // ------------------------------------------------------------- markdown
  marked.setOptions({
    breaks: true,
    gfm: true,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; }
        catch { /* fall through */ }
      }
      return hljs.highlightAuto(code).value;
    },
  });

  // ------------------------------------------------------------- theme
  function applyTheme(dark) {
    document.documentElement.classList.toggle('dark', dark);
    $('#themeIcon').textContent = dark ? '☀️' : '🌙';
    localStorage.setItem('plife-theme', dark ? 'dark' : 'light');
  }
  $('#themeToggle').addEventListener('click', () =>
    applyTheme(!document.documentElement.classList.contains('dark'))
  );
  applyTheme(localStorage.getItem('plife-theme') !== 'light');

  // ------------------------------------------------------------- sidebar
  function openSidebar() {
    $('#sidebar').classList.add('open');
    $('#sidebarBackdrop').classList.add('show');
  }
  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    $('#sidebarBackdrop').classList.remove('show');
  }
  $('#menuBtn').addEventListener('click', openSidebar);
  $('#sidebarBackdrop').addEventListener('click', closeSidebar);

  // ------------------------------------------------------------- accordion
  // Toggle a collapsible section (header + its body share the .open state).
  // Delegated (not bound at init) so dynamically rendered sections — e.g. the
  // Models panel categories — collapse/expand too, matching the sidebar.
  document.addEventListener('click', (e) => {
    const h = e.target.closest('.section-header');
    if (!h) return;
    const open = h.classList.toggle('open');
    const body = h.nextElementSibling;
    if (body) body.classList.toggle('open', open);
    // Models-panel sections: persist the user's choice so the next render
    // (refresh, activate, role change…) doesn't reset it. Sidebar sections
    // have no .model-section ancestor and stay stateless.
    const sec = h.closest('.model-section');
    const cat = sec && /(?:^|\s)cat-([a-z]+)/.exec(sec.className);
    if (cat && state.modelsSections) state.modelsSections[cat[1]] = open;
  });

  // ------------------------------------------------------------- view switching
  const PANELS = {
    chat: chatViewEl,
    files: fileExplorerViewEl,
    skills: skillsViewEl,
    models: modelsViewEl,
    library: libraryViewEl,
    automations: automationsViewEl,
    channels: channelsViewEl,
    system: systemViewEl,
  };
  const SUBTITLES = {
    chat: 'Local AI Agent',
    files: 'File Explorer',
    skills: 'Skills',
    models: 'Models',
    library: 'Library',
    automations: 'Automations',
    channels: 'Channels',
    system: 'System',
  };
  const NAV_BTNS = {
    chat: null,
    files: fileExplorerBtn,
    skills: skillsBtn,
    models: modelsBtn,
    library: libraryBtn,
    automations: automationsBtn,
    channels: channelsBtn,
    system: systemBtn,
  };

  function showView(name) {
    state.view = name;
    for (const [k, el] of Object.entries(PANELS)) el.classList.toggle('hidden', k !== name);
    $('#headerSub').textContent = SUBTITLES[name];
    for (const b of Object.values(NAV_BTNS)) if (b) b.classList.remove('active');
    if (NAV_BTNS[name]) NAV_BTNS[name].classList.add('active');
    closePopovers();
    if (name === 'files') loadFsDir(state.fsDir);
    if (name === 'skills') loadSkills();
    if (name === 'models') loadModels();
    if (name === 'library') loadLibrary();
    if (name === 'automations') loadAutomations();
    if (name === 'channels') loadChannels();
    if (name === 'system') loadSystemPrompt();
  }

  // ------------------------------------------------------------- skills view
  async function loadSkills() {
    skillsListEl.innerHTML = '<div class="fe-muted">Loading skills…</div>';
    let data;
    try {
      const res = await fetch('/api/skills');
      data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load skills');
    } catch (err) {
      skillsListEl.innerHTML = `<div class="fe-muted fs-error">⚠️ ${escapeHtml(err.message)}</div>`;
      return;
    }
    renderSkills(data.skills);
    // Keep the slash-picker cache in sync with the Skills view (same data).
    refreshPickerSkills(data.skills);
  }

  const TRASH_ICON = `<svg class="ic" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round"
        d="M19 7l-.9 12.1A2 2 0 0 1 16.1 21H7.9a2 2 0 0 1-2-1.9L5 7M10 11v6M14 11v6M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2M4 7h16" />
    </svg>`;

  function renderSkills(skills) {
    skillsListEl.innerHTML = '';
    if (!skills.length) {
      skillsListEl.innerHTML = '<div class="fe-muted">No skills installed yet.</div>';
      return;
    }
    for (const s of skills) {
      const card = document.createElement('div');
      card.className = 'skill-card';
      card.setAttribute('data-skill', s.name);
      card.innerHTML = `
        <div class="skill-row">
          <span class="skill-icon">⚡</span>
          <div class="skill-main">
            <div class="skill-name">${escapeHtml(s.name)}</div>
            <div class="skill-desc">${escapeHtml(s.description || 'No description')}</div>
            <div class="skill-meta">
              <span class="skill-badge ${s.enabled ? 'on' : 'off'}">${s.enabled ? 'active' : 'disabled'}</span>
              <span class="skill-ver">v${escapeHtml(s.version || '1.0.0')}</span>
              <span class="skill-files">${Number(s.files) || 0} file${Number(s.files) === 1 ? '' : 's'}</span>
            </div>
          </div>
          <div class="skill-actions">
            <button class="skill-del" data-del="${escapeHtml(s.name)}" title="Delete ${escapeHtml(s.name)}">
              ${TRASH_ICON}
            </button>
            <label class="switch" title="${s.enabled ? 'Disable' : 'Enable'} ${escapeHtml(s.name)}">
              <input type="checkbox" data-skill-toggle="${escapeHtml(s.name)}" ${s.enabled ? 'checked' : ''} />
              <span class="slider"></span>
            </label>
          </div>
        </div>
        <div class="skill-confirm hidden">
          <span>Remove <strong>${escapeHtml(s.name)}</strong> and its files permanently?</span>
          <div class="skill-confirm-actions">
            <button class="skill-danger" data-confirm-del="${escapeHtml(s.name)}">Delete</button>
            <button class="skill-cancel" data-cancel-del>Cancel</button>
          </div>
        </div>`;

      const toggle = card.querySelector('input[data-skill-toggle]');
      toggle.addEventListener('change', () => setSkillEnabled(s.name, toggle.checked, card));

      // Inline delete confirmation (two-step, matching the session-list pattern).
      const delBtn = card.querySelector('.skill-del');
      const confirmEl = card.querySelector('.skill-confirm');
      delBtn.addEventListener('click', () => {
        const show = confirmEl.classList.contains('hidden');
        confirmEl.classList.toggle('hidden', !show);
        delBtn.classList.toggle('danger', show);
      });
      card.querySelector('[data-cancel-del]').addEventListener('click', () => {
        confirmEl.classList.add('hidden');
        delBtn.classList.remove('danger');
      });
      card.querySelector('[data-confirm-del]').addEventListener('click', () => deleteSkill(s.name, card));

      skillsListEl.appendChild(card);
    }
  }

  // Permanently delete a skill; removes the card on success, restores + toasts on failure.
  async function deleteSkill(name, card) {
    card.classList.add('deleting');
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not delete skill');
      card.remove();
    } catch (err) {
      card.classList.remove('deleting');
      const confirmEl = card.querySelector('.skill-confirm');
      if (confirmEl) confirmEl.classList.add('hidden');
      const delBtn = card.querySelector('.skill-del');
      if (delBtn) delBtn.classList.remove('danger');
      skillToast(err.message);
    }
  }

  async function setSkillEnabled(name, enabled, card) {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(name)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not update skill');
    } catch (err) {
      const input = card.querySelector('input[data-skill-toggle]');
      input.checked = !enabled; // revert optimistic toggle
      const badge = card.querySelector('.skill-badge');
      if (badge) { badge.textContent = input.checked ? 'active' : 'disabled'; badge.className = 'skill-badge ' + (input.checked ? 'on' : 'off'); }
      skillToast(err.message);
      return;
    }
    const badge = card.querySelector('.skill-badge');
    if (badge) { badge.textContent = enabled ? 'active' : 'disabled'; badge.className = 'skill-badge ' + (enabled ? 'on' : 'off'); }
    const input = card.querySelector('input[data-skill-toggle]');
    if (input) input.title = '';
  }

  // Small transient toast for skill action errors.
  function skillToast(msg) {
    let toast = document.getElementById('skillToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'skillToast';
      toast.className = 'skill-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = '⚠️ ' + msg;
    toast.classList.add('show');
    clearTimeout(skillToast._t);
    skillToast._t = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  skillsBtn.addEventListener('click', () => { showView('skills'); closeSidebar(); });
  skillsBackChat.addEventListener('click', () => showView('chat'));
  skillsRefresh.addEventListener('click', () => loadSkills());

  // ------------------------------------------------------------- models view
  const MODEL_ICON = `<svg class="fs-ic" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
      <rect x="5" y="8" width="14" height="8" rx="1.5" />
      <path stroke-linecap="round" d="M9 8V6.5a3 3 0 0 1 6 0V8M9 12h.01M15 12h.01M9 16v1M15 16v1" /></svg>`;

  const STATUS_LABEL = { online: 'online', offline: 'offline', unreachable: 'unreachable', timeout: 'timeout', conflict: 'port busy' };

  async function loadModels() {
    modelsListEl.innerHTML = '<div class="fe-muted">Loading models…</div>';
    let data;
    try {
      const res = await fetch('/api/models');
      data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load models');
    } catch (err) {
      modelsListEl.innerHTML = `<div class="fe-muted fs-error">⚠️ ${escapeHtml(err.message)}</div>`;
      return;
    }
    renderModels(data.models, data.cascade);
    applyAdvancedAdaptive(data.models);
  }

  function modelStatus(status) {
    const label = STATUS_LABEL[status] || 'unknown';
    return `<span class="model-status ${escapeHtml(status)}"><span class="dot"></span>${label}</span>`;
  }

  const MODEL_SECTIONS = [
    {
      key: 'cloud',
      title: 'Cloud / Online APIs',
      icon: '☁️',
      hint: 'Remote OpenAI-compatible providers — OpenRouter and other hosted APIs with a key.',
    },
    {
      key: 'local',
      title: 'Local Models',
      icon: '🖥️',
      hint: 'Standalone llama.cpp servers running on this machine.',
    },
    {
      key: 'cascade',
      title: 'Two-Stage Cascading (Hybrid)',
      icon: '🔀',
      hint: 'Hybrid: a fast 1.5B router (intent + tool calls) feeding a heavy 7B primary (final answers).',
    },
  ];

  /**
   * First-render accordion defaults: only the section that is IN USE expands —
   * the one holding the active model, plus the cascade section when any
   * router/primary role is configured. Everything else starts collapsed.
   * Called once; from then on state.modelsSections mirrors the user's manual
   * toggles (see the delegated .section-header handler).
   */
  function defaultModelsSections(models) {
    const open = new Set();
    for (const m of models || []) {
      if (!m) continue;
      if (m.active) open.add(m.category);
      if (m.role === 'router' || m.role === 'primary') open.add('cascade');
    }
    return {
      cloud: open.has('cloud'),
      local: open.has('local'),
      cascade: open.has('cascade'),
    };
  }

  /** Render the Models panel as collapsible, labeled category sections. */
  function renderModels(models, cascadeInfo) {
    modelsListEl.innerHTML = '';
    if (!state.modelsSections) state.modelsSections = defaultModelsSections(models);
    if (!models.length) {
      modelsListEl.innerHTML = '<div class="fe-muted">No models configured yet. Click "Add model" to create one.</div>';
      return;
    }
    for (const s of MODEL_SECTIONS) {
      const list = models.filter((m) => m.category === s.key);
      // Collapsed-without-clutter: Cloud/Local hide when empty; the cascade
      // section always renders — it is the headline feature and shows an
      // empty-state hint instead of disappearing.
      if (s.key !== 'cascade' && !list.length) continue;

      const open = state.modelsSections[s.key] !== false;
      const section = document.createElement('div');
      section.className = 'model-section cat-' + s.key;
      const header = document.createElement('button');
      header.className = 'section-header model-section-header' + (open ? ' open' : '');
      header.title = 'Toggle ' + s.title;
      header.innerHTML =
        `<svg class="chev" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">` +
        `<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>` +
        `<span class="ms-icon">${s.icon}</span>` +
        `<span class="ms-title">${s.title}</span>` +
        (s.key === 'cascade'
          ? `<span class="ms-badge ${cascadeInfo && cascadeInfo.enabled ? 'on' : 'off'}">` +
            `${cascadeInfo && cascadeInfo.enabled ? 'cascade enabled' : 'cascade disabled'}</span>`
          : '') +
        `<span class="ms-count">${list.length} model${list.length === 1 ? '' : 's'}</span>`;
      const body = document.createElement('div');
      body.className = 'section-body' + (open ? ' open' : '');
      const inner = document.createElement('div');
      inner.className = 'section-body-inner';
      if (s.key === 'cascade') {
        // Pass the FULL registry (not just cascade-section members) so the
        // role dropdowns can offer every registered model as a candidate.
        const summary = cascadeCard(cascadeInfo, models);
        if (summary) inner.appendChild(summary);
      }
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'fe-muted model-section-empty';
        empty.innerHTML = escapeHtml(s.hint);
        inner.appendChild(empty);
      }
      list.forEach((m) => inner.appendChild(modelCard(m)));
      body.appendChild(inner);
      section.appendChild(header);
      section.appendChild(body);
      modelsListEl.appendChild(section);
    }
  }

  /** Load/Eject a local model's llama-server via its systemd unit. The
   *  fetch resolves only when the endpoint answered /health (load) or the
   *  unit stopped (eject) — the button text doubles as the spinner. */
  async function lifecycleAction(id, action, btn) {
    btn.disabled = true;
    btn.textContent = action === 'load' ? 'Loading…' : 'Ejecting…';
    try {
      const res = await fetch(`/api/models/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `${action} failed`);
      modelToast(action === 'load' ? `Loaded ${id} — ${data.unit || 'unit'} online` : `Ejected ${id} — memory freed`);
    } catch (err) {
      modelToast(err.message);
    }
    loadModels();
  }

  // ------------------------------------------------------------- system view
  function applySystemState(data) {
    // data: { prompt, source, overridden }; fills textarea + badge.
    systemPromptText.value = data.prompt;
    systemSourceBadge.classList.toggle('hidden', !data.overridden);
    systemSaveState.textContent = data.overridden
      ? `Custom prompt active (saved ${new Date().toLocaleTimeString()})`
      : 'Showing the built-in template — unsaved edits have not been applied yet';
  }

  async function loadSystemPrompt() {
    systemSaveState.textContent = 'Loading…';
    let data;
    try {
      const res = await fetch('/api/system/prompt');
      data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load system prompt');
      applySystemState(data);
    } catch (err) {
      systemSaveState.textContent = '';
      modelToast(err.message);
      systemPromptText.value = '';
    }
  }

  async function saveSystemPrompt() {
    const prompt = systemPromptText.value;
    if (!prompt.trim()) {
      modelToast('System prompt must not be empty');
      return;
    }
    systemSaveBtn.disabled = true;
    try {
      const res = await fetch('/api/system/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not save system prompt');
      applySystemState(data);
      modelToast('System prompt saved — applies from the next chat turn');
    } catch (err) {
      modelToast(err.message);
    } finally {
      systemSaveBtn.disabled = false;
    }
  }

  async function resetSystemPrompt() {
    if (!confirm('Reset the system prompt to the built-in template? Your custom prompt will be deleted.')) return;
    systemResetBtn.disabled = true;
    try {
      const res = await fetch('/api/system/prompt', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not reset system prompt');
      applySystemState(data);
      modelToast('System prompt reset to the built-in template');
    } catch (err) {
      modelToast(err.message);
    } finally {
      systemResetBtn.disabled = false;
    }
  }

  systemBackChat.addEventListener('click', () => showView('chat'));
  systemRefresh.addEventListener('click', loadSystemPrompt);
  systemSaveBtn.addEventListener('click', saveSystemPrompt);
  systemResetBtn.addEventListener('click', resetSystemPrompt);

  /** One model card; renders identically in every category section. */
  function modelCard(m) {
    const card = document.createElement('div');
    card.className = 'model-card' + (m.active ? ' active-model' : '');
    card.setAttribute('data-model', m.id);
    const roleChip = m.role
      ? `<span class="model-role-chip ${escapeHtml(m.role)}" title="` +
        `${m.role === 'router' ? 'Router — fast stage-1: intent + tool calls' : 'Primary — heavy stage-2: final answers'}">` +
        `${escapeHtml(m.role)}</span>`
      : '';
    card.innerHTML = `
        <div class="model-card-row">
          <span class="model-ic">${MODEL_ICON}</span>
          <div class="model-main">
            <div class="model-name">
              ${escapeHtml(m.name)}
              ${m.active ? '<span class="model-active-tag">active</span>' : ''}
              ${roleChip}
            </div>
            <div class="model-desc">${escapeHtml(m.model)}</div>
            <div class="model-grid">
              <div class="model-cell">
                <span class="model-cell-label">endpoint</span>
                <span class="model-cell-value model-endpoint" title="${escapeHtml(m.endpoint)}">${escapeHtml(m.endpoint)}</span>
              </div>
              <div class="model-cell">
                <span class="model-cell-label">context</span>
                <span class="model-cell-value">${Number(m.contextLength) || 0} tokens</span>
              </div>
              <div class="model-cell">
                <span class="model-cell-label">provider</span>
                <span class="model-cell-value">${escapeHtml(m.provider || 'local')}</span>
              </div>
              <div class="model-cell">
                <span class="model-cell-label">status</span>
                <span class="model-cell-value">${modelStatus(m.status)}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="model-actions">
          <button class="model-set-active ${m.active ? 'active' : ''}" data-set="${escapeHtml(m.id)}" ${m.active ? 'disabled' : ''}
            title="${m.active ? 'This is the active model' : 'Use this model for the next message'}">
            ${m.active ? 'Active' : 'Set active'}
          </button>
          ${m.category === 'cloud' ? '' : `
          <button class="model-load" data-load="${escapeHtml(m.id)}" ${m.status === 'online' ? 'hidden' : ''}
            title="Start llama-server for this model (unit llama-${escapeHtml(m.id)}.service) and wait for /health">Load</button>
          <button class="model-eject" data-eject="${escapeHtml(m.id)}" ${m.status === 'online' ? '' : 'hidden'}
            title="Stop this model's llama-server and free its memory immediately">Eject</button>`}
          <div class="model-edit-del">
            <button class="model-edit" data-edit="${escapeHtml(m.id)}" title="Edit ${escapeHtml(m.name)}">Edit</button>
            ${m.active ? '' : `<button class="model-del" data-del="${escapeHtml(m.id)}" title="Delete ${escapeHtml(m.name)}">Delete</button>`}
          </div>
        </div>`;
    card.querySelector('[data-set]').addEventListener('click', () => setActiveModel(m.id, card));
    card.querySelector('[data-edit]').addEventListener('click', () => openModelModal(m.id));
    const loadBtn = card.querySelector('[data-load]');
    if (loadBtn) loadBtn.addEventListener('click', () => lifecycleAction(m.id, 'load', loadBtn));
    const ejectBtn = card.querySelector('[data-eject]');
    if (ejectBtn) ejectBtn.addEventListener('click', () => lifecycleAction(m.id, 'eject', ejectBtn));
    const del = card.querySelector('[data-del]');
    if (del) del.addEventListener('click', () => deleteModel(m.id));
    return card;
  }

  /** Router → primary flow card at the top of the cascade section. */
  // Shared by cascadeCard and cascadeRoleSelect (endpoint → ':port').
  function portOf(model) {
    try { return ':' + (new URL(model.endpoint).port || ''); } catch { return ''; }
  }

  function cascadeCard(cascadeInfo, allModels) {
    const info = cascadeInfo || {};
    const r = info.router;
    const p = info.primary;
    let hint;
    if (info.enabled) {
      hint =
        `Stage 1 <strong>${escapeHtml(r.name)}</strong>${r.endpoint ? ' (' + escapeHtml(r.endpoint) + ')' : ''} picks intent and emits tool calls; simple chat is answered directly. ` +
        `Everything else escalates to stage 2 <strong>${escapeHtml(p.name)}</strong>${p.endpoint ? ' (' + escapeHtml(p.endpoint) + ')' : ''}. Escalation mode: ${escapeHtml(info.escalate || 'marker')}.`;
    } else if (r || p) {
      hint = 'Cascade is <strong>off</strong>: the router must be a local (127.0.0.1) llama.cpp endpoint and must differ from the primary. Pick the pair below, then start the servers.';
    } else {
      hint = 'No cascade configured yet. Pick the <strong>Router</strong> and <strong>Primary</strong> models below — the pair activates as soon as both are set, then start the servers.';
    }
    const card = document.createElement('div');
    card.className = 'cascade-card';
    card.innerHTML = `
        <div class="cascade-flow">
          <span class="cascade-node node-router">⚡ Router</span>
          <span class="cascade-arrow">→</span>
          <span class="cascade-node node-primary">🧠 Primary</span>
          <span class="ms-badge ${info.enabled ? 'on' : 'off'}">${info.enabled ? 'ON' : 'OFF'}</span>
        </div>
        <div class="cascade-selects">
          ${cascadeRoleSelect('router', r, allModels, p)}
          <span class="cascade-arrow">→</span>
          ${cascadeRoleSelect('primary', p, allModels, r)}
        </div>
        <div class="cascade-hint">${hint}</div>
        <div class="cascade-actions">
          <button class="cascade-start" ${info.enabled ? '' : 'disabled'}
            title="${info.enabled ? 'Start llama-router.service + llama-primary.service' : 'Assign both roles first'}">▶ Start cascade servers</button>
          <button class="cascade-stop"
            title="Stop llama-router.service + llama-primary.service and free their memory">⏹ Stop / Eject cascade servers</button>
          <span class="cascade-notes">units: llama-router.service / llama-primary.service</span>
        </div>`;
    const start = card.querySelector('.cascade-start');
    start.addEventListener('click', async () => {
      start.disabled = true;
      start.textContent = 'Starting…';
      try {
        const res = await fetch('/api/models/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'cascade launch failed');
        const results = Array.isArray(data.results) ? data.results : [];
        const okN = results.filter((x) => x && x.ok).length;
        modelToast(okN ? `Started ${okN}/${results.length} cascade servers` : 'Cascade servers were already running');
      } catch (err) {
        modelToast(err.message);
      }
      loadModels();
    });
    const stopBtn = card.querySelector('.cascade-stop');
    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      stopBtn.textContent = 'Stopping…';
      try {
        const res = await fetch('/api/models/cascade/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'cascade stop failed');
        const results = Array.isArray(data.results) ? data.results : [];
        const stopped = results.filter((x) => x && x.ok && !x.skipped).length;
        const skipped = results.filter((x) => x && x.skipped).length;
        if (stopped) modelToast(`Stopped ${stopped}/${results.length} cascade server${stopped > 1 ? 's' : ''} — memory freed`);
        else if (skipped) modelToast('No cascade units installed — nothing to stop');
        else modelToast('Cascade servers were not running');
      } catch (err) {
        modelToast(err.message);
      }
      stopBtn.disabled = false;
      stopBtn.textContent = '⏹ Stop / Eject cascade servers';
      loadModels();
    });
    const routerSel = card.querySelector('[data-role="router"]');
    const primarySel = card.querySelector('[data-role="primary"]');
    let busy = false;
    // One atomic call carrying BOTH picks: the backend clears every role and
    // stamps the pair, so a change to either dropdown reconfigures the whole
    // cascade. The selects stay disabled until the round-trip and re-render.
    async function applyRoles() {
      if (busy) return;
      busy = true;
      routerSel.disabled = true;
      primarySel.disabled = true;
      try {
        const res = await fetch('/api/models/cascade/roles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ routerId: routerSel.value, primaryId: primarySel.value }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not update cascade roles');
        const rn = data.router ? data.router.name : 'no router';
        const pn = data.primary ? data.primary.name : 'no primary';
        modelToast(`Cascade: ${rn} → ${pn}`);
      } catch (err) {
        modelToast(err.message);
      }
      busy = false;
      loadModels();
    }
    routerSel.addEventListener('change', applyRoles);
    primarySel.addEventListener('change', applyRoles);
    return card;
  }

  /**
   * One role dropdown for the cascade card. Every registered model is a
   * candidate (the OTHER stage's current pick is excluded so a model can
   * never be both router and primary). The option text shows the endpoint
   * port for local servers and a ⚠ remote marker otherwise, so a pick that
   * disables the cascade (remote router / mismatched endpoint) is visible
   * before saving.
   */
  function cascadeRoleSelect(roleKey, current, allModels, otherPick) {
    const currentId = current && current.id ? current.id : '';
    const label = roleKey === 'router' ? 'Router (Stage 1)' : 'Primary (Stage 2)';
    const loopback = (endpoint) =>
      /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(String(endpoint || ''));
    const opts = ['<option value="">— none —</option>']
      .concat(
        (Array.isArray(allModels) ? allModels : [])
          .filter((m) => m && (!otherPick || m.id !== otherPick.id))
          .map((m) => {
            const note = loopback(m.endpoint) ? (portOf(m) || '') : '⚠ remote';
            const sel = m.id === currentId ? ' selected' : '';
            return `<option value="${escapeHtml(m.id)}"${sel}>${escapeHtml(m.name)}${note ? ' — ' + escapeHtml(note) : ''}</option>`;
          })
      )
      .join('');
    return `
        <label class="cascade-pick" title="Which registered model acts as the ${label}">
          <span class="cascade-pick-label">${label}</span>
          <select class="cascade-role-select" data-role="${roleKey}">${opts}</select>
        </label>`;
  }

  // Set the active model with optimistic UI feedback (green "Active" pill + tag).
  async function setActiveModel(id, card) {
    card.classList.add('model-busy');
    try {
      const res = await fetch(`/api/models/${encodeURIComponent(id)}/activate`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not set active model');
      // Instantly reflect the switch, then re-run the (status-probing) load in the background.
      document.querySelectorAll('.model-card').forEach((c) => {
        const btn = c.querySelector('[data-set]');
        if (c === card) {
          c.classList.add('active-model');
          const tag = document.createElement('span');
          tag.className = 'model-active-tag';
          tag.textContent = 'active';
          c.querySelector('.model-name').appendChild(tag);
          if (btn) { btn.textContent = 'Active'; btn.classList.add('active'); btn.disabled = true; }
        } else {
          c.classList.remove('active-model');
          c.querySelector('.model-active-tag')?.remove();
          if (btn) { btn.textContent = 'Set active'; btn.classList.remove('active'); btn.disabled = false; }
        }
      });
      checkHealth(); // header status may reflect the newly active endpoint
      refreshModelStatus();
      loadModels();  // refresh statuses quietly
    } catch (err) {
      modelToast(err.message);
    } finally {
      card.classList.remove('model-busy');
    }
  }

  async function deleteModel(id) {
    if (!confirm(`Delete model "${id}"? This removes it from the list.`)) return;
    try {
      const res = await fetch(`/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not delete model');
      loadModels();
    } catch (err) {
      modelToast(err.message);
    }
  }

  // ------------------------------------------------------- model editor modal
  function resetModelForm() {
    modelForm.reset();
    modelFormError.classList.add('hidden');
  }

  /** Rebuild the launch-template dropdown (Default + every template). */
  function fillTemplateSelect(selectedId) {
    modelTemplate.innerHTML =
      '<option value="">Default</option>' +
      state.templates
        .map((t) => `<option value="${escapeHtml(t.id)}"${t.id === selectedId ? ' selected' : ''}>${escapeHtml(t.name)}${t.builtin ? ' (built-in)' : ''}</option>`)
        .join('');
  }

  /** Select a template in the modal, fetching the list first if needed. */
  function selectTemplateValue(id) {
    if (state.templates.length) { modelTemplate.value = id || ''; return; }
    fetch('/api/models/templates')
      .then((r) => r.json())
      .then((d) => {
        state.templates = d && Array.isArray(d.templates) ? d.templates : [];
        fillTemplateSelect(id || '');
      })
      .catch(() => { /* select stays on Default */ });
  }

  function openModelModal(id) {
    resetModelForm();
    fillTemplateSelect('');
    if (id) {
      fetch(`/api/models/${encodeURIComponent(id)}`)
        .then((r) => r.json())
        .then((data) => {
          if (!data.ok) throw new Error(data.error || 'Could not load model');
          const m = data.model;
          modelModalTitle.textContent = 'Edit model';
          modelId.value = m.id;
          modelName.value = m.name;
          modelSlug.value = m.id;
          modelEndpoint.value = m.endpoint;
          modelModelId.value = m.model;
          modelCtx.value = m.contextLength || '';
          modelRole.value = m.role || '';
          selectTemplateValue(m.templateId || '');
          modelName.disabled = false;
        })
        .catch((err) => { modelToast(err.message); return; });
    } else {
      modelModalTitle.textContent = 'Add model';
      modelId.value = '';
      modelName.value = '';
      modelName.disabled = false;
    }
    modalEl.classList.remove('hidden');
    (id ? modelEndpoint : modelName).focus();
  }

  function closeModelModal() {
    modalEl.classList.add('hidden');
  }

  modelForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    modelFormError.classList.add('hidden');
    const isEdit = !!modelId.value;
    const body = {
      id: modelSlug.value.trim(),
      name: modelName.value.trim(),
      endpoint: modelEndpoint.value.trim(),
      model: modelModelId.value.trim(),
      contextLength: parseInt(modelCtx.value, 10) || 8192,
      role: modelRole.value || '',
      templateId: modelTemplate.value || '',
    };
    // Only send apiKey when a new one is typed; blank → keep existing on edit.
    if (modelApiKey.value.trim()) body.apiKey = modelApiKey.value.trim();

    const url = isEdit ? `/api/models/${encodeURIComponent(modelSlug.value.trim())}` : '/api/models';
    const method = isEdit ? 'PUT' : 'POST';
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error || (data.errors ? data.errors.join('; ') : 'Could not save model');
        throw new Error(msg);
      }
      closeModelModal();
      loadModels();
      checkHealth();
    } catch (err) {
      modelFormError.textContent = '⚠️ ' + err.message;
      modelFormError.classList.remove('hidden');
    }
  });

  function modelToast(msg) {
    let toast = document.getElementById('skillToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'skillToast';
      toast.className = 'skill-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = '⚠️ ' + msg;
    toast.classList.add('show');
    clearTimeout(modelToast._t);
    modelToast._t = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  modelsBtn.addEventListener('click', () => { showView('models'); closeSidebar(); loadTemplates(); });
  systemBtn.addEventListener('click', () => { showView('system'); closeSidebar(); });
  modelsBackChat.addEventListener('click', () => showView('chat'));
  modelsRefresh.addEventListener('click', () => loadModels());
  modelsAddBtn.addEventListener('click', () => openModelModal(null));
  $('#modelModalClose').addEventListener('click', closeModelModal);
  $('#modelFormCancel').addEventListener('click', closeModelModal);
  modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModelModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!modalEl.classList.contains('hidden')) closeModelModal();
    else if (!templateModalEl.classList.contains('hidden')) closeTemplateModal();
  });

  // ------------------------------------------------------------- templates tab
  /** Switch the Models panel between the Models and Templates tabs. */
  function setModelsTab(tab) {
    state.modelsTab = tab === 'templates' ? 'templates' : 'models';
    const isModels = state.modelsTab === 'models';
    modelsListEl.classList.toggle('hidden', !isModels);
    templatesListEl.classList.toggle('hidden', isModels);
    modelsTabBtn.classList.toggle('active', isModels);
    templatesTabBtn.classList.toggle('active', !isModels);
    modelsTabBtn.setAttribute('aria-selected', isModels);
    templatesTabBtn.setAttribute('aria-selected', !isModels);
    modelsAddBtn.classList.toggle('hidden', !isModels);
    templatesAddBtn.classList.toggle('hidden', isModels);
    modelsRefresh.classList.toggle('hidden', !isModels);
    templatesRefresh.classList.toggle('hidden', isModels);
    modelsExplainer.classList.toggle('hidden', !isModels);
    templatesExplainer.classList.toggle('hidden', isModels);
    if (!isModels && !state.templates.length) loadTemplates();
  }

  /** Load launch templates into state.templates and render the tab. */
  async function loadTemplates() {
    try {
      const [tplRes, modRes] = await Promise.all([
        fetch('/api/models/templates'),
        fetch('/api/models'),
      ]);
      const tplData = await tplRes.json();
      const modData = await modRes.json();
      if (!tplRes.ok || !tplData.ok) throw new Error(tplData.error || 'Could not load templates');
      state.templates = Array.isArray(tplData.templates) ? tplData.templates : [];
      // How many models reference each template (for the card's usage note).
      const usage = {};
      for (const m of (modData && modData.models) || []) {
        if (m && m.templateId) usage[m.templateId] = (usage[m.templateId] || 0) + 1;
      }
      for (const tpl of state.templates) {
        tpl.usage = usage[tpl.id] ? `${usage[tpl.id]} model${usage[tpl.id] === 1 ? '' : 's'} assigned` : '';
      }
      renderTemplates(state.templates);
    } catch (err) {
      templatesListEl.innerHTML = `<div class="fe-muted fs-error">⚠️ ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderTemplates(list) {
    templatesListEl.innerHTML = '';
    if (!list.length) {
      templatesListEl.innerHTML = '<div class="fe-muted">No templates yet. Click "New template" to create one.</div>';
      return;
    }
    for (const tpl of list) templatesListEl.appendChild(templateCard(tpl));
  }

  /** One template card (built-in shows an undeletable Delete button). */
  function templateCard(tpl) {
    const card = document.createElement('div');
    card.className = 'template-card' + (tpl.builtin ? ' builtin' : '');
    const preview = (tpl.args || []).join(' ');
    const n = (tpl.args || []).length;
    card.innerHTML = `
        <div class="template-card-row">
          <div class="template-main">
            <div class="template-name">
              ${escapeHtml(tpl.name)}
              ${tpl.builtin ? '<span class="template-builtin-tag" title="Built-in template — cannot be deleted">built-in</span>' : ''}
              <span class="template-count">${n} flag${n === 1 ? '' : 's'}</span>
            </div>
            ${tpl.description ? `<div class="template-desc">${escapeHtml(tpl.description)}</div>` : ''}
            <code class="template-args" title="Flags applied on launch">${escapeHtml(preview)}</code>
          </div>
        </div>
        <div class="model-actions">
          <span class="fe-muted template-usage" title="Models using this template">${tpl.usage || ''}</span>
          <div class="model-edit-del">
            <button class="model-edit" data-tpl-edit="${escapeHtml(tpl.id)}" title="Edit ${escapeHtml(tpl.name)}">Edit</button>
            <button class="model-del" data-tpl-del="${escapeHtml(tpl.id)}"
              ${tpl.builtin ? 'disabled title="Built-in template cannot be deleted"' : `title="Delete ${escapeHtml(tpl.name)}"`}>Delete</button>
          </div>
        </div>`;
    card.querySelector('[data-tpl-edit]').addEventListener('click', () => openTemplateModal(tpl.id));
    const del = card.querySelector('[data-tpl-del]');
    if (!tpl.builtin) del.addEventListener('click', () => deleteTemplate(tpl.id));
    return card;
  }

  function resetTemplateForm() {
    templateForm.reset();
    templateFormError.classList.add('hidden');
  }

  function openTemplateModal(id) {
    resetTemplateForm();
    if (id) {
      const tpl = state.templates.find((t) => t.id === id);
      if (!tpl) return modelToast('Template not found');
      templateModalTitle.textContent = tpl.builtin ? 'Edit built-in template' : 'Edit template';
      templateIdEl.value = tpl.id;
      templateName.value = tpl.name;
      templateDesc.value = tpl.description || '';
      templateArgs.value = (tpl.args || []).join('\n');
      // Built-in: content editable, identity locked.
      templateName.disabled = !!tpl.builtin;
      templateLockedNote.classList.toggle('hidden', !tpl.builtin);
    } else {
      templateModalTitle.textContent = 'New template';
      templateIdEl.value = '';
      templateName.disabled = false;
      templateLockedNote.classList.add('hidden');
      templateArgs.value = '';
    }
    templateModalEl.classList.remove('hidden');
    (id ? templateArgs : templateName).focus();
  }

  function closeTemplateModal() {
    templateModalEl.classList.add('hidden');
  }

  async function deleteTemplate(id) {
    const tpl = state.templates.find((t) => t.id === id);
    if (!tpl) return;
    if (tpl.builtin) return modelToast('The built-in default template cannot be deleted');
    if (!confirm(`Delete template "${tpl.name}"? Models assigned to it fall back to Default on launch.`)) return;
    try {
      const res = await fetch(`/api/models/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not delete template');
      loadTemplates();
    } catch (err) {
      modelToast(err.message);
    }
  }

  templateForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    templateFormError.classList.add('hidden');
    const id = templateIdEl.value.trim();
    const isBuiltin = id && (state.templates.find((t) => t.id === id) || {}).builtin;
    const body = {
      name: templateName.value.trim(),
      description: templateDesc.value.trim(),
      // Whitespace-separated flags; the textarea shows one per line.
      args: templateArgs.value.split(/\s+/).filter(Boolean),
    };
    const url = id ? `/api/models/templates/${encodeURIComponent(id)}` : '/api/models/templates';
    try {
      const res = await fetch(url, {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error || (data.errors ? data.errors.join('; ') : 'Could not save template');
        throw new Error(msg);
      }
      closeTemplateModal();
      modelToast(`${isBuiltin ? 'Default template' : 'Template'} saved — applies on the next launch of any model that uses it`);
      loadTemplates();
    } catch (err) {
      templateFormError.textContent = '⚠️ ' + err.message;
      templateFormError.classList.remove('hidden');
    }
  });

  modelsTabBtn.addEventListener('click', () => setModelsTab('models'));
  templatesTabBtn.addEventListener('click', () => setModelsTab('templates'));
  templatesAddBtn.addEventListener('click', () => openTemplateModal(null));
  templatesRefresh.addEventListener('click', () => loadTemplates());
  $('#templateModalClose').addEventListener('click', closeTemplateModal);
  $('#templateFormCancel').addEventListener('click', closeTemplateModal);
  templateModalEl.addEventListener('click', (e) => { if (e.target === templateModalEl) closeTemplateModal(); });

  // ------------------------------------------------------------- file explorer
  const FE_DIR_ICON = `<svg class="fs-ic" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round"
        d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>`;
  const FE_FILE_ICON = `<svg class="fs-ic" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round"
        d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path stroke-linecap="round" stroke-linejoin="round" d="M14 3v5h5" /></svg>`;
  const FE_UP_ICON = `<svg class="fs-ic" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" /></svg>`;

  function fsParent(rel) {
    const i = rel.lastIndexOf('/');
    return i > 0 ? rel.slice(0, i) : '';
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  function renderBreadcrumb() {
    const parts = state.fsDir ? state.fsDir.split('/') : [];
    fsBreadcrumb.innerHTML = '';
    // root crumb
    const root = document.createElement('span');
    root.className = 'fs-bc-seg';
    root.textContent = 'workspace';
    root.addEventListener('click', () => loadFsDir(''));
    fsBreadcrumb.appendChild(root);
    let acc = '';
    parts.forEach((seg, i) => {
      const sep = document.createElement('span');
      sep.className = 'fs-bc-sep';
      sep.textContent = '/';
      fsBreadcrumb.appendChild(sep);
      acc = acc ? acc + '/' + seg : seg;
      const crumb = document.createElement('span');
      crumb.className = 'fs-bc-seg' + (i === parts.length - 1 ? ' current' : '');
      crumb.textContent = seg;
      if (i !== parts.length - 1)
        crumb.addEventListener('click', () => loadFsDir(acc));
      fsBreadcrumb.appendChild(crumb);
    });
  }

  function makeFsEntry(name, relPath, type, onClick) {
    const row = document.createElement('div');
    row.className = 'fs-entry ' + type;
    row.title = type === 'directory' ? `Open folder ${name}` : `Open file ${name}`;
    row.innerHTML =
      (type === 'directory'
        ? (relPath === '' ? FE_UP_ICON : FE_DIR_ICON)
        : FE_FILE_ICON) +
      `<span class="fs-name">${escapeHtml(name)}</span>` +
      (type === 'file' ? '<span class="fs-meta">file</span>' : '');
    row.addEventListener('click', onClick);
    return row;
  }

  async function loadFsDir(rel) {
    state.fsDir = rel || '';
    renderBreadcrumb();
    fsList.innerHTML = '<div class="fs-muted">Loading…</div>';
    let data;
    try {
      const q = state.fsDir ? '?path=' + encodeURIComponent(state.fsDir) : '';
      const res = await fetch('/api/fs/list' + q);
      data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not list directory');
    } catch (err) {
      fsList.innerHTML = `<div class="fs-muted fs-error">⚠️ ${escapeHtml(err.message)}</div>`;
      return;
    }
    const dirs = data.entries.filter((e) => e.type === 'directory');
    const files = data.entries.filter((e) => e.type === 'file');

    const frag = document.createDocumentFragment();
    if (state.fsDir)
      frag.appendChild(makeFsEntry('..', '', 'dir', () => loadFsDir(fsParent(state.fsDir))));
    dirs.forEach((d) =>
      frag.appendChild(makeFsEntry(d.name, d.path, 'dir', () => loadFsDir(d.path)))
    );
    files.forEach((f) =>
      frag.appendChild(makeFsEntry(f.name, f.path, 'file', () => openFsFile(f)))
    );
    fsList.innerHTML = '';
    if (!frag.childNodes.length) {
      fsList.innerHTML = '<div class="fs-muted">Empty folder</div>';
      return;
    }
    fsList.appendChild(frag);
  }

  async function openFsFile(entry) {
    fsList.innerHTML = '<div class="fs-muted">Loading file…</div>';
    let data;
    try {
      const res = await fetch('/api/fs/read?path=' + encodeURIComponent(entry.path));
      data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not read file');
    } catch (err) {
      fsList.innerHTML = `<div class="fs-muted fs-error">⚠️ ${escapeHtml(err.message)}</div>`;
      return;
    }
    renderFileView(entry, data);
  }

  function renderFileView(entry, data) {
    fsList.innerHTML = '';

    // header: back-to-folder + filename + meta
    const head = document.createElement('div');
    head.className = 'fe-filehead';
    const back = document.createElement('button');
    back.className = 'fe-btn-back';
    back.innerHTML = `${FE_UP_ICON}<span>folder</span>`;
    back.addEventListener('click', () => loadFsDir(fsParent(entry.path)));
    const titleWrap = document.createElement('div');
    titleWrap.className = 'fe-file-title';
    const name = document.createElement('div');
    name.className = 'fe-file-name';
    name.textContent = entry.name;
    const meta = document.createElement('div');
    meta.className = 'fe-file-meta';
    meta.textContent = `${formatBytes(data.bytes)} · ${data.path}`;
    titleWrap.append(name, meta);
    head.append(back, titleWrap);
    fsList.appendChild(head);

    // code block
    const pre = document.createElement('pre');
    pre.className = 'fe-fileview';
    const code = document.createElement('code');
    code.textContent = data.content;
    try {
      if (typeof hljs !== 'undefined') hljs.highlightElement(code);
    } catch { /* keep plain text */ }
    pre.appendChild(code);

    // copy button
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.textContent = 'copy';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(data.content).then(() => {
        btn.textContent = 'copied!';
        setTimeout(() => (btn.textContent = 'copy'), 1500);
      });
    });
    pre.appendChild(btn);

    fsList.appendChild(pre);
  }

  fileExplorerBtn.addEventListener('click', () => {
    showView('files');
    closeSidebar();
  });
  fsBackChat.addEventListener('click', () => showView('chat'));

  // ------------------------------------------------------------- sessions
  async function loadSessions() {
    try {
      const res = await fetch('/api/sessions');
      state.sessions = await res.json();
    } catch {
      state.sessions = [];
    }
    renderSessionList();
  }

  function renderSessionList() {
    sessionListEl.innerHTML = '';
    const confirmingId = state.pendingDeleteId;
    state.sessions.forEach((s) => {
      const confirming = s.id === confirmingId;
      const processing = hasActiveStream(s.id);
      const item = document.createElement('div');
      item.className =
        'session-item' +
        (s.id === state.currentId ? ' active' : '') +
        (confirming ? ' confirming' : '');

      // Inline confirm/cancel state replaces the delete button until confirmed.
      item.innerHTML = `
        <span class="thread-icon">💬</span>
        <span class="title">${escapeHtml(s.title)}</span>
        ${processing ? '<span class="session-processing-indicator" title="processing…"></span>' : ''}
        ${confirming
          ? `<span class="del-ask">
               <button class="del-confirm" data-id="${s.id}" title="Confirm delete">✓</button>
               <button class="del-cancel" data-id="${s.id}" title="Cancel">✕</button>
             </span>`
          : `<button class="del" data-id="${s.id}" title="Delete session">✕</button>`}`;

      item.addEventListener('click', (e) => {
        // Row switches the session; control buttons are handled separately.
        if (e.target.closest('.del, .del-confirm, .del-cancel')) return;
        state.pendingDeleteId = null;
        switchSession(s.id);
        closeSidebar();
      });

      const del = item.querySelector('.del');
      if (del)
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          state.pendingDeleteId = s.id; // enter confirm state for this row
          renderSessionList();
        });

      const confirm = item.querySelector('.del-confirm');
      if (confirm)
        confirm.addEventListener('click', (e) => {
          e.stopPropagation();
          state.pendingDeleteId = null;
          deleteSession(s.id);
        });

      const cancel = item.querySelector('.del-cancel');
      if (cancel)
        cancel.addEventListener('click', (e) => {
          e.stopPropagation();
          state.pendingDeleteId = null;
          renderSessionList();
        });

      sessionListEl.appendChild(item);
    });
  }

  async function switchSession(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    showView('chat'); // a session click always returns to the chat view
    state.pendingDeleteId = null;
    state.currentId = id;
    state.currentMessages = s.messages || [];
    // Reported usage belongs to the session it was captured in — never let
    // it leak into another session's budget.
    state.lastUsage = null;
    state.attachments = [];
    renderChips();
    renderMessages();
    renderSessionList();
    // Stream re-attachment: if THIS session has a running turn (own reader
    // or a turn recovered from the backend registry), re-attach its buffers
    // to the fresh DOM — the live progress, stop button and timer resume.
    if (hasActiveStream(id)) reattachStreamUI();
    else maybeAdoptRemoteTurn(id);
  }

  async function newChat() {
    showView('chat');
    state.pendingDeleteId = null;
    state.currentId = null;
    state.currentMessages = [];
    state.lastUsage = null;
    state.attachments = [];
    renderChips();
    renderMessages();
    renderSessionList();
    promptInput.focus();
  }

  async function deleteSession(id) {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    state.sessions = state.sessions.filter((s) => s.id !== id);
    if (state.currentId === id) {
      state.currentId = null;
      state.currentMessages = [];
      state.lastUsage = null;
      renderMessages();
    }
    renderSessionList();
  }

  async function persistSession(messages, id) {
    // A stream finishing while another session is VIEWED must persist into
    // the STREAM'S session (its own array) — passing (messages, id) makes
    // the target explicit; callers with no args persist the current view.
    const target = Array.isArray(messages) ? messages : state.currentMessages;
    const targetId = typeof id === 'string' ? id : state.currentId;
    if (!target.length) return;
    const title = target.find((m) => m.role === 'user')?.content?.slice(0, 60) || 'New chat';
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: targetId || undefined,
        title: title + (title.length >= 60 ? '…' : ''),
        messages: target,
      }),
    });
    const saved = await res.json();
    state.currentId = saved.id;
    // The usage event is captured mid-stream, when currentId is still null
    // on a brand-new session. Bind it to the persisted id so the context
    // pill uses reported prompt_tokens (real session context) instead of
    // the character estimate.
    if (state.lastUsage) state.lastUsage.sessionId = state.currentId;
    const idx = state.sessions.findIndex((s) => s.id === saved.id);
    if (idx >= 0) state.sessions[idx] = saved;
    else state.sessions.unshift(saved);
    renderSessionList();
  }

  // ------------------------------------------------------------- render
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderMessages() {
    messagesEl.innerHTML = '';
    emptyStateEl.style.display = state.currentMessages.length ? 'none' : 'flex';
    state.currentMessages.forEach((m) => {
      if (m.role === 'tool') { appendToolStep(m); return; }
      appendMessage(m.role, m.content, false, m.meta, m.reasoning);
    });
    scrollToBottom();
    updateBudget();
  }

  // Replay a persisted tool-run record (role:'tool') as a collapsible card:
  // tool name, argument preview, outcome badge and time on the summary row;
  // full arguments + output/error inside. Skipped duplicates show ⏭.
  function appendToolStep(m) {
    emptyStateEl.style.display = 'none';
    const args = typeof m.args === 'string' ? m.args : JSON.stringify(m.args || {});
    const cls = m.skipped ? 'skipped' : (m.ok ? 'ok' : 'err');
    const status = m.skipped ? '⏭ skipped' : (m.ok ? '✓ ok' : '✗ failed');
    const when = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
    const details = [];
    if (m.out) details.push(`<div class="ts-block ts-out"><b>output</b><pre>${escapeHtml(m.out)}</pre></div>`);
    if (m.error) details.push(`<div class="ts-block ts-err-c"><b>${m.skipped ? 'notice' : 'error'}</b><pre>${escapeHtml(m.error)}</pre></div>`);
    if (typeof m.code === 'number' && m.code !== 0) details.push(`<div class="ts-code">exit code ${escapeHtml(String(m.code))}</div>`);
    const wrap = document.createElement('div');
    wrap.className = 'msg ts-msg';
    wrap.innerHTML = `
      <details class="tool-step ${cls}">
        <summary>
          <span class="ts-ic">${m.skipped ? '⏭' : '🔧'}</span>
          <span class="ts-name">${escapeHtml(m.tool || 'tool')}</span>
          <span class="ts-args">${escapeHtml(args.slice(0, 160))}${args.length > 160 ? ' …' : ''}</span>
          <span class="ts-status ${cls}">${status}</span>
          ${when ? `<span class="ts-when">${escapeHtml(when)}</span>` : ''}
        </summary>
        <div class="ts-body">
          <div class="ts-block"><b>args</b><pre>${escapeHtml(args)}</pre></div>
          ${details.join('')}
        </div>
      </details>`;
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  function appendMessage(role, content, animate = true, meta, reasoning) {
    emptyStateEl.style.display = 'none';
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (animate ? 'msg' : '');
    if (role === 'user') {
      wrap.className = 'msg msg-user';
      wrap.textContent = content;
    } else {
      wrap.className = 'msg msg-assistant';
      const reasoningHTML =
        reasoning && reasoning.trim()
          ? `<div class="reasoning collapsed"><button class="reasoning-toggle" type="button"><span class="reasoning-dot"></span>Reasoning / Thinking<span class="reasoning-chev">▾</span></button><div class="reasoning-body"><pre class="reasoning-text">${escapeHtml(reasoning)}</pre></div></div>`
          : '';
      wrap.innerHTML = reasoningHTML + marked.parse(content);
      // Bubble-level delegation owns EVERY .reasoning-toggle in this message
      // (live placeholder + history panels): one binding, toggle the panel
      // containing the clicked button.
      wrap.addEventListener('click', (e) => {
        const t = e.target && e.target.closest ? e.target.closest('.reasoning-toggle') : null;
        if (t) {
          const panel = t.closest('.reasoning');
          if (panel) panel.classList.toggle('collapsed');
        }
      });
      if (meta) {
        const metaEl = document.createElement('div');
        metaEl.className = 'msg-meta';
        metaEl.textContent = meta;
        wrap.appendChild(metaEl);
      }
      attachCopyButtons(wrap);
    }
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  function attachCopyButtons(container) {
    container.querySelectorAll('pre').forEach((pre) => {
      const btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.textContent = 'copy';
      btn.addEventListener('click', () => {
        const code = pre.querySelector('code').innerText;
        navigator.clipboard.writeText(code).then(() => {
          btn.textContent = 'copied!';
          setTimeout(() => (btn.textContent = 'copy'), 1500);
        });
      });
      pre.appendChild(btn);
    });
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      $('#chatContainer').scrollTop = $('#chatContainer').scrollHeight;
    });
  }

  // ------------------------------------------------------------- context budget
  const RING_CIRC = 97.39; // 2 * pi * r for the SVG ring (r = 15.5)

  function formatTok(n) {
    n = Number(n) || 0;
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  // "42s" / "1m 12s" — generation duration for the message footer badge.
  function fmtDuration(ms) {
    ms = Number(ms) || 0;
    const s = Math.max(1, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  }

  // Badge text for a completed assistant message; null when there is nothing
  // to show (no usage reported — e.g. interrupted requests).
  //
  // CONTRACT: the visible badge carries ONLY this response's own generated
  // tokens — completion_tokens, accumulated server-side across every
  // completion round of the turn (router + tool loop + final answer).
  // Session context (prompt_tokens) NEVER appears on the message footer; the
  // bottom context pill owns that number (updateBudget). KV-cache + speed
  // details live in the footer's title tooltip (genMetaTooltip).
  function genMetaText(u, tg) {
    if (!u) return null;
    const totalTokens = Number(u.completion_tokens) || 0;
    const parts = [];
    if (Number(u.elapsedMs) > 0) parts.push(`⚡ ${fmtDuration(u.elapsedMs)}`);
    if (totalTokens > 0) parts.push(`${formatTok(totalTokens)} tok`);
    return parts.length ? parts.join(' · ') : null;
  }

  // KV-cache / throughput detail for the footer tooltip: `tg` is the
  // llama.cpp `timings` object from the final chunk (prompt_n = tokens
  // actually evaluated this request, so cached = prompt_tokens - prompt_n).
  function genMetaTooltip(u, tg) {
    if (!u || !tg) return null;
    const bits = [];
    const cached = Number.isFinite(tg.prompt_n)
      ? Math.max(0, (Number(u.prompt_tokens) || 0) - Number(tg.prompt_n))
      : null;
    if (cached !== null) bits.push(`${formatTok(cached)} prompt tokens reused from the KV cache`);
    const pp = Number(tg.prompt_per_second);
    const gen = Number(tg.predicted_per_second);
    if (Number.isFinite(pp) && pp > 0 && Number.isFinite(gen) && gen > 0) {
      bits.push(`${pp.toFixed(1)}/${gen.toFixed(1)} prompt/gen tok/s`);
    }
    return bits.length ? bits.join(' · ') : null;
  }

  // Rough token estimate fallback: ~4 chars per token, per message.
  function estimatePromptTokens() {
    return state.currentMessages.reduce(
      (sum, m) => sum + Math.max(1, Math.ceil(((m?.content || '').length) / 4)),
      0
    );
  }

  function computeTokens() {
    // Prefer llama.cpp's reported usage for the current session when available;
    // otherwise fall back to a character-based estimate.
    if (state.lastUsage && state.lastUsage.sessionId === state.currentId) {
      return {
        input: state.lastUsage.prompt_tokens ?? estimatePromptTokens(),
        output: state.lastUsage.completion_tokens ?? 0,
        source: 'reported',
      };
    }
    return { input: estimatePromptTokens(), output: 0, source: 'estimated' };
  }

  function updateBudget() {
    const win = state.context.window || 8192;
    const { input, output, source } = computeTokens();
    // Session context usage: cumulative PROMPT tokens in the active window
    // vs the max context limit (e.g. "2.6k / 65.5k · 4%"). Output tokens of
    // the last turn belong to the message footer (± this turn's completion
    // only), never to the session budget shown in the pill/ring/bar.
    const used = input;
    const pct = Math.min(100, Math.max(0, Math.round((used / win) * 100)));

    // ring + bar colour by usage severity
    const col = pct >= 90 ? 'text-red-500' : pct >= 70 ? 'text-amber-500' : 'text-emerald-500';
    const barCol = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';

    contextRing.style.strokeDashoffset = String(RING_CIRC * (1 - pct / 100));
    contextRing.classList.remove('text-emerald-500', 'text-amber-500', 'text-red-500');
    contextRing.classList.add(col);

    contextSummary.textContent = `${formatTok(used)} / ${formatTok(win)} · ${pct}%`;
    $('#ctxTokens').textContent = `${formatTok(used)} / ${formatTok(win)}`;
    $('#ctxPct').textContent = pct + '%';
    const bar = $('#ctxBar');
    bar.style.width = pct + '%';
    bar.classList.remove('bg-emerald-500', 'bg-amber-500', 'bg-red-500');
    bar.classList.add(barCol);
    $('#ctxInput').textContent = formatTok(input);
    $('#ctxOutput').textContent = formatTok(output);
    $('#ctxSource').textContent =
      source === 'reported'
        ? 'From llama.cpp usage stats.'
        : 'Estimated from message length (~4 chars/token).';
  }

  // ------------------------------------------------------------- popovers
  function closePopovers() {
    contextPopover.classList.add('hidden');
    settingsPopover.classList.add('hidden');
    attachPopover.classList.add('hidden');
    if (reasoningMenu) reasoningMenu.classList.add('hidden');
  }
  contextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = contextPopover.classList.contains('hidden');
    closePopovers();
    if (willOpen) contextPopover.classList.remove('hidden');
  });
  // Reasoning effort & visibility controller (Off|Default|Low|Medium|High):
  // the compose-toolbar brain button opens #reasoningMenu; the chosen level
  // is persisted (pagent.reasoningLevel) and sent with every /api/chat
  // request (body.reasoningLevel -> routes/chat.js -> buildChatPayload ->
  // reasoning_effort / thinking budget). Off ALSO hides every thinking panel
  // (live + history) via body.no-reasoning; the stream keeps arriving and
  // the trace is still stored on the message, so switching back restores it.
  const reasoningToggleBtn = $('#reasoningToggle');
  const REASONING_LEVEL_LABEL = { off: 'Off', default: 'Default', low: 'Low', medium: 'Medium', high: 'High' };
  const applyReasoningVisibility = () => {
    const off = state.reasoningLevel === 'off';
    document.body.classList.toggle('no-reasoning', off);
    if (reasoningToggleBtn) {
      reasoningToggleBtn.classList.toggle('on', !off);
      reasoningToggleBtn.title = off
        ? 'Reasoning: Off — click to change the effort level'
        : `Reasoning effort: ${REASONING_LEVEL_LABEL[state.reasoningLevel] || 'Default'} — click to change`;
    }
    if (reasoningLevelLabel) {
      reasoningLevelLabel.textContent = REASONING_LEVEL_LABEL[state.reasoningLevel] || 'Default';
    }
    if (reasoningMenu) {
      reasoningMenu.querySelectorAll('[data-level]').forEach((btn) => {
        const active = btn.getAttribute('data-level') === state.reasoningLevel;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }
  };
  if (reasoningToggleBtn && reasoningMenu) {
    reasoningToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = reasoningMenu.classList.contains('hidden');
      closePopovers();
      if (willOpen) reasoningMenu.classList.remove('hidden');
    });
    reasoningMenu.addEventListener('click', (e) => {
      const item = e.target && e.target.closest ? e.target.closest('[data-level]') : null;
      if (!item) return;
      state.reasoningLevel = item.getAttribute('data-level') || 'default';
      try { localStorage.setItem('pagent.reasoningLevel', state.reasoningLevel); } catch { /* private mode */ }
      reasoningMenu.classList.add('hidden');
      applyReasoningVisibility();
    });
    applyReasoningVisibility();
  }

  genSettingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = settingsPopover.classList.contains('hidden');
    closePopovers();
    if (willOpen) settingsPopover.classList.remove('hidden');
  });
  [contextPopover, settingsPopover].forEach((p) =>
    p.addEventListener('click', (e) => e.stopPropagation())
  );
  document.addEventListener('click', closePopovers);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePopovers();
      if (!libViewModalEl.classList.contains('hidden')) closeLibViewModal();
    }
  });

  // ------------------------------------------------------------- settings control
  /** Disable the advanced-params toggle when the ACTIVE model is cloud-hosted
   * (the backend always strips local-only params there — toggling would be
   * misleading). Local active model (or none): enabled, default hint. */
  function applyAdvancedAdaptive(models) {
    if (!advParamsToggle || !advParamsHint) return;
    const act = (models || []).find((m) => m.active) || null;
    const cloud = !act || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)/i.test(String(act.endpoint || ''));
    advParamsToggle.disabled = cloud;
    advParamsHint.textContent = cloud
      ? 'Active model is cloud-hosted — these parameters are always stripped server-side (providers reject them with HTTP 400).'
      : 'repeat_penalty · repeat_last_n · cache_prompt — sent to local llama.cpp servers only; always stripped for cloud APIs. Disabling also disables KV cache reuse.';
  }
  function applySettingsToUI() {
    tempRange.value = state.settings.temperature;
    tempVal.textContent = Number(state.settings.temperature).toFixed(2);
    toppRange.value = state.settings.top_p;
    toppVal.textContent = Number(state.settings.top_p).toFixed(2);
    maxTokensInput.value = state.settings.max_tokens;
    if (advParamsToggle) advParamsToggle.checked = state.settings.advanced !== false;
  }
  tempRange.addEventListener('input', () => {
    const v = parseFloat(tempRange.value);
    state.settings.temperature = v;
    tempVal.textContent = v.toFixed(2);
  });
  toppRange.addEventListener('input', () => {
    const v = parseFloat(toppRange.value);
    state.settings.top_p = v;
    toppVal.textContent = v.toFixed(2);
  });
  maxTokensInput.addEventListener('input', () => {
    const v = parseInt(maxTokensInput.value, 10);
    if (Number.isFinite(v) && v > 0 && v <= 8192) state.settings.max_tokens = v;
  });
  if (advParamsToggle) {
    advParamsToggle.addEventListener('change', () => {
      state.settings.advanced = advParamsToggle.checked;
    });
  }
  resetSettingsBtn.addEventListener('click', () => {
    state.settings = { temperature: 0.7, top_p: 0.95, max_tokens: 2048, advanced: true };
    applySettingsToUI();
    if (advParamsToggle) advParamsToggle.checked = true;
  });
  applySettingsToUI();

  // ------------------------------------------------------------- slash picker
  // "/" autocomplete: while composing, a caret word starting with "/" lists
  // the enabled skills; arrows + Enter/Tab (or click) insert "/skillname ".
  let pickerSkills = null; // [{ name, description }] enabled skills, lazy cache
  let pickerMatches = [];  // currently rendered subset
  let pickerIndex = 0;     // highlighted row

  function refreshPickerSkills(skills) {
    pickerSkills = (Array.isArray(skills) ? skills : [])
      .filter((s) => s && s.name && s.enabled !== false)
      .map((s) => ({ name: s.name, description: s.description || '' }));
  }

  let pickerSkillsPromise = null;
  function ensurePickerSkills() {
    if (pickerSkills) return Promise.resolve(pickerSkills);
    if (!pickerSkillsPromise) {
      pickerSkillsPromise = (async () => {
        try {
          const res = await fetch('/api/skills');
          const data = await res.json();
          refreshPickerSkills(data && data.skills);
        } catch {
          pickerSkills = [];
        }
        return pickerSkills;
      })();
    }
    return pickerSkillsPromise;
  }

  // The caret word: "/query" at line start or right after whitespace.
  function pickerQuery() {
    const v = promptInput.value;
    const caret = promptInput.selectionStart == null ? v.length : promptInput.selectionStart;
    const m = /(?:^|\s)\/([A-Za-z0-9._-]*)$/.exec(v.slice(0, caret));
    return m ? { query: m[1].toLowerCase(), slashAt: caret - m[1].length - 1 } : null;
  }

  function closeSkillPicker() {
    skillPickerEl.classList.add('hidden');
    skillPickerEl.innerHTML = '';
    pickerMatches = [];
  }

  function paintSkillPicker() {
    for (const item of skillPickerEl.children) {
      item.classList.toggle('active', Number(item.dataset.index) === pickerIndex);
    }
  }

  function renderSkillPicker(list) {
    skillPickerEl.innerHTML = '';
    pickerMatches = list;
    pickerIndex = Math.min(pickerIndex, Math.max(0, list.length - 1));
    list.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = 'skill-picker-item' + (i === pickerIndex ? ' active' : '');
      item.dataset.index = String(i);
      item.innerHTML =
        `<span class="skill-picker-name">/${escapeHtml(s.name)}</span>` +
        (s.description ? `<span class="skill-picker-desc">${escapeHtml(s.description)}</span>` : '');
      item.addEventListener('mousedown', (e) => e.preventDefault()); // keep textarea focus
      item.addEventListener('click', () => acceptSkillPick(i));
      skillPickerEl.appendChild(item);
    });
  }

  async function maybeOpenSkillPicker() {
    const q = pickerQuery();
    if (!q) return closeSkillPicker();
    await ensurePickerSkills();
    const now = pickerQuery();
    if (!now) return closeSkillPicker(); // input moved on while fetching
    const matches = (pickerSkills || [])
      .filter((s) => s.name.toLowerCase().includes(now.query))
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(now.query) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(now.query) ? 0 : 1;
        return ap - bp || a.name.localeCompare(b.name);
      });
    if (!matches.length) return closeSkillPicker();
    renderSkillPicker(matches);
    skillPickerEl.classList.remove('hidden');
  }

  function acceptSkillPick(i) {
    const s = pickerMatches[i];
    const q = pickerQuery();
    if (!s || !q) return closeSkillPicker();
    const v = promptInput.value;
    // Insert the bare on-disk skill name — NO leading slash. The "/" is only
    // the picker trigger; a slash-prefixed name would reach the backend as
    // "/print_datetime" and fail slug validation (the backend now tolerates
    // the slash form too, but the message should carry the real name).
    const insert = `${s.name} `;
    // Replace the typed "/query" (slash at q.slashAt, query after it) with
    // the full "skillname " mention.
    promptInput.value = v.slice(0, q.slashAt) + insert + v.slice(q.slashAt + q.query.length + 1);
    const caret = q.slashAt + insert.length;
    promptInput.setSelectionRange(caret, caret);
    autoResize();
    closeSkillPicker();
    promptInput.focus();
  }

  // Close when clicking anywhere outside the picker (item clicks use
  // mousedown-preventDefault so the textarea never blurs mid-insert).
  document.addEventListener('click', (e) => {
    if (!skillPickerEl.classList.contains('hidden') && !skillPickerEl.contains(e.target)) closeSkillPicker();
  });

  // ------------------------------------------------------------- gen timer
  // Live "⏱ Ns…" pill in the compose toolbar while the agent is working
  // (queue wait + tool loop + generation); hidden when idle.
  let genStartedAt = 0;
  let genTimerInterval = null;

  function paintGenTimer() {
    const s = Math.max(0, Math.round((Date.now() - genStartedAt) / 1000));
    genTimerEl.textContent =
      `⏱ ${s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`}…`;
  }

  function startGenTimer(from) {
    // Re-attach support: `from` restores the ORIGINAL turn start so the
    // elapsed counter is seamless across session switches.
    genStartedAt = typeof from === 'number' ? from : Date.now();
    genTimerEl.classList.remove('hidden');
    paintGenTimer();
    clearInterval(genTimerInterval);
    genTimerInterval = setInterval(paintGenTimer, 1000);
  }

  function stopGenTimer() {
    clearInterval(genTimerInterval);
    genTimerInterval = null;
    genTimerEl.classList.add('hidden');
    genTimerEl.textContent = '';
  }

  // ------------------------------------------------------------- input
  function autoResize() {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 192) + 'px';
  }
  promptInput.addEventListener('input', () => {
    autoResize();
    maybeOpenSkillPicker();
  });

  promptInput.addEventListener('keydown', (e) => {
    const pickerOpen = !skillPickerEl.classList.contains('hidden');
    if (pickerOpen && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation(); // never send or leave the input while picking
      if (e.key === 'ArrowDown') { pickerIndex = (pickerIndex + 1) % pickerMatches.length; paintSkillPicker(); }
      else if (e.key === 'ArrowUp') { pickerIndex = (pickerIndex - 1 + pickerMatches.length) % pickerMatches.length; paintSkillPicker(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { acceptSkillPick(pickerIndex); }
      else if (e.key === 'Escape') { closeSkillPicker(); }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', () => {
    if (state.streaming) {
      stopGeneration();
    } else {
      sendMessage();
    }
  });

  // ------------------------------------------------------------- chat
  // Reasoning / thinking stream state machine — pure and DOM-free so it can
  // be unit-tested through window.__streamHooks (see the UI test harness).
  // pumpStream splits <thinking>…</thinking> blocks (DeepSeek-R1 style, e.g.
  // llama.cpp distills) out of the content stream into the reasoning trace,
  // tolerating tags split arbitrarily across SSE chunks. Reasoning deltas
  // arriving in their own field (OpenRouter `reasoning` — the relay sends
  // them as delta.reasoning) bypass pumpStream and append directly.
  const THINK_OPEN = '<thinking>';
  const THINK_CLOSE = '</thinking>';
  function streamState() {
    return { mode: 'answer', raw: '', text: '', reasoning: '' };
  }
  function isPartialThinkTag(tail) {
    if (!/^\s{0,2}<[a-z]*$/.test(tail) || tail.length >= 12) return false;
    const name = tail.replace(/^\s{0,2}/, '');
    return name.length > 0 && THINK_OPEN.startsWith(name);
  }
  function isPartialCloseTag(tail) {
    return tail.length > 0 && tail.length < THINK_CLOSE.length && THINK_CLOSE.startsWith(tail);
  }
  function pumpStream(st, delta) {
    st.raw += delta;
    for (;;) {
      if (st.mode === 'thinking') {
        const ci = st.raw.indexOf(THINK_CLOSE);
        if (ci === -1) {
          // Hold a trailing PARTIAL close tag across chunks (e.g. '</th' +
          // 'inking>…') — appending it to the reasoning trace would leak the
          // tag and, worse, the next chunk would complete the tag inside the
          // trace ('</th' + 'inking>…' contains no full tag for indexOf).
          if (isPartialCloseTag(st.raw.slice(-(THINK_CLOSE.length - 1)))) break;
          st.reasoning += st.raw;
          st.raw = '';
          break;
        }
        st.reasoning += st.raw.slice(0, ci);
        st.raw = st.raw.slice(ci + THINK_CLOSE.length);
        st.mode = 'answer';
        continue;
      }
      const oi = st.raw.indexOf(THINK_OPEN);
      if (oi === -1) {
        if (isPartialThinkTag(st.raw.slice(-12))) break; // hold for the next chunk
        st.text += st.raw;
        st.raw = '';
        break;
      }
      if (oi > 0) st.text += st.raw.slice(0, oi);
      st.raw = st.raw.slice(oi + THINK_OPEN.length);
      st.mode = 'thinking';
    }
  }
  window.__streamHooks = { streamState, pumpStream, THINK_OPEN, THINK_CLOSE, state: () => state, renderMessages, appendMessage };

  // Fetch /api/chat with ONE automatic retry on transport-level failures only
  // (never on user abort). Server-side, the request queue already retries
  // transient upstream errors, so a queued request recovers on its own.
  async function fetchChat(body, signal) {
    try {
      return await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      await new Promise((r) => setTimeout(r, 1000));
      return fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    }
  }

  // --------------------------------------------------------------------
  // Per-session stream re-attachment
  // --------------------------------------------------------------------
  // A running turn belongs to its SESSION, not to the current view: the
  // reader keeps consuming into the stream record while the user is on
  // another session, and switching back re-attaches the buffers to fresh
  // DOM (buildAssistantBubble + replay) instead of freezing on stale node
  // references. The sidebar pulse, the stop button and the timer all read
  // the same registry, so they stay synchronized.

  /** Build the assistant bubble scaffolding; returns live element refs. */
  function buildAssistantBubble() {
    const el = appendMessage(
      'assistant',
      `<div class="agent-status hidden"></div>` +
        `<div class="reasoning hidden collapsed">` +
        `<button class="reasoning-toggle" type="button"><span class="reasoning-dot"></span>Reasoning / Thinking<span class="reasoning-chev">▾</span></button>` +
        `<div class="reasoning-body"><pre class="reasoning-text"></pre></div>` +
        `</div>` +
        `<div class="agent-content"><span class="typing"><span></span><span></span><span></span></span></div>`
    );
    return {
      assistantEl: el,
      statusEl: el.querySelector('.agent-status'),
      reasoningEl: el.querySelector('.reasoning'),
      reasoningTextEl: el.querySelector('.reasoning-text'),
      contentEl: el.querySelector('.agent-content'),
    };
  }

  function hasActiveStream(sid) {
    const s = state.activeStreams[sid];
    return !!s && !s.done;
  }

  /** Re-attach the current view to its session's running stream. The DOM
   *  was re-rendered by switchSession, so stale refs are replaced by fresh
   *  ones and the buffered state (statuses, reasoning, partial text) is
   *  replayed; the timer restarts from the ORIGINAL turn start. */
  function reattachStreamUI() {
    const stream = state.activeStreams[state.currentId];
    if (!stream || stream.done) return;
    stream.refs = buildAssistantBubble();
    const { statusEl, contentEl, reasoningEl, reasoningTextEl } = stream.refs;
    for (const msg of stream.statuses) {
      const line = document.createElement('div');
      line.className = 'tool-line' + (msg && msg.trim().startsWith('\u26a0') ? ' err' : '');
      line.textContent = msg;
      statusEl.appendChild(line);
    }
    if (stream.statuses.length) statusEl.classList.remove('hidden');
    if (stream.reasoning) {
      reasoningEl.classList.remove('hidden');
      reasoningEl.classList.remove('collapsed');
      reasoningTextEl.textContent = stream.reasoning.trim();
    }
    if (stream.text) {
      contentEl.innerHTML = '';
      contentEl.textContent = stream.text;
    }
    startGenTimer(stream.startedAt);
    syncStreamingUI();
    scrollToBottom();
  }

  /** Stop button / send-gate reflect the CURRENT VIEW's stream while the
   *  global send-gate stays on while ANY stream runs (backend FIFO-queues
   *  concurrent requests). */
  function syncStreamingUI() {
    const anyActive = Object.values(state.activeStreams).some((s) => !s.done);
    state.streaming = anyActive;
    if (hasActiveStream(state.currentId)) setStreamingUI(true);
    else setStreamingUI(false);
  }

  let remotePollTimer = null;

  /** Adopt a turn we LOST the reader for (hard refresh mid-turn): the
   *  backend registry (GET /api/chat/state/:sessionId) still mirrors it.
   *  Only when no own stream exists — the live reader always wins. */
  function maybeAdoptRemoteTurn(sid) {
    if (hasActiveStream(sid) || sid == null) return;
    fetch(`/api/chat/state/${encodeURIComponent(String(sid))}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((st) => {
        if (!st || !st.active) return;
        state.activeStreams[sid] = {
          sessionId: sid,
          abort: null,
          startedAt: Date.now(),
          statuses: st.statuses || [],
          text: st.text || '',
          reasoning: '',
          sessionMessages: null, // resolved at finalize from the sessions store
          refs: null,
          done: false,
          remote: true,
        };
        renderSessionList();
        if (state.currentId === sid) reattachStreamUI();
        clearInterval(remotePollTimer);
        remotePollTimer = setInterval(() => pollRemoteTurn(sid), 1200);
      })
      .catch(() => {});
  }

  /** Poll a remotely adopted turn until it finishes, then fold the final
   *  text into the session store (the client owns persistence, so a turn
   *  completed while the client was away is recovered from the registry). */
  async function pollRemoteTurn(sid) {
    const stream = state.activeStreams[sid];
    if (!stream) { clearInterval(remotePollTimer); remotePollTimer = null; return; }
    let st = null;
    try {
      const r = await fetch(`/api/chat/state/${encodeURIComponent(String(sid))}`);
      st = r.ok ? await r.json() : null;
    } catch { return; } // transient — keep polling
    stream.statuses = st ? st.statuses : stream.statuses;
    stream.text = st ? st.text : stream.text;
    if (state.currentId === sid && stream.refs) {
      // Live re-sync of the replayed bubble.
      const { statusEl, contentEl } = stream.refs;
      statusEl.innerHTML = '';
      for (const msg of stream.statuses) {
        const line = document.createElement('div');
        line.className = 'tool-line' + (msg && msg.trim().startsWith('\u26a0') ? ' err' : '');
        line.textContent = msg;
        statusEl.appendChild(line);
      }
      if (stream.statuses.length) statusEl.classList.remove('hidden');
      if (stream.text && contentEl.textContent !== stream.text) contentEl.textContent = stream.text;
      scrollToBottom();
    }
    if (st && !st.active) {
      clearInterval(remotePollTimer);
      remotePollTimer = null;
      delete state.activeStreams[sid];
      renderSessionList();
      // Fold the recovered final text into the persisted session.
      const sess = state.sessions.find((x) => x.id === sid);
      if (sess && stream.text) {
        sess.messages = sess.messages || [];
        sess.messages.push({ role: 'assistant', content: stream.text });
        persistSession(sess.messages, sid);
        if (state.currentId === sid) {
          renderMessages();
          const refs = buildAssistantBubble();
          stream.refs = refs;
          refs.contentEl.innerHTML = marked.parse(stream.text);
          attachCopyButtons(refs.contentEl);
          scrollToBottom();
          syncStreamingUI();
        }
      } else {
        syncStreamingUI();
      }
    }
  }

  async function sendMessage() {
    const text = promptInput.value.trim();
    if (!text || state.streaming) return;

    // The stream belongs to THIS SESSION: the record keeps buffering while
    // the user visits other sessions, and all message pushes go to the
    // session's OWN array (state.currentMessages is re-pointed on every
    // switchSession — writing it directly would corrupt another session).
    const sid = state.currentId;
    const sessionMessages = state.currentMessages;

    // Attachments queued via the paperclip: snapshot them for this message,
    // render them inside the user bubble, then clear the compose row.
    const sentAttachments = state.attachments.slice();

    state.currentMessages.push({ role: 'user', content: text });
    promptInput.value = '';
    autoResize();
    if (sentAttachments.length) {
      const wrap = appendMessage('user', text);
      const chips = document.createElement('div');
      chips.className = 'msg-attach-chips';
      chips.innerHTML = sentAttachments
        .map((a) => `<span class="attach-chip static">📎 ${escapeHtml(a.name)}</span>`)
        .join('');
      wrap.appendChild(chips);
      state.attachments = [];
      renderChips();
    } else {
      appendMessage('user', text);
    }
    setStreamingUI(true);
    startGenTimer();
    // Optimistic badge: the request is out — show the model as active even
    // before the next status poll picks up the prefill phase.
    if (state.modelStatus) renderModelStatus({ ...state.modelStatus, busy: true });

    // Per-session stream record: buffers + abort + DOM refs. Registered
    // BEFORE the fetch so the sidebar pulse appears immediately.
    const stream = {
      sessionId: sid,
      abort: null, // assigned once the AbortController exists (below)
      startedAt: Date.now(),
      statuses: [],
      text: '',
      reasoning: '',
      sessionMessages,
      refs: null,
      done: false,
    };
    state.activeStreams[sid] = stream;
    renderSessionList(); // pulse indicator for this session

    // assistant placeholder: status feed (hidden) + reasoning panel + content
    // slot (typing first). The reasoning panel appears only once reasoning
    // tokens arrive; it is auto-open while thinking and collapses on
    // completion (the toggle re-expands it at any time).
    stream.refs = buildAssistantBubble();
    // LIVE refs: reattachStreamUI() replaces stream.refs when the user
    // switches back mid-turn — every DOM write must read the CURRENT refs
    // (a one-time destructure would keep writing into the detached bubble).
    const refs = () => stream.refs || {};
    // Live-stream accumulation: reasoning trace + visible answer text,
    // split/pumped per SSE delta (see pumpStream above).
    const st = streamState();
    // View check evaluated at USE time: the user may switch sessions
    // mid-stream; handleData re-evaluates per event, the completion/finally
    // paths below re-check when they run.
    const viewingNow = () => sid === state.currentId;
    let typingOn = true;
    const addToolStatus = (msg) => {
      if (typingOn) { typingOn = false; refs().contentEl.innerHTML = ''; }
      refs().statusEl.classList.remove('hidden');
      const line = document.createElement('div');
      line.className = 'tool-line' + (msg && msg.trim().startsWith('\u26a0') ? ' err' : '');
      line.textContent = msg || '';
      refs().statusEl.appendChild(line);
      scrollToBottom();
    };
    let reqUsage = null; // usage from THIS request only (tokens + elapsedMs)
    let reqTimings = null; // llama.cpp timings from this request (cache + speeds)
    const captureUsage = (u) => {
      reqUsage = u;
      state.lastUsage = {
        sessionId: sid, // the STREAM's session — not state.currentId (view)
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
      };
    };
    const captureTimings = (t) => { reqTimings = t; };

    const apiMessages = state.currentMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    // abortable stream
    const ac = new AbortController();
    state.abortController = ac;
    stream.abort = ac;
    let full = ''; // accumulated assistant text, visible to the abort handler

    // Paint the current stream state into the DOM without re-parsing the
    // whole markdown on every token (no flicker); plain text while
    // streaming, markdown once at the end. The reasoning panel shows live
    // and auto-opens while tokens are arriving.
    const liveRender = () => {
      if (typingOn && (st.text || st.reasoning)) {
        typingOn = false;
        refs().contentEl.innerHTML = '';
      }
      if (refs().contentEl.textContent !== st.text) refs().contentEl.textContent = st.text;
      if (st.reasoning) {
        refs().reasoningEl.classList.remove('hidden');
        refs().reasoningEl.classList.remove('collapsed');
        refs().reasoningEl.classList.add('streaming');
        refs().reasoningTextEl.textContent = st.reasoning.trim();
      }
      // The final answer has started: thinking is done — stop the pulsing
      // dot and collapse the panel (the toggle re-expands it anytime).
      if (st.text && refs().reasoningEl.classList.contains('streaming')) {
        refs().reasoningEl.classList.remove('streaming');
        refs().reasoningEl.classList.add('collapsed');
      }
      scrollToBottom();
    };

    // Completion-time reasoning panel finalization: stop the pulsing dot and
    // collapse the panel (the toggle re-expands it); hide it entirely when
    // nothing was streamed.
    const pushReasoning = (reasoning) => {
      refs().reasoningEl.classList.remove('streaming');
      refs().reasoningEl.classList.add('collapsed');
      if (!reasoning) refs().reasoningEl.classList.add('hidden');
    };

    const handleData = (json) => {
      // DOM writes below only apply while THIS session is the visible one;
      // buffering into the stream record happens ALWAYS so a re-attach can
      // replay everything.
      const viewing = sid === state.currentId;
      if (json.type === 'tool') {
        // Durable tool-step record: persisted into the session's OWN history
        // (state.currentMessages is re-pointed per view — never coroutine
        // into it) so tool rounds survive session switches/refreshes;
        // renderMessages replays them as collapsible cards. Live activity
        // stays in the transient ⚙ status feed — no DOM duplication.
        sessionMessages.push({
          role: 'tool',
          tool: json.tool,
          args: json.args,
          ok: json.ok === true,
          skipped: json.skipped === true,
          code: json.code,
          out: json.out,
          error: json.error,
          ts: json.ts || Date.now(),
        });
        return;
      }
      if (json.type === 'status') {
        stream.statuses.push(json.message || '');
        if (viewing) addToolStatus(json.message || '');
        return;
      }
      if (json.type === 'round') {
        // Round boundary: the backend streams EVERY round's deltas live; a
        // non-final round (tool-call JSON, ROUTE_TO_PRIMARY markers) must
        // not stick as the visible answer — wipe it. The final round's
        // event (final:true) leaves the live text in place.
        if (!json.final) {
          const had = !!(st.text || st.reasoning);
          st.text = '';
          st.reasoning = '';
          st.raw = '';
          st.mode = 'answer';
          full = '';
          stream.text = '';
          stream.reasoning = '';
          if (viewing && had) {
            refs().contentEl.textContent = '';
            refs().reasoningEl.classList.add('hidden');
            refs().reasoningTextEl.textContent = '';
          }
        }
        return;
      }
      const d = json.choices?.[0]?.delta || {};
      if (typeof d.reasoning === 'string' && d.reasoning) {
        st.reasoning += d.reasoning;
        stream.reasoning = st.reasoning;
      }
      if (typeof d.content === 'string' && d.content) pumpStream(st, d.content);
      if (st.text !== full) {
        full = st.text;
        stream.text = full;
      }
      if (viewing && (st.text || st.reasoning)) liveRender();
      if (json.usage) captureUsage(json.usage);
      if (json.timings) captureTimings(json.timings);
    };

    try {
      const res = await fetchChat(
        {
          messages: apiMessages,
          stream: true,
          // Session id for the turn-state registry: enables backend re-attach
          // (GET /api/chat/state/:sessionId) after a lost reader. Never part
          // of the model history.
          sessionId: sid || undefined,
          generation: { ...state.settings },
          reasoningLevel: state.reasoningLevel,
          ...(sentAttachments.length
            ? { attachments: sentAttachments.map((a) => ({ id: a.id })) }
            : {}),
        },
        ac.signal
      );

      // Polite queue feedback: when a previous request is still streaming we
      // were FIFO-queued — show the position instead of letting the user
      // wonder why nothing happens.
      const queuePos = Number(res.headers.get('X-Queue-Position'));
      if (queuePos > 1) {
        addToolStatus(`⏳ Queue position ${queuePos} — waiting for the previous request to finish…`);
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      // Stream SSE: consume status events (tool activity), content deltas, usage.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try { handleData(JSON.parse(data)); } catch { /* partial chunk */ }
        }

        if (viewingNow() && full) {
          // Live plain-text paint per chunk (markdown only at the end) —
          // re-parsing the whole message on every token flickers and stalls
          // on long outputs; textContent stays smooth at any token rate.
          if (refs().contentEl.textContent !== full) refs().contentEl.textContent = full;
          scrollToBottom();
        }
      }

      // flush remaining buffer
      if (buffer.trim().startsWith('data:')) {
        const data = buffer.trim().slice(5).trim();
        if (data && data !== '[DONE]') {
          try { handleData(JSON.parse(data)); } catch { /* ignore */ }
        }
      }

      // If the only output was an error status, surface it instead of an empty answer.
      if (!full && !st.reasoning) {
        const errStatus = stream.statuses.find((s) => s && s.trim().startsWith('\u26a0'));
        if (errStatus) {
          refs().contentEl.innerHTML =
            `<div class="text-red-500 dark:text-red-400 font-medium">⚠️ ${escapeHtml(errStatus.replace(/^\u26a0\s*/, ''))}</div>`;
          scrollToBottom();
          return; // finally still runs
        }
        throw new Error('Empty response from llama.cpp');
      }

      const metaText = genMetaText(reqUsage, reqTimings);
      sessionMessages.push({
        role: 'assistant',
        content: full,
        ...(st.reasoning ? { reasoning: st.reasoning.trim() } : {}),
        meta: metaText,
      });
      if (viewingNow()) {
        pushReasoning(st.reasoning);
        refs().contentEl.innerHTML = marked.parse(full);
        attachCopyButtons(refs().contentEl);
        if (metaText) {
          const metaEl = document.createElement('div');
          metaEl.className = 'msg-meta';
          metaEl.textContent = metaText;
          // KV-cache / throughput detail moves to the hover tooltip so the
          // visible badge stays strictly "duration · this response's tokens".
          const tip = genMetaTooltip(reqUsage, reqTimings);
          if (tip) metaEl.title = 'Footer badges: duration + tokens generated by this response only. ' + tip;
          refs().assistantEl.appendChild(metaEl);
        }
        scrollToBottom();
      }
      await persistSession(sessionMessages, sid);
      updateBudget();
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      if (aborted) {
        // User pressed Stop: freeze whatever partial response arrived.
        if (full || st.reasoning) {
          sessionMessages.push({
            role: 'assistant',
            content: full,
            ...(st.reasoning ? { reasoning: st.reasoning.trim() } : {}),
            meta: genMetaText(reqUsage, reqTimings),
          });
          if (viewingNow()) {
            pushReasoning(st.reasoning);
            refs().contentEl.innerHTML = marked.parse(full);
            attachCopyButtons(refs().contentEl);
            const note = document.createElement('div');
            note.className = 'stop-note';
            note.textContent = '⏹ Generation stopped — partial response kept.';
            messagesEl.appendChild(note);
            scrollToBottom();
          }
        } else if (viewingNow()) {
          // Stopped before any content arrived — drop the typing placeholder
          // but keep the user's message. Reset the assistant slot cleanly.
          refs().assistantEl.remove();
        }
        await persistSession(sessionMessages, sid);
        updateBudget();
      } else {
        if (viewingNow()) {
          refs().contentEl.innerHTML =
            `<div class="text-red-500 dark:text-red-400 font-medium">⚠️ ${escapeHtml(err.message)}</div>` +
            `<div class="text-sm mt-1 text-gray-500 dark:text-gray-400">This request was retried automatically. If it keeps failing, the active model endpoint may be unavailable — check the Models panel or the llama.cpp server.</div>`;
          scrollToBottom();
        }
      }
    } finally {
      if (state.abortController === ac) state.abortController = null;
      stream.done = true;
      delete state.activeStreams[sid];
      renderSessionList(); // pulse off for this session
      if (sid === state.currentId) stopGenTimer();
      syncStreamingUI();
      refreshModelStatus(); // badge returns to the real lifecycle state
    }
  }

  function stopGeneration() {
    // Stop targets the ACTIVE VIEW's stream (per-session registry); a
    // stream running for another session keeps going in the background.
    const s = state.activeStreams[state.currentId];
    if (s && !s.done) s.abort.abort();
    else if (state.abortController) state.abortController.abort();
  }

  const SEND_ICON = `<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M13 5l7 7-7 7" />
    </svg>`;
  const STOP_ICON = `<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </svg>`;

  function setStreamingUI(on) {
    state.streaming = on;
    if (on) {
      sendBtn.title = 'Stop (interrupt generation)';
      sendBtn.innerHTML = STOP_ICON;
      sendBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700', 'disabled:opacity-40', 'disabled:cursor-not-allowed');
      sendBtn.classList.add('bg-red-600', 'hover:bg-red-700', 'stop-active');
    } else {
      sendBtn.title = 'Send (Enter)';
      sendBtn.innerHTML = SEND_ICON;
      sendBtn.classList.remove('bg-red-600', 'hover:bg-red-700', 'stop-active');
      sendBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
      sendBtn.disabled = false;
    }
  }

  // ------------------------------------------------------------- health
  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      const up = data.llama?.up;
      if (up) {
        statusDot.className = 'w-2 h-2 rounded-full bg-emerald-500';
        statusText.textContent = 'llama.cpp connected';
      } else {
        statusDot.className = 'w-2 h-2 rounded-full bg-red-500';
        statusText.textContent = 'llama.cpp offline';
      }
      // Update the true context window reported by the model server
      if (data.contextWindow && Number.isFinite(data.contextWindow)) {
        state.context.window = data.contextWindow;
        maxTokensInput.max = data.contextWindow;
        if (state.settings.max_tokens > data.contextWindow) {
          state.settings.max_tokens = data.contextWindow;
          maxTokensInput.value = data.contextWindow;
        }
      }
      updateBudget();
    } catch {
      statusDot.className = 'w-2 h-2 rounded-full bg-red-500';
      statusText.textContent = 'server unreachable';
    }
  }

  // ----------------------------------------- model lifecycle status badge
  // Header badge + dropdown driven by GET /api/models/status. Lifecycle
  // states: ready (green), loading (amber spinner: warm-up or prompt
  // prefill / cold start), unloaded (gray: weights not in memory),
  // error (red). Polled alongside checkHealth and refreshed after sends,
  // warm-ups and ejects.
  state.modelStatus = null; // last active-model status entry
  state.modelOp = null;     // 'warmup' | 'eject' while an op is in flight

  function badgeSpec(s) {
    if (!s) return { dot: 'bg-gray-400', label: 'checking…', spinner: false, pulse: false };
    if (s.lifecycle === 'loading') {
      return { dot: 'bg-amber-400', label: `loading${s.phase ? ` · ${s.phase}` : ''}`, spinner: true, pulse: false };
    }
    if (s.lifecycle === 'ready') {
      return { dot: 'bg-emerald-500', label: s.busy ? 'generating…' : 'ready', spinner: false, pulse: s.busy };
    }
    if (s.lifecycle === 'unloaded') {
      return { dot: 'bg-gray-400', label: s.online ? 'unloaded' : 'offline', spinner: false, pulse: false };
    }
    if (s.lifecycle === 'error') {
      return { dot: 'bg-red-500', label: 'error', spinner: false, pulse: false };
    }
    return { dot: 'bg-gray-400', label: 'idle', spinner: false, pulse: false };
  }

  function shortModelName(s) {
    const full = (s && s.name) || (s && s.id) || '';
    const parts = full.split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).join(' ') || full;
  }

  function memoryLine(s) {
    if (!s || !s.memory) return s && s.provider === 'local' ? 'memory footprint unknown' : '';
    const parts = [];
    if (Number.isFinite(s.memory.modelMiB) && s.memory.modelMiB > 0) parts.push(`≈ ${s.memory.modelMiB} MiB weights`);
    if (Number.isFinite(s.memory.ctxTokens) && s.memory.ctxTokens > 0) parts.push(`ctx ${Math.round(s.memory.ctxTokens).toLocaleString()} tokens`);
    if (Number.isFinite(s.memory.lastPromptTokens) && s.memory.lastPromptTokens > 0) parts.push(`last prompt ${Math.round(s.memory.lastPromptTokens).toLocaleString()} tokens`);
    if (Number.isFinite(s.memory.slots) && s.memory.slots > 0) parts.push(`${s.memory.slots} slot${s.memory.slots === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }

  function fmtSince(iso) {
    if (!iso) return '';
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    return s < 5 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
  }

  function renderModelStatus(s) {
    state.modelStatus = s;
    const spec = badgeSpec(s);
    // Dot → animated spinner while loading (cold start / warm-up).
    statusDot.className = spec.spinner
      ? 'status-spinner'
      : `w-2 h-2 rounded-full ${spec.dot}${spec.pulse ? ' status-pulse' : ''}`;
    statusText.textContent = s ? `${shortModelName(s)} · ${spec.label}` : 'checking…';
    const mem = memoryLine(s);
    statusPill.title = s
      ? `${s.name} — ${spec.label}${(s.detail ? ' · ' + s.detail : '')}${mem ? ' · ' + mem : ''}`
      : 'Model lifecycle status — click for warm-up / eject';
  }

  function renderModelMenu(s) {
    state.modelStatus = s;
    if (!s) {
      msmName.textContent = '—';
      msmPhase.textContent = '';
      msmDetail.textContent = 'No active model.';
      msmMemory.textContent = '';
      msmWarmupBtn.disabled = msmEjectBtn.disabled = true;
      return;
    }
    const spec = badgeSpec(s);
    msmDot.className = spec.spinner
      ? 'status-spinner'
      : `w-2.5 h-2.5 rounded-full ${spec.dot}${spec.pulse ? ' status-pulse' : ''}`;
    msmName.textContent = s.name;
    msmPhase.textContent = spec.label;
    msmDetail.textContent = [
      s.detail,
      s.serverModel ? `loaded: ${s.serverModel}` : '',
      s.since ? `updated ${fmtSince(s.since)}` : '',
    ].filter(Boolean).join(' · ');
    msmMemory.textContent = s.provider === 'local' ? memoryLine(s) : 'remote endpoint — memory managed provider-side';
    const remote = s.provider !== 'local';
    const busyOp = !!state.modelOp;
    msmWarmupBtn.disabled = busyOp || remote || s.lifecycle === 'loading';
    msmWarmupBtn.textContent = state.modelOp === 'warmup' ? 'Warming…' : 'Warm-up';
    msmWarmupBtn.title = remote
      ? 'Remote endpoints have no local weights to pre-load'
      : s.lifecycle === 'loading'
        ? 'A load is already in progress'
        : 'Pre-load the model so the first prompt is instant';
    msmEjectBtn.disabled = busyOp || remote || s.lifecycle === 'loading' || s.lifecycle === 'unloaded';
    msmEjectBtn.textContent = state.modelOp === 'eject' ? 'Ejecting…' : 'Eject';
    msmEjectBtn.title = remote
      ? 'Remote endpoints have no local weights to free'
      : s.lifecycle === 'unloaded'
        ? (s.online ? 'No model is loaded in memory' : 'Server not reachable — nothing loaded')
        : 'Free the model weights from memory';
  }

  async function refreshModelStatus() {
    try {
      const res = await fetch('/api/models/status');
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'could not load model status');
      const list = data.models || [];
      const active = list.find((m) => m.id === data.active) || list[0] || null;
      renderModelStatus(active);
      renderModelMenu(active);
    } catch {
      statusDot.className = 'w-2 h-2 rounded-full bg-red-500';
      statusText.textContent = 'server unreachable';
      if (!state.modelStatus) msmName.textContent = '—';
    }
  }

  function setModelMenu(open) {
    modelStatusMenu.classList.toggle('hidden', !open);
  }

  function appToast(msg, { error = false } = {}) {
    let toast = document.getElementById('skillToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'skillToast';
      toast.className = 'skill-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = (error ? '⚠️ ' : '✓ ') + msg;
    toast.classList.add('show');
    clearTimeout(appToast._t);
    appToast._t = setTimeout(() => toast.classList.remove('show'), 4000);
  }

  async function runModelOp(kind) {
    const s = state.modelStatus;
    if (!s || state.modelOp) return;
    const url = kind === 'warmup' ? '/api/models/warmup' : '/api/models/eject';
    state.modelOp = kind;
    renderModelMenu(s);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `${kind} failed`);
      if (kind === 'warmup') {
        if (data.already) appToast('Warm-up already in progress.');
        else appToast(`${data.detail || 'model warm'} — first prompt will be instant.`);
      } else {
        if (data.unloaded) appToast('Model ejected — weights freed from memory.');
        else if (data.degraded) appToast(`${data.detail}`, { error: true });
        else appToast('Eject complete.');
      }
    } catch (err) {
      appToast(err.message, { error: true });
    } finally {
      state.modelOp = null;
      renderModelMenu(state.modelStatus);
      refreshModelStatus();
    }
  }

  statusPill.addEventListener('click', (e) => {
    e.stopPropagation();
    setModelMenu(modelStatusMenu.classList.contains('hidden'));
  });
  modelStatusMenu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => setModelMenu(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setModelMenu(false); });
  msmWarmupBtn.addEventListener('click', () => runModelOp('warmup'));
  msmEjectBtn.addEventListener('click', () => runModelOp('eject'));
  msmManageBtn.addEventListener('click', () => {
    setModelMenu(false);
    showView('models');
    closeSidebar();
  });

  // ------------------------------------------- system resource monitor
  // Header RAM + CPU rings driven by GET /api/system/metrics (os-module
  // host stats, 5s poll). Rings sweep smoothly via CSS stroke-dashoffset
  // transition; tooltips carry the raw numbers (GB used, cores, loadavg).
  const RING_C = 97.39; // circumference of the 36-viewBox r=15.5 rings
  const RAM_BASE = ['text-blue-500', 'dark:text-blue-400'];
  const RAM_WARN = ['text-amber-500', 'dark:text-amber-400'];
  const RAM_CRIT = ['text-red-500', 'dark:text-red-400'];
  const CPU_BASE = ['text-violet-500', 'dark:text-violet-400'];
  const CPU_WARN = ['text-amber-500', 'dark:text-amber-400'];
  const CPU_CRIT = ['text-red-500', 'dark:text-red-400'];

  function ringOffset(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return Math.round(RING_C * (1 - p / 100) * 100) / 100;
  }

  // Apply a callback to every element of a NodeList (metrics pills exist in
  // both the header and the mobile compose toolbar).
  function forEachEl(list, fn) {
    if (list) list.forEach(fn);
  }

  function applyRingColor(ring, pct, base, warn, crit) {
    const p = Number(pct) || 0;
    const chosen = p >= 95 ? crit : p >= 85 ? warn : base;
    for (const set of [base, warn, crit]) {
      for (const cls of set) ring.classList.remove(cls);
    }
    ring.classList.add(...chosen);
  }

  async function refreshSysMetrics() {
    try {
      const res = await fetch('/api/system/metrics');
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.error || 'could not load system metrics');
      const ram = d.ram || {};
      const cpu = d.cpu || {};
      const ramP = Math.round(Number(ram.percent) || 0);
      const cpuP = Math.round(Number(cpu.percent) || 0);
      forEachEl(ramPcts, (el) => { el.textContent = `${ramP}%`; });
      forEachEl(cpuPcts, (el) => { el.textContent = `${cpuP}%`; });
      forEachEl(ramRings, (el) => {
        el.style.strokeDashoffset = ringOffset(ramP);
        applyRingColor(el, ramP, RAM_BASE, RAM_WARN, RAM_CRIT);
      });
      forEachEl(cpuRings, (el) => {
        el.style.strokeDashoffset = ringOffset(cpuP);
        applyRingColor(el, cpuP, CPU_BASE, CPU_WARN, CPU_CRIT);
      });
      const gb = (b) => (Number(b) / 1073741824).toFixed(1);
      let ramTitle = `RAM ${gb(ram.usedBytes)} / ${gb(ram.totalBytes)} GB used (${ramP}%)`;
      if (ram.scope === 'container') ramTitle += ` · container (cgroup ${ram.cgroup || '?'}${ram.limitSet ? '' : ', no limit'})`;
      if (Number.isFinite(ram.buffCacheBytes) && ram.buffCacheBytes > 0) {
        ramTitle += ` · cache ${gb(ram.buffCacheBytes)} GB`;
        if (Number.isFinite(ram.percentAvail)) ramTitle += ` · w/o cache ${Math.round(ram.percentAvail)}%`;
      }
      forEachEl(ramPills, (el) => { el.title = ramTitle; });
      let cpuTitle = `CPU ${cpuP}% on ${Number(cpu.cores) || '?'} cores`;
      if (cpu.quotaCores) cpuTitle += ` (quota ${Number(cpu.quotaCores)})`;
      if (cpu.scope === 'container') cpuTitle += ` · container (cgroup ${cpu.cgroup || '?'})`;
      if (cpu.estimate) cpuTitle += ' (estimate)';
      if (Array.isArray(cpu.loadavg)) {
        cpuTitle += ` · load ${cpu.loadavg.map((n) => Number(n).toFixed(2)).join(' / ')}`;
      }
      if (Number.isFinite(Number(d.uptimeSec))) {
        const up = Math.max(0, Math.round(Number(d.uptimeSec) / 60));
        cpuTitle += ` · up ${up >= 60 ? `${Math.floor(up / 60)}h ${up % 60}m` : `${up}m`}`;
      }
      forEachEl(cpuPills, (el) => { el.title = cpuTitle; });
    } catch {
      forEachEl(ramPcts, (el) => { el.textContent = '—'; });
      forEachEl(cpuPcts, (el) => { el.textContent = '—'; });
      forEachEl(ramRings, (el) => { el.style.strokeDashoffset = RING_C; });
      forEachEl(cpuRings, (el) => { el.style.strokeDashoffset = RING_C; });
      forEachEl(ramPills, (el) => { el.title = 'system metrics unavailable'; });
      forEachEl(cpuPills, (el) => { el.title = 'system metrics unavailable'; });
    }
  }

  // ------------------------------------------------------------- automations view
  const AUTO_ICON = `<svg class="fs-ic" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 7v5l3 2" /></svg>`;

  const openLogs = new Set(); // automation ids with the log block expanded

  async function loadAutomations() {
    automationsListEl.innerHTML = '<div class="fe-muted">Loading automations…</div>';
    let data;
    try {
      const res = await fetch('/api/automations');
      data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load automations');
    } catch (err) {
      automationsListEl.innerHTML = `<div class="fe-muted fs-error">⚠️ ${escapeHtml(err.message)}</div>`;
      return;
    }
    autoPaused = data.paused === true;
    renderAutomations(data.automations);
    applyAutoPauseUI();
  }

  // Global scheduler pause: one switch stops EVERY scheduled run (manual
  // "Run now" still works). Per-item switches are inert while paused.
  let autoPaused = false;
  function applyAutoPauseUI() {
    automationsListEl.classList.toggle('auto-list-paused', autoPaused);
    if (!autoPauseToggle) return;
    autoPauseToggle.checked = autoPaused;
    for (const input of automationsListEl.querySelectorAll('[data-auto-toggle]')) {
      input.disabled = autoPaused;
    }
    if (autoPauseHint) {
      autoPauseHint.textContent = autoPaused
        ? 'All automations are paused — the scheduler is stopped. Manual "Run now" still works; toggle this off to resume the schedule.'
        : 'Stops the scheduler — nothing runs on schedule. Manual "Run now" still works; per-item switches take effect again once unpaused.';
    }
  }
  if (autoPauseToggle) {
    autoPauseToggle.addEventListener('change', async (e) => {
      const paused = e.target.checked;
      try {
        const res = await fetch('/api/automations/pause', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Could not update automation pause state');
        autoPaused = data.paused === true;
        loadAutomations();
      } catch (err) {
        e.target.checked = !paused; // revert
        autoToast(err.message);
      }
    });
  }

  function fmtWhen(iso, { prefix = false } = {}) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    const diff = t - Date.now();
    const abs = Math.abs(diff);
    let rel;
    if (abs < 60000) rel = 'just now';
    else if (abs < 3600000) rel = `${Math.round(abs / 60000)} min`;
    else if (abs < 86400000) rel = `${Math.round(abs / 3600000)} h`;
    else rel = new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (prefix) return diff >= 0 ? `in ${rel}` : `${rel} ago`;
    return rel;
  }

  function scheduleLabel(s) {
    if (!s) return '—';
    if (s.type === 'interval') return `every ${Number(s.intervalMinutes) || 1} min`;
    return `cron ${escapeHtml(s.cron || '')}`;
  }

  function renderAutomations(list) {
    automationsListEl.innerHTML = '';
    if (!list.length) {
      automationsListEl.innerHTML =
        '<div class="fe-muted">No automations yet. Click "New automation" to schedule a script, skill, or LLM task.</div>';
      return;
    }
    for (const a of list) {
      const card = document.createElement('div');
      card.className = 'auto-card' + (a.enabled === false ? ' disabled' : '');
      card.setAttribute('data-auto', a.id);
      const act = a.action || {};
      const actLabel =
        act.type === 'script' ? `script · ${escapeHtml(act.script || '')}` :
        act.type === 'skill' ? `skill · ${escapeHtml(act.skill || '')}` :
        act.type === 'prompt' ? 'LLM prompt task' : 'unknown action';
      const statusBadge =
        a.lastStatus === 'success' ? '<span class="auto-status ok">success</span>' :
        a.lastStatus === 'error' ? '<span class="auto-status err">error</span>' : '<span class="auto-status">never run</span>';

      card.innerHTML = `
        <div class="auto-row">
          <span class="auto-ic">${AUTO_ICON}</span>
          <div class="model-main">
            <div class="model-name">
              ${escapeHtml(a.name)}
              <span class="auto-badge ${a.enabled === false ? 'off' : 'on'}">${a.enabled === false ? 'paused' : 'active'}</span>
            </div>
            <div class="model-desc">${escapeHtml(a.description || actLabel)}</div>
            <div class="model-grid">
              <div class="model-cell">
                <span class="model-cell-label">schedule</span>
                <span class="model-cell-value">${scheduleLabel(a.schedule)}</span>
              </div>
              <div class="model-cell">
                <span class="model-cell-label">action</span>
                <span class="model-cell-value" title="${escapeHtml(actLabel)}">${actLabel}</span>
              </div>
              <div class="model-cell">
                <span class="model-cell-label">next run</span>
                <span class="model-cell-value">${a.enabled === false ? 'paused' : (a.nextRunAt ? 'in ' + fmtWhen(a.nextRunAt) : '—')}</span>
              </div>
              <div class="model-cell">
                <span class="model-cell-label">last run</span>
                <span class="model-cell-value">${fmtWhen(a.lastRunAt)} ${statusBadge}</span>
              </div>
            </div>
            ${a.lastSummary ? `<div class="auto-summary" title="${escapeHtml(a.lastSummary)}">${escapeHtml(a.lastSummary)}</div>` : ''}
            <div class="auto-logs${openLogs.has(a.id) ? '' : ' hidden'}" data-logs>
              ${renderAutoLogs(a.logs)}
            </div>
          </div>
          <div class="auto-actions">
            <button class="auto-run" data-run="${escapeHtml(a.id)}" title="Run now">▶ Run now</button>
            <button class="auto-edit" data-edit="${escapeHtml(a.id)}" title="Edit ${escapeHtml(a.name)}">Edit</button>
            <span class="auto-del-wrap">
              <button class="auto-del" data-del="${escapeHtml(a.id)}" title="Delete ${escapeHtml(a.name)}">${TRASH_ICON}</button>
              <span class="auto-confirm hidden" data-confirm>
                <button class="skill-danger" data-confirm-del="${escapeHtml(a.id)}">Delete</button>
                <button class="skill-cancel" data-cancel-del>Cancel</button>
              </span>
            </span>
            <label class="switch" title="${a.enabled === false ? 'Enable' : 'Pause'} ${escapeHtml(a.name)}">
              <input type="checkbox" data-auto-toggle="${escapeHtml(a.id)}" ${a.enabled === false ? '' : 'checked'} />
              <span class="slider"></span>
            </label>
            <button class="auto-logs-toggle${openLogs.has(a.id) ? ' open' : ''}" data-logs-toggle="${escapeHtml(a.id)}"
              title="Execution log">log${a.logs.length ? ` (${a.logs.length})` : ''}</button>
          </div>
        </div>`;

      card.querySelector('[data-auto-toggle]').addEventListener('change', (e) =>
        setAutoEnabled(a.id, e.target.checked, card));
      card.querySelector('[data-run]').addEventListener('click', () => runAutomation(a.id));
      card.querySelector('[data-edit]').addEventListener('click', () => openAutoModal(a.id));
      card.querySelector('[data-logs-toggle]').addEventListener('click', () => {
        const block = card.querySelector('[data-logs]');
        block.classList.toggle('hidden');
        card.querySelector('[data-logs-toggle]').classList.toggle('open', !block.classList.contains('hidden'));
        if (block.classList.contains('hidden')) openLogs.delete(a.id);
        else openLogs.add(a.id);
      });
      const delBtn = card.querySelector('[data-del]');
      const confirmEl = card.querySelector('[data-confirm]');
      delBtn.addEventListener('click', () => {
        const show = confirmEl.classList.contains('hidden');
        confirmEl.classList.toggle('hidden', !show);
      });
      card.querySelector('[data-cancel-del]').addEventListener('click', () => confirmEl.classList.add('hidden'));
      card.querySelector('[data-confirm-del]').addEventListener('click', () => deleteAutomation(a.id, card));
      automationsListEl.appendChild(card);
    }
  }

  function renderAutoLogs(logs) {
    if (!logs || !logs.length) return '<div class="auto-log-empty">No runs recorded yet — trigger one with Run now.</div>';
    return logs
      .map(
        (l) =>
          `<div class="auto-log-line ${l.status === 'success' ? 'ok' : 'err'}">
            <span class="auto-log-time">${fmtWhen(l.at)}</span>
            <span class="auto-log-status">${l.status === 'success' ? '✓' : '✗'}</span>
            <span class="auto-log-summary">${escapeHtml(l.summary || '')}</span>
            ${l.detail ? `<span class="auto-log-detail">${escapeHtml(l.detail)}</span>` : ''}
          </div>`
      )
      .join('');
  }

  async function setAutoEnabled(id, enabled, card) {
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(id)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not update automation');
      loadAutomations();
    } catch (err) {
      const input = card.querySelector('[data-auto-toggle]');
      input.checked = !enabled; // revert optimistic toggle
      autoToast(err.message);
    }
  }

  async function runAutomation(id) {
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(id)}/run`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not start run');
      autoToast('▶ Run started — result lands in the log.');
      loadAutomations();
    } catch (err) {
      autoToast(err.message);
    }
  }

  async function deleteAutomation(id, card) {
    card.classList.add('deleting');
    try {
      const res = await fetch(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not delete automation');
      openLogs.delete(id);
      card.remove();
    } catch (err) {
      card.classList.remove('deleting');
      autoToast(err.message);
    }
  }

  function autoToast(msg) {
    let toast = document.getElementById('skillToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'skillToast';
      toast.className = 'skill-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = '⚠️ ' + msg;
    toast.classList.add('show');
    clearTimeout(autoToast._t);
    autoToast._t = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  // ------------------------------------------------------- automation editor modal
  function syncAutoModalFields() {
    const sched = autoScheduleType.value;
    document.querySelectorAll('#automationForm [data-sched]').forEach((el) =>
      el.classList.toggle('hidden', el.dataset.sched !== sched));
    const act = autoActionType.value;
    document.querySelectorAll('#automationForm [data-act]').forEach((el) =>
      el.classList.toggle('hidden', el.dataset.act !== act));
    document.querySelectorAll('#automationForm [data-args]').forEach((el) =>
      el.classList.toggle('hidden', !(act === 'script' || act === 'skill')));
  }

  function loadSkillOptions(preselect) {
    return fetch('/api/skills')
      .then((r) => r.json())
      .then((data) => {
        autoSkill.innerHTML = '';
        const skills = Array.isArray(data.skills) ? data.skills : [];
        if (!skills.length) {
          autoSkill.innerHTML =
            '<option value="">No skills installed — use a script or prompt task instead</option>';
          return;
        }
        for (const s of skills) {
          const opt = document.createElement('option');
          opt.value = s.name;
          opt.textContent = s.name + (s.description ? ` — ${s.description}` : '');
          autoSkill.appendChild(opt);
        }
        if (preselect && [...autoSkill.options].some((o) => o.value === preselect)) {
          autoSkill.value = preselect;
        }
        autoActionType.value = skills.length ? autoActionType.value : 'script';
        syncAutoModalFields();
      })
      .catch(() => { /* options stay empty; submit will surface the error */ });
  }

  function resetAutoForm() {
    autoForm.reset();
    autoFormError.classList.add('hidden');
    autoIntervalMin.value = '30';
    autoMaxTokens.value = '512';
  }

  function openAutoModal(id) {
    resetAutoForm();
    loadSkillOptions();
    if (id) {
      fetch(`/api/automations/${encodeURIComponent(id)}`)
        .then((r) => r.json())
        .then((data) => {
          if (!data.ok) throw new Error(data.error || 'Could not load automation');
          const a = data.automation;
          autoModalTitle.textContent = 'Edit automation';
          autoId.value = a.id;
          autoName.value = a.name;
          autoDesc.value = a.description || '';
          autoScheduleType.value = a.schedule?.type === 'cron' ? 'cron' : 'interval';
          if (a.schedule?.type === 'cron') autoCron.value = a.schedule.cron || '';
          else autoIntervalMin.value = a.schedule?.intervalMinutes || 30;
          const act = a.action || {};
          autoActionType.value = act.type || 'script';
          autoScript.value = act.script || '';
          autoMaxTokens.value = act.maxTokens || 512;
          syncAutoModalFields();
          loadSkillOptions(act.type === 'skill' ? act.skill : null);
        })
        .catch((err) => { autoToast(err.message); return; });
    } else {
      autoModalTitle.textContent = 'New automation';
      autoId.value = '';
      autoName.value = '';
    }
    syncAutoModalFields();
    autoModalEl.classList.remove('hidden');
    autoName.focus();
  }

  function closeAutoModal() {
    autoModalEl.classList.add('hidden');
  }

  autoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    autoFormError.classList.add('hidden');
    const isEdit = !!autoId.value;
    const actType = autoActionType.value;
    const args = autoArgs.value.trim() ? autoArgs.value.trim().split(/\s+/) : [];
    const body = {
      name: autoName.value.trim(),
      description: autoDesc.value.trim(),
      schedule:
        autoScheduleType.value === 'cron'
          ? { type: 'cron', cron: autoCron.value.trim() }
          : { type: 'interval', intervalMinutes: parseInt(autoIntervalMin.value, 10) || 30 },
    };
    if (actType === 'script') body.action = { type: 'script', script: autoScript.value.trim(), args };
    else if (actType === 'skill') body.action = { type: 'skill', skill: autoSkill.value, args };
    else body.action = { type: 'prompt', prompt: autoPrompt.value.trim(), maxTokens: parseInt(autoMaxTokens.value, 10) || 512 };

    const url = isEdit ? `/api/automations/${encodeURIComponent(autoId.value)}` : '/api/automations';
    const method = isEdit ? 'PUT' : 'POST';
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error || (data.errors ? data.errors.join('; ') : 'Could not save automation');
        throw new Error(msg);
      }
      closeAutoModal();
      loadAutomations();
    } catch (err) {
      autoFormError.textContent = '⚠️ ' + err.message;
      autoFormError.classList.remove('hidden');
    }
  });

  automationsBtn.addEventListener('click', () => { showView('automations'); closeSidebar(); });
  automationsBackChat.addEventListener('click', () => showView('chat'));
  automationsRefresh.addEventListener('click', () => loadAutomations());
  automationsAddBtn.addEventListener('click', () => openAutoModal(null));
  autoScheduleType.addEventListener('change', syncAutoModalFields);
  autoActionType.addEventListener('change', syncAutoModalFields);
  $('#automationModalClose').addEventListener('click', closeAutoModal);
  $('#automationFormCancel').addEventListener('click', closeAutoModal);
  autoModalEl.addEventListener('click', (e) => { if (e.target === autoModalEl) closeAutoModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !autoModalEl.classList.contains('hidden')) closeAutoModal();
  });

  // ------------------------------------------------------------- library view
  const MAX_UPLOAD_BYTES = 50 * 1048576; // mirror of LIBRARY_MAX_UPLOAD_MB (server default)

  function fileIcon(f) {
    const mime = String((f && f.mime) || '');
    const name = String((f && f.name) || '').toLowerCase();
    if (mime.startsWith('image/')) return '🖼';
    if (mime.startsWith('audio/')) return '🎵';
    if (mime.startsWith('video/')) return '🎬';
    if (mime === 'application/pdf' || name.endsWith('.pdf')) return '📕';
    if (/(zip|gzip|tar|x-tar|rar|7z)/.test(mime)) return '📦';
    if (/(json|javascript|python|yaml|sql|xml|text)/.test(mime)) return '📄';
    return '📄';
  }

  async function loadLibrary() {
    libraryListEl.innerHTML = '<div class="fe-muted">Loading library…</div>';
    let data;
    try {
      const res = await fetch('/api/library');
      data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load library');
    } catch (err) {
      libraryListEl.innerHTML = `<div class="fe-muted fs-error">⚠️ ${escapeHtml(err.message)}</div>`;
      return;
    }
    renderLibrary(data.files);
  }

  function renderLibrary(files) {
    libraryListEl.innerHTML = '';
    if (!files.length) {
      libraryListEl.innerHTML =
        '<div class="fe-muted">Library is empty. Click "Upload" to add documents, code, or assets — then attach them to chats with the paperclip.</div>';
      return;
    }
    for (const f of files) {
      const tile = document.createElement('div');
      tile.className = 'lib-tile';
      tile.setAttribute('data-lib', f.id);
      tile.innerHTML = `
        <div class="lib-tile-top">
          <span class="lib-tile-icon" title="${escapeHtml(f.mime)}">${fileIcon(f)}</span>
        </div>
        <div class="lib-tile-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        ${f.description ? `<div class="lib-tile-desc" title="${escapeHtml(f.description)}">${escapeHtml(f.description)}</div>` : ''}
        <div class="lib-tile-meta">
          <span class="lib-tile-type">${escapeHtml((f.mime || 'file').split('/').pop() || 'file')}</span>
          <span class="lib-tile-size">${formatBytes(f.size)}</span>
        </div>
        <div class="lib-tile-actions">
          <button class="lib-view" data-view="${escapeHtml(f.id)}" title="Preview ${escapeHtml(f.name)}">View</button>
          <button class="lib-attach" data-attach="${escapeHtml(f.id)}" title="Attach to next chat message">Attach</button>
          <a class="lib-dl" href="/api/library/${encodeURIComponent(f.id)}/content" download="${escapeHtml(f.name)}" title="Download ${escapeHtml(f.name)}" aria-label="Download ${escapeHtml(f.name)}">⬇</a>
          <span class="auto-del-wrap">
            <button class="auto-del lib-del" data-del="${escapeHtml(f.id)}" title="Delete ${escapeHtml(f.name)}">${TRASH_ICON}</button>
            <span class="auto-confirm hidden" data-confirm>
              <button class="skill-danger" data-confirm-del="${escapeHtml(f.id)}">Delete</button>
              <button class="skill-cancel" data-cancel-del>Cancel</button>
            </span>
          </span>
        </div>`;
      tile.querySelector('[data-view]').addEventListener('click', () => openLibView(f));
      tile.querySelector('[data-attach]').addEventListener('click', () => attachFile(f));
      const delBtn = tile.querySelector('[data-del]');
      const confirmEl = tile.querySelector('[data-confirm]');
      // Confirm state is driven by a `confirming` class on the tile: the CSS
      // hides the regular action buttons and lets the confirm row take over
      // the action bar (no absolute positioning, nothing to collide with).
      const setConfirming = (on) => {
        confirmEl.classList.toggle('hidden', !on);
        tile.classList.toggle('confirming', on);
        delBtn.classList.toggle('danger', on);
      };
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setConfirming(confirmEl.classList.contains('hidden'));
      });
      tile.querySelector('[data-cancel-del]').addEventListener('click', (e) => {
        e.stopPropagation();
        setConfirming(false);
      });
      tile.querySelector('[data-confirm-del]').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteLibraryFile(f.id, tile);
      });
      libraryListEl.appendChild(tile);
    }
  }

  async function deleteLibraryFile(id, card) {
    card.classList.add('deleting');
    try {
      const res = await fetch(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not delete file');
      removeAttachment(id);
      card.remove();
    } catch (err) {
      card.classList.remove('deleting');
      libraryToast(err.message);
    }
  }

  async function openLibView(f) {
    libViewTitle.textContent = f.name;
    libViewMeta.textContent = `${formatBytes(f.size)} · ${f.mime} · added ${new Date(f.updatedAt).toLocaleString()}`;
    libViewDownload.href = `/api/library/${encodeURIComponent(f.id)}/content`;
    libViewDownload.setAttribute('download', f.name);
    libViewBody.innerHTML = '<div class="fe-muted">Loading…</div>';
    libViewModalEl.classList.remove('hidden');

    const mime = String(f.mime || '');
    const url = `/api/library/${encodeURIComponent(f.id)}/content`;
    try {
      if (mime.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = url;
        img.className = 'lib-preview-img';
        img.alt = f.name;
        libViewBody.innerHTML = '';
        libViewBody.appendChild(img);
        return;
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error('Could not load file content');
      const text = await res.text();
      const pre = document.createElement('pre');
      pre.className = 'fe-fileview';
      const code = document.createElement('code');
      code.textContent = text;
      if (typeof hljs !== 'undefined') { try { hljs.highlightElement(code); } catch { /* plain */ } }
      pre.appendChild(code);
      libViewBody.innerHTML = '';
      libViewBody.appendChild(pre);
    } catch (err) {
      libViewBody.innerHTML = `<div class="fe-muted fs-error">⚠️ ${escapeHtml(err.message)} — use Download instead.</div>`;
    }
  }

  function closeLibViewModal() {
    libViewModalEl.classList.add('hidden');
    libViewBody.innerHTML = '';
  }

  // Upload File objects to the Library. attach=true also queues them for chat.
  async function uploadLibraryFiles(fileList, { attach = false } = {}) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const ok = [];
    const errors = [];
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        errors.push(`${file.name} (over 50 MB limit)`);
        continue;
      }
      try {
        const res = await fetch('/api/library/upload?name=' + encodeURIComponent(file.name), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-File-Type': file.type || '' },
          body: file,
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        ok.push(data.file);
      } catch (err) {
        errors.push(`${file.name}: ${err.message}`);
      }
    }
    if (ok.length) {
      if (attach) {
        for (const f of ok) attachFile(f, { silent: true });
      }
      if (state.view === 'library') loadLibrary();
      libraryToast(ok.length + ' file(s) uploaded to the Library.');
    }
    if (errors.length) libraryToast('Some uploads failed: ' + errors.join('; '));
    return ok;
  }

  // ------------------------------------------------------- chat attachments
  function hasAttachment(id) {
    return state.attachments.some((a) => a.id === id);
  }

  function attachFile(f, { silent = false } = {}) {
    if (!f || !f.id) return;
    if (hasAttachment(f.id)) {
      if (!silent) libraryToast('Already attached.');
      return;
    }
    state.attachments.push({ id: f.id, name: f.name, size: f.size });
    renderChips();
    attachPopover.classList.add('hidden');
    if (!silent) {
      libraryToast(`Attached ${f.name} — it will be sent with your next message.`);
      if (state.view !== 'chat') showView('chat');
    }
  }

  function removeAttachment(id) {
    state.attachments = state.attachments.filter((a) => a.id !== id);
    renderChips();
  }

  function renderChips() {
    const list = state.attachments;
    attachChipsEl.classList.toggle('hidden', !list.length);
    attachChipsEl.innerHTML = '';
    for (const a of list) {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.title = `${a.name} · ${formatBytes(a.size)}`;
      chip.innerHTML = `📎 <span class="chip-name">${escapeHtml(a.name)}</span>`;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chip-x';
      x.textContent = '✕';
      x.title = 'Remove attachment';
      x.addEventListener('click', () => removeAttachment(a.id));
      chip.appendChild(x);
      attachChipsEl.appendChild(chip);
    }
  }

  // Paperclip popover — list library files, click to attach, or upload new.
  async function openAttachPopover() {
    attachListEl.innerHTML = '<div class="fe-muted">Loading library…</div>';
    try {
      const res = await fetch('/api/library');
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load library');
      const files = data.files || [];
      if (!files.length) {
        attachListEl.innerHTML =
          '<div class="fe-muted">Library is empty — use "Upload new…" to add a file.</div>';
        return;
      }
      attachListEl.innerHTML = '';
      for (const f of files) {
        const row = document.createElement('div');
        row.className = 'attach-row' + (hasAttachment(f.id) ? ' attached' : '');
        row.title = hasAttachment(f.id) ? 'Already attached' : `Attach ${f.name}`;
        row.innerHTML =
          `<span class="att-ic">${fileIcon(f)}</span>` +
          `<span class="att-name">${escapeHtml(f.name)}</span>` +
          `<span class="att-meta">${formatBytes(f.size)}${hasAttachment(f.id) ? ' · ✓' : ''}</span>`;
        if (!hasAttachment(f.id)) {
          row.addEventListener('click', () => attachFile(f));
        } else {
          row.addEventListener('click', () => { removeAttachment(f.id); renderAttachList(); });
        }
        attachListEl.appendChild(row);
      }
    } catch (err) {
      attachListEl.innerHTML = `<div class="fe-muted fs-error">⚠️ ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderAttachList() {
    if (!attachPopover.classList.contains('hidden')) openAttachPopover();
  }

  function libraryToast(msg) {
    let toast = document.getElementById('skillToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'skillToast';
      toast.className = 'skill-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = '⚠️ ' + msg;
    toast.classList.add('show');
    clearTimeout(libraryToast._t);
    libraryToast._t = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  // ------------------------------------------------------ library / attach wiring
  libraryBtn.addEventListener('click', () => { showView('library'); closeSidebar(); });
  libraryBackChat.addEventListener('click', () => showView('chat'));
  libraryRefresh.addEventListener('click', () => loadLibrary());
  libraryUploadBtn.addEventListener('click', () => libraryFileInput.click());
  libraryFileInput.addEventListener('change', () => {
    uploadLibraryFiles(libraryFileInput.files, { attach: false });
    libraryFileInput.value = '';
  });

  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = attachPopover.classList.contains('hidden');
    closePopovers();
    if (willOpen) {
      attachPopover.classList.remove('hidden');
      openAttachPopover();
    }
  });
  attachUploadBtn.addEventListener('click', () => attachFileInput.click());
  attachFileInput.addEventListener('change', () => {
    uploadLibraryFiles(attachFileInput.files, { attach: true });
    attachFileInput.value = '';
  });
  attachPopover.addEventListener('click', (e) => e.stopPropagation());
  $('#libViewClose').addEventListener('click', closeLibViewModal);
  $('#libViewCloseBtn').addEventListener('click', closeLibViewModal);
  libViewModalEl.addEventListener('click', (e) => { if (e.target === libViewModalEl) closeLibViewModal(); });

  // ------------------------------------------------------------- channels view
  async function loadChannels() {
    chanTestResult.textContent = '';
    try {
      const res = await fetch('/api/channels');
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load channels');
      renderChannels(data.channels || []);
    } catch (err) {
      chanMeta.innerHTML = `<div class="fe-muted fs-error">⚠️ ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderChannels(channels) {
    const tg = channels.find((c) => c && c.type === 'telegram');
    if (!tg) {
      channelsListEl.innerHTML = '<div class="fe-muted">No channels configured yet.</div>';
      return;
    }
    // status badge
    let badge = 'idle';
    let cls = 'off';
    if (!tg.tokenSet) badge = 'no token';
    else if (tg.enabled && tg.running) { badge = 'active'; cls = 'on'; }
    else if (tg.enabled) { badge = 'starting…'; cls = 'on'; }
    else badge = 'paused';
    chanStatusBadge.textContent = badge;
    chanStatusBadge.className = 'auto-badge ' + cls;

    chanToggle.checked = !!tg.enabled;
    chanToggle.disabled = false;
    chanIds.value = (tg.allowedChatIds || []).join(', ');

    const meta = [];
    meta.push(
      `Polling: ${tg.enabled ? 'on' : 'off'} · Bot running: ${tg.running ? 'yes' : 'no'} · Token: ${tg.tokenSet ? 'set (in .env)' : 'not set'}`
    );
    if (tg.activeModel) meta.push(`Active model: ${escapeHtml(tg.activeModel.name)} (${escapeHtml(tg.activeModel.id)})`);
    if (tg.adminChatId && tg.adminChatId.length) meta.push(`Admin chat id${tg.adminChatId.length > 1 ? 's' : ''} (always allowed): ${escapeHtml(tg.adminChatId.join(', '))}`);
    if (tg.lastActivityAt) meta.push(`Last activity: ${fmtWhen(tg.lastActivityAt)} ago`);
    if (tg.lastError) meta.push(`<span class="fs-error">Last error: ${escapeHtml(tg.lastError)}</span>`);
    chanMeta.innerHTML = meta.map((m) => `<div class="chan-meta-line">${m}</div>`).join('');
  }

  async function setChanEnabled(enabled) {
    chanToggle.disabled = true;
    try {
      const res = await fetch('/api/channels/telegram/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not update channel');
      loadChannels();
    } catch (err) {
      chanToggle.checked = !enabled; // revert optimistic toggle
      channelToast(err.message);
    } finally {
      chanToggle.disabled = false;
    }
  }

  async function saveChanIds() {
    const ids = chanIds.value.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = ids.filter((s) => !/^-?\d+$/.test(s));
    try {
      if (bad.length) throw new Error('invalid chat id(s): ' + bad.join(', '));
      const res = await fetch('/api/channels/telegram', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedChatIds: ids }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not save whitelist');
      channelToast('Whitelist saved.');
      loadChannels();
    } catch (err) {
      channelToast(err.message);
    }
  }

  async function saveChanToken() {
    const token = chanToken.value.trim();
    try {
      const res = await fetch('/api/channels/telegram/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not save token');
      chanToken.value = '';
      channelToast(token ? 'Token saved to .env.' : 'Token cleared from .env.');
      loadChannels();
    } catch (err) {
      channelToast(err.message);
    }
  }

  async function testChan() {
    chanTestResult.textContent = 'Testing…';
    chanTest.disabled = true;
    try {
      const res = await fetch('/api/channels/telegram/test', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        chanTestResult.textContent = `✓ Connected as @${data.bot.username || String(data.bot.id || '')} — ${data.bot.first_name || 'Telegram bot'}.`;
      } else {
        chanTestResult.textContent = `✗ ${data.error || 'connection failed'}`;
      }
    } catch (err) {
      chanTestResult.textContent = '✗ ' + err.message;
    } finally {
      chanTest.disabled = false;
    }
  }

  function channelToast(msg) {
    let toast = document.getElementById('skillToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'skillToast';
      toast.className = 'skill-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = '⚠️ ' + msg;
    toast.classList.add('show');
    clearTimeout(channelToast._t);
    channelToast._t = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  channelsBtn.addEventListener('click', () => { showView('channels'); closeSidebar(); });
  channelsBackChat.addEventListener('click', () => showView('chat'));
  channelsRefresh.addEventListener('click', () => loadChannels());
  chanToggle.addEventListener('change', () => setChanEnabled(chanToggle.checked));
  chanIdsSave.addEventListener('click', saveChanIds);
  chanTokenSave.addEventListener('click', saveChanToken);
  chanTest.addEventListener('click', testChan);

  // ------------------------------------------------------------- init
  $('#newChatBtn').addEventListener('click', newChat);

  (async function init() {
    await loadSessions();
    if (state.sessions.length) switchSession(state.sessions[0].id);
    else renderMessages();
    checkHealth();
    refreshModelStatus();
    refreshSysMetrics();
    setInterval(checkHealth, 15000);
    setInterval(refreshSysMetrics, 5000);
    // Keep the model lifecycle badge + the automations/channels lists fresh.
    setInterval(() => {
      refreshModelStatus();
      if (state.view === 'automations') loadAutomations();
      if (state.view === 'channels') loadChannels();
    }, 15000);
  })();
})();