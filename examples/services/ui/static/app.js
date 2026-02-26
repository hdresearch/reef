// =============================================================================
// reef UI — dynamic panel discovery + built-in chat
// =============================================================================

const API = PANEL_API; // set in index.html

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

// =============================================================================
// Panel discovery
// =============================================================================

const tabsEl = document.getElementById('tabs');
const panelsEl = document.getElementById('panels');
const statusEl = document.getElementById('status');
let activeTab = null;
const loadedPanels = new Map(); // name → container element

async function discoverPanels() {
  try {
    // Get loaded services
    const res = await fetch(`${API}/services`);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const services = data.modules || data.services || (Array.isArray(data) ? data : []);

    // Try to fetch _panel for each service (skip ui itself)
    const panelResults = await Promise.allSettled(
      services
        .filter(s => s.name !== 'ui')
        .map(async (s) => {
          const r = await fetch(`${API}/${s.name}/_panel`);
          if (!r.ok) return null;
          const ct = r.headers.get('content-type') || '';
          if (!ct.includes('html')) return null;
          return { name: s.name, html: await r.text() };
        })
    );

    const panels = panelResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    // Build tabs: discovered panels first, then chat
    tabsEl.innerHTML = '';

    for (const panel of panels) {
      addTab(panel.name, panel.name);
    }
    addTab('chat', 'Chat');

    // Inject panel HTML
    for (const panel of panels) {
      if (!loadedPanels.has(panel.name)) {
        const container = document.createElement('div');
        container.className = 'panel-view';
        container.id = `view-${panel.name}`;
        container.dataset.api = API;
        panelsEl.appendChild(container);
        injectPanel(container, panel.html);
        loadedPanels.set(panel.name, container);
      }
    }

    // Remove panels for services that were unloaded
    const activeNames = new Set(panels.map(p => p.name));
    for (const [name, el] of loadedPanels) {
      if (!activeNames.has(name)) {
        el.remove();
        loadedPanels.delete(name);
        // Remove tab
        tabsEl.querySelector(`[data-view="${name}"]`)?.remove();
      }
    }

    // Activate first tab if none active
    if (!activeTab || !document.getElementById(`view-${activeTab}`)) {
      const first = panels[0]?.name || 'chat';
      switchTab(first);
    }

    setStatus('ok', `${panels.length} panels`);
  } catch (e) {
    setStatus('err', e.message);
  }
}

function addTab(name, label) {
  const btn = document.createElement('button');
  btn.className = 'tab' + (activeTab === name ? ' active' : '');
  btn.dataset.view = name;
  btn.textContent = label;
  btn.addEventListener('click', () => switchTab(name));
  tabsEl.appendChild(btn);
}

function switchTab(name) {
  activeTab = name;

  // Update tab highlight
  tabsEl.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === name);
  });

  // Show/hide panels
  document.querySelectorAll('.panel-view').forEach(v => {
    v.classList.toggle('active', v.id === `view-${name}`);
  });

  // Lazy-start chat session
  if (name === 'chat') {
    if (!chatSessionId) chatCreateSession();
    document.getElementById('chat-input')?.focus();
  }
}

function injectPanel(container, html) {
  // Inject HTML without scripts
  const temp = document.createElement('div');
  temp.innerHTML = html;

  // Extract scripts
  const scripts = [];
  temp.querySelectorAll('script').forEach(s => {
    scripts.push(s.textContent);
    s.remove();
  });

  // Inject HTML
  container.innerHTML = temp.innerHTML;

  // Execute scripts in order
  for (const code of scripts) {
    const s = document.createElement('script');
    s.textContent = code;
    container.appendChild(s);
  }
}

function setStatus(state, text) {
  statusEl.className = 'status ' + state;
  statusEl.querySelector('.label').textContent = text;
}

// =============================================================================
// Chat
// =============================================================================

let chatSessionId = null;
let chatStreaming = false;
let chatCurrentEl = null;
let chatCurrentText = '';

function chatEl(id) { return document.getElementById(id); }

async function chatCreateSession() {
  try {
    const res = await fetch(`${API}/agent/sessions`, { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    chatSessionId = data.id;
    chatConnectSSE();
    const empty = chatEl('chat-messages').querySelector('.chat-empty');
    if (empty) empty.remove();
  } catch (e) {
    chatAddMsg('system', `Failed to start session: ${e.message}`);
  }
}

function chatConnectSSE() {
  if (!chatSessionId) return;
  fetch(`${API}/agent/sessions/${chatSessionId}/events`)
    .then(res => {
      if (!res.ok) throw new Error(`SSE ${res.status}`);
      chatReadSSE(res.body.getReader());
    })
    .catch(e => {
      chatAddMsg('system', `Disconnected: ${e.message}`);
      setTimeout(() => { if (chatSessionId) chatConnectSSE(); }, 3000);
    });
}

async function chatReadSSE(reader) {
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { chatHandleEvent(JSON.parse(line.slice(6))); } catch {}
        }
      }
    }
  } catch {}
}

