/* plife — client-side application logic */
(() => {
  'use strict';

  // ------------------------------------------------------------------ state
  const state = {
    sessions: [],
    currentId: null,
    currentMessages: [],
    streaming: false,
    settings: { temperature: 0.7, top_p: 0.95, max_tokens: 2048 },
    context: { window: 8192, inputTokens: 0, outputTokens: 0, source: 'estimated' },
    lastUsage: null, // { sessionId, prompt_tokens, completion_tokens } from llama
    pendingDeleteId: null, // session awaiting inline delete confirmation
    abortController: null, // AbortController for the active stream
    view: 'chat', // 'chat' | 'files' — which panel is shown in the main area
    fsDir: '', // current directory in the File Explorer (workspace-relative; '' = root)
    attachments: [], // [{ id, name, size }] queued for the next chat message
  };

  // ------------------------------------------------------------- dom refs
  const $ = (sel) => document.querySelector(sel);
  const messagesEl = $('#messages');
  const emptyStateEl = $('#emptyState');
  const sessionListEl = $('#sessionList');
  const promptInput = $('#promptInput');
  const sendBtn = $('#sendBtn');
  const statusDot = $('#statusDot');
  const statusText = $('#statusText');
  const contextBtn = $('#contextBtn');
  const contextRing = $('#contextRing');
  const contextSummary = $('#contextSummary');
  const contextPopover = $('#contextPopover');
  const settingsPopover = $('#settingsPopover');
  const genSettingsBtn = $('#genSettingsBtn');
  const tempRange = $('#tempRange');
  const tempVal = $('#tempVal');
  const toppRange = $('#toppRange');
  const toppVal = $('#toppVal');
  const maxTokensInput = $('#maxTokensInput');
  const resetSettingsBtn = $('#resetSettings');

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

  // Automations view + editor modal refs
  const automationsViewEl = $('#automationsView');
  const automationsBtn = $('#automationsBtn');
  const automationsListEl = $('#automationsList');
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

  // ------------------------------------------------------------- sidebar accordion
  // Toggle a collapsible section (header + its body share the .open state).
  document.querySelectorAll('.section-header').forEach((h) => {
    h.addEventListener('click', () => {
      const open = h.classList.toggle('open');
      const body = h.nextElementSibling;
      if (body) body.classList.toggle('open', open);
    });
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
  };
  const SUBTITLES = {
    chat: 'Local AI Agent',
    files: 'File Explorer',
    skills: 'Skills',
    models: 'Models',
    library: 'Library',
    automations: 'Automations',
    channels: 'Channels',
  };
  const NAV_BTNS = {
    chat: null,
    files: fileExplorerBtn,
    skills: skillsBtn,
    models: modelsBtn,
    library: libraryBtn,
    automations: automationsBtn,
    channels: channelsBtn,
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

  const STATUS_LABEL = { online: 'online', offline: 'offline', unreachable: 'unreachable', timeout: 'timeout' };

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
    renderModels(data.models);
  }

  function modelStatus(status) {
    const label = STATUS_LABEL[status] || 'unknown';
    return `<span class="model-status ${escapeHtml(status)}"><span class="dot"></span>${label}</span>`;
  }

  function renderModels(models) {
    modelsListEl.innerHTML = '';
    if (!models.length) {
      modelsListEl.innerHTML = '<div class="fe-muted">No models configured yet. Click "Add model" to create one.</div>';
      return;
    }
    for (const m of models) {
      const card = document.createElement('div');
      card.className = 'model-card' + (m.active ? ' active-model' : '');
      card.setAttribute('data-model', m.id);
      card.innerHTML = `
        <div class="model-card-row">
          <span class="model-ic">${MODEL_ICON}</span>
          <div class="model-main">
            <div class="model-name">
              ${escapeHtml(m.name)}
              ${m.active ? '<span class="model-active-tag">active</span>' : ''}
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
          <div class="model-edit-del">
            <button class="model-edit" data-edit="${escapeHtml(m.id)}" title="Edit ${escapeHtml(m.name)}">Edit</button>
            ${m.active ? '' : `<button class="model-del" data-del="${escapeHtml(m.id)}" title="Delete ${escapeHtml(m.name)}">Delete</button>`}
          </div>
        </div>`;
      card.querySelector('[data-set]').addEventListener('click', () => setActiveModel(m.id, card));
      card.querySelector('[data-edit]').addEventListener('click', () => openModelModal(m.id));
      const del = card.querySelector('[data-del]');
      if (del) del.addEventListener('click', () => deleteModel(m.id));
      modelsListEl.appendChild(card);
    }
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

  function openModelModal(id) {
    resetModelForm();
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

  modelsBtn.addEventListener('click', () => { showView('models'); closeSidebar(); });
  modelsBackChat.addEventListener('click', () => showView('chat'));
  modelsRefresh.addEventListener('click', () => loadModels());
  modelsAddBtn.addEventListener('click', () => openModelModal(null));
  $('#modelModalClose').addEventListener('click', closeModelModal);
  $('#modelFormCancel').addEventListener('click', closeModelModal);
  modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModelModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modalEl.classList.contains('hidden')) closeModelModal(); });

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
      const item = document.createElement('div');
      item.className =
        'session-item' +
        (s.id === state.currentId ? ' active' : '') +
        (confirming ? ' confirming' : '');

      // Inline confirm/cancel state replaces the delete button until confirmed.
      item.innerHTML = `
        <span class="thread-icon">💬</span>
        <span class="title">${escapeHtml(s.title)}</span>
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
    state.attachments = [];
    renderChips();
    renderMessages();
    renderSessionList();
  }

  async function newChat() {
    showView('chat');
    state.pendingDeleteId = null;
    state.currentId = null;
    state.currentMessages = [];
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
      renderMessages();
    }
    renderSessionList();
  }

  async function persistSession() {
    if (!state.currentMessages.length) return;
    const title = state.currentMessages.find((m) => m.role === 'user')?.content?.slice(0, 60) || 'New chat';
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: state.currentId || undefined,
        title: title + (title.length >= 60 ? '…' : ''),
        messages: state.currentMessages,
      }),
    });
    const saved = await res.json();
    state.currentId = saved.id;
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
    state.currentMessages.forEach((m) => appendMessage(m.role, m.content, false, m.meta));
    scrollToBottom();
    updateBudget();
  }

  function appendMessage(role, content, animate = true, meta) {
    emptyStateEl.style.display = 'none';
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (animate ? 'msg' : '');
    if (role === 'user') {
      wrap.className = 'msg msg-user';
      wrap.textContent = content;
    } else {
      wrap.className = 'msg msg-assistant';
      wrap.innerHTML = marked.parse(content);
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
  function genMetaText(u) {
    if (!u) return null;
    const totalTokens = (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0);
    const parts = [];
    if (Number(u.elapsedMs) > 0) parts.push(`⚡ ${fmtDuration(u.elapsedMs)}`);
    if (totalTokens > 0) parts.push(`${totalTokens.toLocaleString('en-US')} tokens`);
    return parts.length ? parts.join(' · ') : null;
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
    const used = input + output;
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
  }
  contextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = contextPopover.classList.contains('hidden');
    closePopovers();
    if (willOpen) contextPopover.classList.remove('hidden');
  });
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
  function applySettingsToUI() {
    tempRange.value = state.settings.temperature;
    tempVal.textContent = Number(state.settings.temperature).toFixed(2);
    toppRange.value = state.settings.top_p;
    toppVal.textContent = Number(state.settings.top_p).toFixed(2);
    maxTokensInput.value = state.settings.max_tokens;
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
  resetSettingsBtn.addEventListener('click', () => {
    state.settings = { temperature: 0.7, top_p: 0.95, max_tokens: 2048 };
    applySettingsToUI();
  });
  applySettingsToUI();

  // ------------------------------------------------------------- input
  function autoResize() {
    promptInput.style.height = 'auto';
    promptInput.style.height = Math.min(promptInput.scrollHeight, 192) + 'px';
  }
  promptInput.addEventListener('input', autoResize);

  promptInput.addEventListener('keydown', (e) => {
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

  async function sendMessage() {
    const text = promptInput.value.trim();
    if (!text || state.streaming) return;

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

    // assistant placeholder: status feed (hidden) + content slot (typing first)
    const assistantEl = appendMessage(
      'assistant',
      `<div class="agent-status hidden"></div><div class="agent-content"><span class="typing"><span></span><span></span><span></span></span></div>`
    );
    const statusEl = assistantEl.querySelector('.agent-status');
    const contentEl = assistantEl.querySelector('.agent-content');
    let typingOn = true;
    const statuses = [];
    const addToolStatus = (msg) => {
      if (typingOn) { typingOn = false; contentEl.innerHTML = ''; }
      statusEl.classList.remove('hidden');
      const line = document.createElement('div');
      line.className = 'tool-line' + (msg && msg.trim().startsWith('\u26a0') ? ' err' : '');
      line.textContent = msg || '';
      statusEl.appendChild(line);
      scrollToBottom();
    };
    let reqUsage = null; // usage from THIS request only (tokens + elapsedMs)
    const captureUsage = (u) => {
      reqUsage = u;
      state.lastUsage = {
        sessionId: state.currentId,
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
      };
    };

    const apiMessages = state.currentMessages.map((m) => ({ role: m.role, content: m.content }));

    // abortable stream
    const ac = new AbortController();
    state.abortController = ac;
    let full = ''; // accumulated assistant text, visible to the abort handler

    try {
      const res = await fetchChat(
        {
          messages: apiMessages,
          stream: true,
          generation: { ...state.settings },
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
      const handleData = (json) => {
        if (json.type === 'status') {
          statuses.push(json.message || '');
          addToolStatus(json.message || '');
          return;
        }
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) full += delta;
        if (json.usage) captureUsage(json.usage);
      };

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

        if (full) {
          contentEl.innerHTML = marked.parse(full);
          attachCopyButtons(contentEl);
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
      if (!full) {
        const errStatus = statuses.find((s) => s && s.trim().startsWith('\u26a0'));
        if (errStatus) {
          contentEl.innerHTML =
            `<div class="text-red-500 dark:text-red-400 font-medium">⚠️ ${escapeHtml(errStatus.replace(/^\u26a0\s*/, ''))}</div>`;
          scrollToBottom();
          return; // finally still runs
        }
        throw new Error('Empty response from llama.cpp');
      }

      const metaText = genMetaText(reqUsage);
      state.currentMessages.push({ role: 'assistant', content: full, meta: metaText });
      contentEl.innerHTML = marked.parse(full);
      attachCopyButtons(contentEl);
      if (metaText) {
        const metaEl = document.createElement('div');
        metaEl.className = 'msg-meta';
        metaEl.textContent = metaText;
        assistantEl.appendChild(metaEl);
      }
      scrollToBottom();
      await persistSession();
      updateBudget();
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      if (aborted) {
        // User pressed Stop: freeze whatever partial response arrived.
        if (full) {
          state.currentMessages.push({ role: 'assistant', content: full, meta: genMetaText(reqUsage) });
          contentEl.innerHTML = marked.parse(full);
          attachCopyButtons(contentEl);
          const note = document.createElement('div');
          note.className = 'stop-note';
          note.textContent = '⏹ Generation stopped — partial response kept.';
          messagesEl.appendChild(note);
          scrollToBottom();
        } else {
          // Stopped before any content arrived — drop the typing placeholder
          // but keep the user's message. Reset the assistant slot cleanly.
          assistantEl.remove();
        }
        await persistSession();
        updateBudget();
      } else {
        contentEl.innerHTML =
          `<div class="text-red-500 dark:text-red-400 font-medium">⚠️ ${escapeHtml(err.message)}</div>` +
          `<div class="text-sm mt-1 text-gray-500 dark:text-gray-400">This request was retried automatically. If it keeps failing, the active model endpoint may be unavailable — check the Models panel or the llama.cpp server.</div>`;
        scrollToBottom();
      }
    } finally {
      if (state.abortController === ac) state.abortController = null;
      setStreamingUI(false);
    }
  }

  function stopGeneration() {
    if (state.abortController) state.abortController.abort();
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
    renderAutomations(data.automations);
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
    setInterval(checkHealth, 15000);
    // Keep the automations + channels lists fresh while their views are open.
    setInterval(() => {
      if (state.view === 'automations') loadAutomations();
      if (state.view === 'channels') loadChannels();
    }, 15000);
  })();
})();