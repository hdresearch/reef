// Fleet Services Dashboard

const API = '/ui/api';

// --- Helpers ---

async function api(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// --- Board ---

const STATUS_ORDER = ['open', 'in_progress', 'in_review', 'blocked', 'done'];
let lastBoardHash = '';

async function loadBoard() {
  try {
    const data = await api('/board/tasks');
    renderBoard(data.tasks || []);
  } catch (e) {
    document.getElementById('board').innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
  }
}

function renderBoard(tasks) {
  const board = document.getElementById('board');
  const grouped = {};
  for (const s of STATUS_ORDER) grouped[s] = [];
  for (const t of tasks) {
    (grouped[t.status] || grouped['open']).push(t);
  }

  document.getElementById('stat-total').textContent = tasks.length;
  document.getElementById('stat-open').textContent = grouped['open'].length;
  document.getElementById('stat-blocked').textContent = grouped['blocked'].length;

  const boardHash = JSON.stringify(tasks.map(t => t.id + ':' + t.status + ':' + (t.score || 0) + ':' + (t.notes || []).length));
  if (boardHash === lastBoardHash) return;
  lastBoardHash = boardHash;

  const expandedIds = new Set();
  board.querySelectorAll('.task-card.expanded').forEach(el => {
    if (el.dataset.id) expandedIds.add(el.dataset.id);
  });

  let html = '';
  for (const status of STATUS_ORDER) {
    const items = grouped[status];
    if (!items.length) continue;
    html += `<div class="status-group">
      <div class="status-label">${status.replace(/_/g, ' ')} <span class="count">${items.length}</span></div>`;
    for (const t of items) {
      const tags = (t.tags || []).map(tag => `<span class="tag">${esc(tag)}</span>`).join('');
      const assignee = t.assignee ? `<span class="assignee">@${esc(t.assignee)}</span>` : '';
      const notes = (t.notes || []).map(n =>
        `<div class="note"><span class="note-author">@${esc(n.author)}</span> <span class="note-type">${esc(n.type)}</span> ${esc(n.content)}</div>`
      ).join('');
      const score = t.score || 0;
      const scoreBadge = score > 0
        ? `<span class="score-badge">${score}</span>`
        : `<span class="score-badge dim">0</span>`;
      const isExpanded = expandedIds.has(t.id) ? ' expanded' : '';
      html += `<div class="task-card status-${status}${isExpanded}" onclick="this.classList.toggle('expanded')" data-id="${t.id}">
        <div class="task-top">
          <div class="title">${esc(t.title)}</div>
          <button class="bump-btn" onclick="event.stopPropagation(); bumpTask('${t.id}')">${scoreBadge}</button>
        </div>
        <div class="meta">
          ${assignee}
          ${tags}
          <span class="age">${timeAgo(t.createdAt)}</span>
        </div>
        ${notes ? `<div class="task-notes">${notes}</div>` : ''}
      </div>`;
    }
    html += '</div>';
  }

  board.innerHTML = html || '<div class="empty">No tasks</div>';
}

async function bumpTask(taskId) {
  try {
    await fetch(`${API}/board/tasks/${taskId}/bump`, { method: 'POST' });
    loadBoard();
  } catch (e) {
    console.error('Bump failed:', e);
  }
}
// expose for onclick
window.bumpTask = bumpTask;

// --- Feed ---

let eventCount = 0;
const feedEl = () => document.getElementById('feed');

function renderEvent(evt) {
  const el = document.createElement('div');
  el.className = 'event';
  el.innerHTML = `
    <div class="event-header">
      <span class="event-agent">${esc(evt.agent)}</span>
      <span class="event-type">${esc(evt.type)}</span>
      <span class="event-time">${evt.timestamp ? timeAgo(evt.timestamp) : ''}</span>
    </div>
    <div class="event-summary">${esc(evt.summary)}</div>
  `;
  return el;
}

async function loadFeed() {
  try {
    const events = await api('/feed/events?limit=100');
    const feed = feedEl();
    feed.innerHTML = '';
    const list = Array.isArray(events) ? events : (events.events || []);
    list.reverse();
    eventCount = 0;
    for (const evt of list) {
      feed.appendChild(renderEvent(evt));
      eventCount++;
    }
    feed.scrollTop = 0;
    document.getElementById('stat-events').textContent = eventCount;
  } catch (e) {
    feedEl().innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
  }
}

function startSSE() {
  const evtSource = new EventSource(`${API}/feed/stream`);
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');

  evtSource.onopen = () => {
    dot.classList.add('connected');
    label.textContent = 'connected';
  };

  evtSource.onmessage = (e) => {
    try {
      const evt = JSON.parse(e.data);
      const feed = feedEl();
      feed.prepend(renderEvent(evt));
      eventCount++;
      document.getElementById('stat-events').textContent = eventCount;
      if (feed.scrollTop < 100) feed.scrollTop = 0;
    } catch {}
  };

  evtSource.onerror = () => {
    dot.classList.remove('connected');
    label.textContent = 'reconnecting';
  };
}

// --- Registry ---

let lastRegistryHash = '';

async function loadRegistry() {
  try {
    const data = await api('/registry/vms');
    renderRegistry(data.vms || []);
  } catch (e) {
    document.getElementById('registry').innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
  }
}

function renderRegistry(vms) {
  const reg = document.getElementById('registry');
  document.getElementById('stat-vms').textContent = vms.length || '0';

  if (!vms.length) {
    reg.innerHTML = '<div class="empty">No VMs registered</div>';
    return;
  }

  const regHash = JSON.stringify(vms.map(v => v.id + ':' + (v.status || '') + ':' + (v.lastSeen || v.registeredAt)));
  if (regHash === lastRegistryHash) return;
  lastRegistryHash = regHash;

  let html = '';
  for (const vm of vms) {
    const staleMs = Date.now() - new Date(vm.lastSeen || vm.registeredAt).getTime();
    const isStale = staleMs > 120000;
    const statusCls = (vm.status || 'stopped').toLowerCase();
    html += `<div class="vm-card ${isStale ? 'stale' : ''}">
      <div class="vm-name">${esc(vm.name || vm.id)}</div>
      <div class="vm-role">${esc(vm.role || 'unknown')}</div>
      <div class="vm-meta">
        <span class="vm-status ${statusCls}">${esc(vm.status || 'unknown')}</span>
        <span>seen ${timeAgo(vm.lastSeen || vm.registeredAt)}</span>
      </div>
    </div>`;
  }
  reg.innerHTML = html;
}

// --- Log ---

let logRefreshTimer = null;

async function loadLog() {
  const range = document.getElementById('log-range').value;
  const agentFilter = document.getElementById('log-agent-filter').value.trim();
  const container = document.getElementById('log-entries');

  try {
    const data = await api(`/log?last=${range}`);
    let entries = data.entries || [];

    if (agentFilter) {
      const q = agentFilter.toLowerCase();
      entries = entries.filter(e => (e.agent || '').toLowerCase().includes(q));
    }

    entries.reverse();

    if (!entries.length) {
      container.innerHTML = '<div class="empty">No log entries for this time range</div>';
      document.getElementById('log-count').textContent = '0';
      return;
    }

    let html = '';
    for (const entry of entries) {
      const agent = entry.agent ? esc(entry.agent) : '<span style="color:var(--text-dim)">-</span>';
      html += `<div class="log-entry">
        <span class="log-time">${timeAgo(entry.timestamp)}</span>
        <span class="log-agent">${agent}</span>
        <span class="log-text">${esc(entry.text)}</span>
      </div>`;
    }
    container.innerHTML = html;
    document.getElementById('log-count').textContent = entries.length;
  } catch (e) {
    container.innerHTML = `<div class="empty">Failed to load log: ${esc(e.message)}</div>`;
  }
}

function startLogRefresh() {
  if (logRefreshTimer) return;
  loadLog();
  logRefreshTimer = setInterval(loadLog, 30000);
}

function stopLogRefresh() {
  if (logRefreshTimer) {
    clearInterval(logRefreshTimer);
    logRefreshTimer = null;
  }
}

// --- Tabs ---

let activeView = 'dashboard';

function switchView(viewName) {
  activeView = viewName;

  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-view="${viewName}"]`)?.classList.add('active');

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${viewName}`)?.classList.add('active');

  if (viewName === 'dashboard') {
    loadBoard();
    loadRegistry();
  }
  if (viewName === 'log') {
    startLogRefresh();
  } else {
    stopLogRefresh();
  }
}

// --- Init ---

async function init() {
  await Promise.all([loadBoard(), loadFeed(), loadRegistry()]);
  startSSE();

  // Poll dashboard data
  setInterval(() => {
    if (activeView === 'dashboard') {
      loadBoard();
      loadRegistry();
    }
  }, 10000);

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });

  // Log filter controls
  document.getElementById('log-range').addEventListener('change', loadLog);
  document.getElementById('log-agent-filter').addEventListener('input', () => {
    clearTimeout(window._logFilterTimeout);
    window._logFilterTimeout = setTimeout(loadLog, 300);
  });
}

init();