function chatHandleEvent(e) {
  switch (e.type) {
    case 'agent_start':
      chatStreaming = true;
      chatEl('chat-send').textContent = 'Stop';
      break;
    case 'agent_end':
      chatStreaming = false;
      chatFinish();
      chatEl('chat-send').textContent = 'Send';
      break;
    case 'message_update': {
      const d = e.assistantMessageEvent;
      if (d?.type === 'text_delta') {
        chatEnsure();
        chatCurrentText += d.delta;
        chatRender();
      }
      break;
    }
    case 'tool_execution_start':
      chatEnsure();
      chatAddTool(e.toolCallId, e.toolName, e.args);
      break;
    case 'tool_execution_update':
      chatUpdateTool(e.toolCallId, e.partialResult);
      break;
    case 'tool_execution_end':
      chatUpdateTool(e.toolCallId, e.result, e.isError);
      break;
  }
}

function chatEnsure() {
  if (chatCurrentEl) return;
  chatCurrentEl = document.createElement('div');
  chatCurrentEl.className = 'chat-msg';
  chatCurrentEl.innerHTML = '<div class="chat-msg-role assistant">assistant</div><div class="chat-msg-content"></div>';
  chatEl('chat-messages').appendChild(chatCurrentEl);
  chatCurrentText = '';
}

function chatRender() {
  if (!chatCurrentEl) return;
  let t = chatCurrentEl.querySelector('.chat-text');
  if (!t) {
    t = document.createElement('span');
    t.className = 'chat-text';
    const c = chatCurrentEl.querySelector('.chat-msg-content');
    c.insertBefore(t, c.firstChild);
  }
  t.innerHTML = chatMd(chatCurrentText) + '<span class="chat-cursor"></span>';
  chatScroll();
}

function chatFinish() {
  if (!chatCurrentEl) return;
  const t = chatCurrentEl.querySelector('.chat-text');
  if (t) t.innerHTML = chatMd(chatCurrentText);
  chatCurrentEl.querySelector('.chat-cursor')?.remove();
  chatCurrentEl = null;
  chatCurrentText = '';
}

function chatAddTool(id, name, args) {
  const preview = args
    ? Object.values(args).map(v => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 50 ? s.slice(0, 50) + '…' : s; }).join(', ')
    : '';
  const el = document.createElement('div');
  el.className = 'chat-tool';
  el.dataset.toolCallId = id;
  el.innerHTML = `
    <div class="chat-tool-header" onclick="this.querySelector('.chat-tool-arrow').classList.toggle('open');this.nextElementSibling.classList.toggle('open')">
      <span class="chat-tool-arrow">▶</span>
      <span>${esc(name)}(${esc(preview)})</span>
    </div>
    <div class="chat-tool-body"></div>`;
  chatCurrentEl.querySelector('.chat-msg-content').appendChild(el);
  chatScroll();
}

function chatUpdateTool(id, result, isError) {
  const el = chatCurrentEl?.querySelector(`[data-tool-call-id="${id}"]`);
  if (!el) return;
  const body = el.querySelector('.chat-tool-body');
  const text = result?.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
  body.textContent = text.slice(-2000);
  if (isError) body.classList.add('chat-tool-error');
}

function chatAddMsg(role, text) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  el.innerHTML = `<div class="chat-msg-role ${role}">${role === 'user' ? 'you' : role}</div><div class="chat-msg-content">${esc(text)}</div>`;
  chatEl('chat-messages').appendChild(el);
  chatScroll();
}

function chatMd(text) {
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, c) => `<pre><code>${esc(c.trimEnd())}</code></pre>`);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return text.split(/(<pre>[\s\S]*?<\/pre>)/g).map(p => p.startsWith('<pre>') ? p : p.replace(/\n/g, '<br>')).join('');
}

function chatScroll() {
  requestAnimationFrame(() => {
    const el = chatEl('chat-messages');
    el.scrollTop = el.scrollHeight;
  });
}

async function chatSend() {
  if (!chatSessionId) return;
  if (chatStreaming) {
    fetch(`${API}/agent/sessions/${chatSessionId}/abort`, { method: 'POST' }).catch(() => {});
    return;
  }
  const input = chatEl('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = '36px';
  chatAddMsg('user', text);
  chatFinish();
  try {
    const res = await fetch(`${API}/agent/sessions/${chatSessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    const data = await res.json();
    if (data.error) chatAddMsg('system', data.error);
  } catch (e) {
    chatAddMsg('system', e.message);
  }
}

// Chat input handlers
chatEl('chat-send').addEventListener('click', chatSend);
chatEl('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
});
chatEl('chat-input').addEventListener('input', () => {
  const el = chatEl('chat-input');
  el.style.height = '36px';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
});

// =============================================================================
// Init
// =============================================================================

discoverPanels();
// Re-discover periodically (picks up loaded/unloaded services)
setInterval(discoverPanels, 30000);
