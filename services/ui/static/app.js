// =============================================================================
// reef — activity feed + branch conversations
// =============================================================================

const API = PANEL_API;

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function md(text) {
  if (!text) return '';
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, c) => `<pre><code>${esc(c.trimEnd())}</code></pre>`);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return text.split(/(<pre>[\s\S]*?<\/pre>)/g).map(p => p.startsWith('<pre>') ? p : p.replace(/\n/g, '<br>')).join('');
}

function timeStr(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const $ = id => document.getElementById(id);

function autoScroll(el) {
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (nearBottom) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

// =============================================================================
// Feed — high-level activity log
// =============================================================================

const feedEl = $('feed-entries');
const feedScroll = $('feed-scroll');
const feedNodes = new Map(); // nodeId → DOM element (the tree item, has .feed-children inside)


function shortId(id) {
  if (!id) return '';
  const parts = id.split('-');
  return parts.length > 2 ? parts.slice(0, 2).join('-') : id;
}

/**
 * Core feed primitive: add a tree node to the feed.
 * If parentNodeId is set and found, nests underneath it.
 * Otherwise appends to the root feed.
 */
function feedAdd(nodeId, parentNodeId, tag, text, opts = {}) {
  const item = document.createElement('div');
  item.className = 'feed-item';
  if (nodeId) item.dataset.nodeId = nodeId;
  if (opts.taskId) item.dataset.taskId = opts.taskId;

  const row = document.createElement('div');
  row.className = 'feed-row' + (opts.clickable ? ' clickable' : '');
  if (opts.clickable && opts.taskId) {
    row.addEventListener('click', () => {
      const branchId = taskToBranch.get(opts.taskId);
      if (branchId) openBranch(branchId);
    });
  }

  const statusHtml = opts.status ? `<span class="feed-status">${opts.status}</span>` : '';
  row.innerHTML = `
    <span class="feed-time">${timeStr(opts.timestamp || Date.now())}</span>
    <span class="feed-tag ${tag}">${tag}</span>
    <span class="feed-text">${esc(text)}</span>
    ${statusHtml}
  `;

  const children = document.createElement('div');
  children.className = 'feed-children';

  item.appendChild(row);
  item.appendChild(children);

  // Find parent and nest, or append to root
  const parentEl = parentNodeId ? feedNodes.get(parentNodeId) : null;
  if (parentEl) {
    parentEl.querySelector(':scope > .feed-children').appendChild(item);
  } else {
    feedEl.appendChild(item);
  }

  if (nodeId) feedNodes.set(nodeId, item);
  autoScroll(feedScroll);
  return item;
}

/** Update an existing feed node's tag + text. */
function feedUpdate(nodeId, tag, text, status) {
  const item = feedNodes.get(nodeId);
  if (!item) return;
  const row = item.querySelector(':scope > .feed-row');
  if (!row) return;
  if (tag) {
    const tagEl = row.querySelector('.feed-tag');
    if (tagEl) { tagEl.className = `feed-tag ${tag}`; tagEl.textContent = tag; }
  }
  if (text) {
    const textEl = row.querySelector('.feed-text');
    if (textEl) textEl.textContent = text.length > 100 ? text.slice(0, 100) + '…' : text;
  }
  if (status) {
    let statusEl = row.querySelector('.feed-status');
    if (!statusEl) { statusEl = document.createElement('span'); statusEl.className = 'feed-status'; row.appendChild(statusEl); }
    statusEl.textContent = status;
  }
}

// Convenience: standalone event (no nesting)
function feedEvent(tag, text, opts = {}) {
  return feedAdd(opts.nodeId || null, opts.parentId || null, tag, text, opts);
}

// =============================================================================
// Branch panel — full streaming conversation
// =============================================================================

const branches = new Map();     // branchId → { taskIds[], messages[], currentMsg, currentText, working }
const taskToBranch = new Map(); // taskId → branchId
let activeBranch = null;
let branchCounter = 0;

function createBranch() {
  const id = `branch-${++branchCounter}`;
  branches.set(id, { taskIds: [], messages: [], currentMsg: null, currentText: '', working: false, leafNodeId: null });
  return id;
}

function openBranch(branchId) {
  activeBranch = branchId;
  $('branch').classList.remove('closed');

  const msgEl = $('branch-messages');
  msgEl.innerHTML = '';
  const b = branches.get(branchId);
  if (b) {
    for (const msg of b.messages) msgEl.appendChild(msg);
  }

  $('branch-label').textContent = `conversation ${branchId.split('-')[1]}`;
  $('branch-text').focus();
  autoScroll($('branch-scroll'));
}

function closeBranch() {
  activeBranch = null;
  $('branch').classList.add('closed');
}

function branchAddMsg(branchId, role, content) {
  const b = branches.get(branchId);
  if (!b) return null;

  const el = document.createElement('div');
  el.className = 'branch-msg';
  el.innerHTML = `
    <div class="branch-msg-role ${role}">${role === 'user' ? 'you' : role}</div>
    <div class="branch-msg-content">${role === 'user' ? esc(content) : md(content)}</div>`;
  b.messages.push(el);

  if (activeBranch === branchId) {
    $('branch-messages').appendChild(el);
    autoScroll($('branch-scroll'));
  }

  return el;
}

function branchStreamDelta(taskId, delta) {
  const branchId = taskToBranch.get(taskId);
  if (!branchId) return;
  const b = branches.get(branchId);
  if (!b) return;

  if (!b.currentMsg) {
    b.currentMsg = branchAddMsg(branchId, 'assistant', '');
    b.currentText = '';
  }

  b.currentText += delta;
  const mc = b.currentMsg.querySelector('.branch-msg-content');
  mc.innerHTML = md(b.currentText) + '<span class="cursor"></span>';
  if (activeBranch === branchId) autoScroll($('branch-scroll'));
}

function branchAddTool(taskId, toolName, toolCallId, args) {
  const branchId = taskToBranch.get(taskId);
  if (!branchId) return;
  const b = branches.get(branchId);
  if (!b || !b.currentMsg) return;

  const mc = b.currentMsg.querySelector('.branch-msg-content');
  const preview = args
    ? Object.entries(args).map(([, v]) => {
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        return s.length > 40 ? s.slice(0, 40) + '…' : s;
      }).join(', ')
    : '';

  const tool = document.createElement('div');
  tool.className = 'branch-tool';
  tool.dataset.toolCallId = toolCallId || '';
  tool.innerHTML = `
    <div class="branch-tool-header" onclick="this.querySelector('.branch-tool-arrow').classList.toggle('open');this.nextElementSibling.classList.toggle('open')">
      <span class="branch-tool-arrow">▶</span> ${esc(toolName)}(${esc(preview)})
    </div>
    <div class="branch-tool-body"></div>`;
  mc.appendChild(tool);
  if (activeBranch === branchId) autoScroll($('branch-scroll'));
}

function branchUpdateTool(taskId, toolCallId, result, isError) {
  const branchId = taskToBranch.get(taskId);
  if (!branchId) return;
  const b = branches.get(branchId);
  if (!b || !b.currentMsg) return;

  const tool = b.currentMsg.querySelector(`[data-tool-call-id="${toolCallId}"]`);
  if (!tool) return;
  const body = tool.querySelector('.branch-tool-body');
  const text = result?.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
  if (text) { body.textContent = text.slice(-500); body.classList.add('open'); }
  if (isError) body.style.color = 'var(--error)';
}

function branchFinish(taskId) {
  const branchId = taskToBranch.get(taskId);
  if (!branchId) return;
  const b = branches.get(branchId);
  if (!b) return;

  if (b.currentMsg) {
    const mc = b.currentMsg.querySelector('.branch-msg-content');
    mc.innerHTML = md(b.currentText || '');
    b.currentMsg = null;
    b.currentText = '';
  }
  b.working = false;
}

// =============================================================================
// Send
// =============================================================================

let taskIdCounter = 0;

/**
 * Submit a task. If taskId exists, this is a continuation — we send parentId
 * so the server adds to the existing conversation tree.
 */
async function submitTask(text, branchId, existingTaskId) {
  const isNew = !existingTaskId;
  const taskId = existingTaskId || `ui-${++taskIdCounter}-${Date.now()}`;

  if (branchId) {
    taskToBranch.set(taskId, branchId);
    const b = branches.get(branchId);
    if (b && !b.taskIds.includes(taskId)) b.taskIds.push(taskId);
    if (b) b.working = true;
  }

  // New tasks get a feed entry (server will also broadcast branch_started,
  // but we create it here so it appears instantly)
  // Note: branch_started handler checks taskToBranch to avoid duplicates

  // If continuing, get the leaf nodeId to use as parentId
  const parentId = isNew ? undefined : branches.get(branchId)?.leafNodeId;

  try {
    const res = await fetch(`${API}/reef/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: text, taskId, parentId }),
    });
    const data = await res.json();
    if (data.nodeId && branchId) {
      branches.get(branchId).leafNodeId = data.nodeId;
    }
    if (data.error) {
      feedEvent('error', data.error, { taskId });
      if (branchId) branches.get(branchId).working = false;
    }
  } catch (e) {
    feedEvent('error', e.message, { taskId });
    if (branchId) branches.get(branchId).working = false;
  }
}

function feedSend() {
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = '36px';

  const branchId = createBranch();
  branchAddMsg(branchId, 'user', text);
  openBranch(branchId);
  submitTask(text, branchId, null);
}

function branchSend() {
  if (!activeBranch) return;
  const input = $('branch-text');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = '36px';

  const b = branches.get(activeBranch);
  if (b?.working) return;

  branchAddMsg(activeBranch, 'user', text);

  // Continue the existing task — same taskId, send parentId
  const existingTaskId = b?.taskIds[0];
  submitTask(text, activeBranch, existingTaskId);
}

// =============================================================================
// SSE
// =============================================================================

let sseConnected = false;

function connectSSE() {
  if (sseConnected) return;
  sseConnected = true;
  setStatus('ok', 'connected');

  fetch(`${API}/reef/events`)
    .then(res => {
      if (!res.ok) throw new Error(`${res.status}`);
      readSSE(res.body.getReader());
    })
    .catch(e => {
      sseConnected = false;
      setStatus('err', 'disconnected');
      setTimeout(connectSSE, 3000);
    });
}

async function readSSE(reader) {
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
          try { handleEvent(JSON.parse(line.slice(6))); } catch {}
        }
      }
    }
  } catch {}
  sseConnected = false;
  setStatus('err', 'disconnected');
  setTimeout(connectSSE, 3000);
}

// Track the "current assistant" nodeId per task — for text streaming
const taskAssistantNode = new Map(); // taskId → nodeId placeholder

function handleEvent(e) {
  const taskId = e.taskId || '';
  const nodeId = e.nodeId || null;
  const parentId = e.parentId || null;

  switch (e.type) {
    case 'agent_start':
      break;

    case 'branch_started': {
      // Continuation — add follow-up user node to feed + update branch
      if (e.continuing) {
        // Add the continuation user node to the feed tree (nests under previous assistant)
        feedAdd(nodeId, parentId, 'task', (e.prompt || '').slice(0, 80), {
          taskId, clickable: true, status: '⏳',
        });

        if (taskToBranch.has(taskId)) {
          const branchId = taskToBranch.get(taskId);
          const b = branches.get(branchId);
          if (b) {
            b.leafNodeId = nodeId;
            b.working = true;
            branchAddMsg(branchId, 'user', e.prompt || '');
          }
        }
        break;
      }

      // New task — create feed entry and track its root node
      feedAdd(nodeId, parentId, 'task', (e.prompt || '').slice(0, 80), {
        taskId, clickable: true, status: '⏳',
      });

      // Create branch for the conversation panel if not from UI
      if (!taskToBranch.has(taskId)) {
        const branchId = createBranch();
        taskToBranch.set(taskId, branchId);
        const b = branches.get(branchId);
        b.taskIds.push(taskId);
        b.leafNodeId = nodeId;
        branchAddMsg(branchId, 'user', e.prompt || taskId);
      }
      break;
    }

    case 'branch_done': {
      // Assistant response nests under its parent (user node) in the feed
      feedAdd(nodeId, parentId, 'done', (e.summary || 'done').slice(0, 80), { taskId });
      // Update the task entry status
      const taskItem = feedEl.querySelector(`[data-task-id="${taskId}"] .feed-status`);
      if (taskItem) taskItem.textContent = '✓';

      branchFinish(taskId);
      if (nodeId) {
        const branchId = taskToBranch.get(taskId);
        if (branchId) branches.get(branchId).leafNodeId = nodeId;
      }
      updateStatus();
      break;
    }

    case 'branch_error': {
      feedAdd(null, parentId, 'error', (e.error || 'failed').slice(0, 80), { taskId });
      const taskItem = feedEl.querySelector(`[data-task-id="${taskId}"] .feed-status`);
      if (taskItem) taskItem.textContent = '✗';

      branchFinish(taskId);
      updateStatus();
      break;
    }

    case 'message_update': {
      const d = e.assistantMessageEvent;
      if (d?.type === 'text_delta') {
        branchStreamDelta(taskId, d.delta);
      }
      break;
    }

    case 'tool_execution_start': {
      // Tool call nests under its parent (user node) in the feed
      const preview = e.args ? Object.entries(e.args).map(([, v]) => {
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        return s.length > 30 ? s.slice(0, 30) + '…' : s;
      }).join(', ') : '';
      feedAdd(nodeId, parentId, 'tool', `${e.toolName}(${preview})`, { taskId });
      branchAddTool(taskId, e.toolName, e.toolCallId, e.args);
      break;
    }

    case 'tool_execution_end': {
      // Tool result nests under its tool_call
      const resultText = e.result?.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
      if (resultText && nodeId) {
        feedAdd(nodeId, parentId, e.isError ? 'error' : 'result', resultText.slice(0, 60));
      }
      branchUpdateTool(taskId, e.toolCallId, e.result, e.isError);
      break;
    }

    // System events — use nodeId/parentId from server
    case 'service_reload':
    case 'service_unload':
    case 'service_deploy':
      feedAdd(nodeId, parentId, 'system', `${e.type.replace('service_', '')} ${e.name || ''}`);
      break;

    // Cron — cron_done is child of cron_start via parentId
    case 'cron_start':
      feedAdd(nodeId, parentId, 'cron', `${e.jobName} (${e.jobType || 'exec'})`);
      break;
    case 'cron_done':
      feedAdd(nodeId, parentId, 'done', (e.output || 'ok').slice(0, 80));
      break;
    case 'cron_error':
      feedAdd(nodeId, parentId, 'error', (e.error || 'failed').slice(0, 80));
      break;
  }
}

// =============================================================================
// History
// =============================================================================

async function loadHistory() {
  try {
    const res = await fetch(`${API}/reef/tree`);
    if (!res.ok) return;
    const data = await res.json();
    const nodes = data.nodes || {};
    const refs = data.refs || {};
    const taskData = data.tasks || {};

    // Build parent → children index, sorted by timestamp
    const childrenOf = {};
    for (const [nid, n] of Object.entries(nodes)) {
      if (n.parentId) {
        (childrenOf[n.parentId] = childrenOf[n.parentId] || []).push(nid);
      }
    }
    for (const kids of Object.values(childrenOf)) {
      kids.sort((a, b) => (nodes[a]?.timestamp || 0) - (nodes[b]?.timestamp || 0));
    }

    // Reconstruct task conversations in the branch panel
    for (const [name, info] of Object.entries(taskData)) {
      const leafId = refs[name];
      if (!leafId) continue;

      const path = [];
      let cur = leafId;
      const seen = new Set();
      while (cur && nodes[cur] && !seen.has(cur)) {
        seen.add(cur);
        path.unshift(nodes[cur]);
        cur = nodes[cur].parentId;
      }

      const branchId = createBranch();
      taskToBranch.set(name, branchId);
      const branch = branches.get(branchId);
      branch.taskIds.push(name);
      branch.leafNodeId = leafId;

      for (const node of path) {
        if (node.role === 'user') branchAddMsg(branchId, 'user', node.content);
        else if (node.role === 'assistant') branchAddMsg(branchId, 'assistant', node.content);
        else if (node.role === 'tool_call') {
          const el = branchAddMsg(branchId, 'assistant', '');
          if (el) {
            const mc = el.querySelector('.branch-msg-content');
            if (mc) mc.innerHTML = `<div class="branch-tool"><div class="branch-tool-header"><span class="branch-tool-arrow">▶</span> ${esc(node.toolName || node.content)}</div></div>`;
          }
        }
      }
    }

    // Walk the tree depth-first, rendering each node in the feed
    const rendered = new Set();

    function renderNode(nid) {
      if (rendered.has(nid)) return;
      rendered.add(nid);
      const n = nodes[nid];
      if (!n || n.role === 'system') {
        // Still render children of system
        for (const cid of (childrenOf[nid] || [])) renderNode(cid);
        return;
      }

      const tag = nodeTag(n);
      const text = nodeText(n);
      if (tag) {
        const opts = { timestamp: n.timestamp, nodeId: nid };

        // Find which task this node belongs to (for clickability)
        const taskName = Object.entries(taskData).find(([name]) => {
          const leaf = refs[name];
          if (!leaf) return false;
          let c = leaf;
          const s = new Set();
          while (c && nodes[c] && !s.has(c)) {
            s.add(c);
            if (c === nid) return true;
            c = nodes[c].parentId;
          }
          return false;
        })?.[0];

        if (taskName) {
          opts.taskId = taskName;
          opts.clickable = true;
          const info = taskData[taskName];
          if (n.role === 'user' && info?.trigger === n.content) {
            opts.status = info.status === 'done' ? '✓' : info.status === 'error' ? '✗' : '⏳';
          }
        }

        feedAdd(nid, n.parentId, tag, text, opts);
      }

      // Always recurse into children even if this node was skipped —
      // tool calls from continuations still need to render under the task
      for (const cid of (childrenOf[nid] || [])) renderNode(cid);
    }

    function nodeTag(n) {
      if (n.role === 'user') return 'task';
      if (n.role === 'assistant') return 'done';  // completion summary
      if (n.role === 'tool_call') return 'tool';
      if (n.role === 'tool_result') return 'result';
      if (n.role === 'event') {
        const et = n.eventType || 'event';
        if (et === 'cron_start') return 'cron';
        if (et === 'cron_done') return 'done';
        if (et === 'cron_error') return 'error';
        if (et.startsWith('service_')) return 'system';
        return 'system';
      }
      return null;
    }



    function nodeText(n) {
      if (n.role === 'user') return n.content.length > 80 ? n.content.slice(0, 80) + '…' : n.content;
      if (n.role === 'assistant') return n.content.length > 80 ? n.content.slice(0, 80) + '…' : n.content;
      if (n.role === 'tool_call') {
        const args = n.toolParams ? JSON.stringify(n.toolParams).slice(0, 40) : '';
        return `${n.toolName || n.content}(${args})`;
      }
      if (n.role === 'tool_result') return n.content.slice(0, 60);
      if (n.role === 'event') {
        const et = n.eventType || '';
        if (et === 'cron_start') return `${n.content} (${n.meta?.jobType || 'exec'})`;
        return n.content;
      }
      return n.content;
    }

    // Start from root
    if (data.root) renderNode(data.root);

  } catch (e) { console.error('loadHistory:', e); }
}

// =============================================================================
// Status
// =============================================================================

function setStatus(state, text) {
  const el = $('status');
  el.className = 'status ' + state;
  el.querySelector('.label').textContent = text;
}

async function updateStatus() {
  try {
    const res = await fetch(`${API}/reef/state`);
    if (!res.ok) return;
    const data = await res.json();
    const parts = [`${data.services?.length || 0} svc`];
    if (data.activeTasks > 0) parts.push(`${data.activeTasks} active`);
    setStatus('ok', parts.join(' · '));
  } catch {}
}

// =============================================================================
// Panel discovery
// =============================================================================

const loadedPanels = new Map();
const LIVE_REFRESH_PANELS = new Set(['registry', 'vm-tree', 'lieutenant', 'commits']);

async function fetchPanel(name) {
  const r = await fetch(`${API}/${name}/_panel`);
  if (!r.ok) return null;
  if (!(r.headers.get('content-type') || '').includes('html')) return null;
  return { name, html: await r.text() };
}

async function refreshPanel(name) {
  if (!loadedPanels.has(name)) return;
  const panel = await fetchPanel(name);
  if (!panel) return;
  injectPanel(loadedPanels.get(name), panel.html);
}

async function discoverPanels() {
  try {
    const res = await fetch(`${API}/services`);
    if (!res.ok) return;
    const data = await res.json();
    const services = data.modules || data.services || [];

    const results = await Promise.allSettled(
      services.filter(s => s.name !== 'ui').map(s => fetchPanel(s.name))
    );

    const panels = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

    for (const panel of panels) {
      if (loadedPanels.has(panel.name)) continue;
      if (panel.name === 'feed') continue;

      const btn = document.createElement('button');
      btn.className = 'tab';
      btn.dataset.view = panel.name;
      btn.textContent = panel.name;
      btn.addEventListener('click', () => togglePanel(panel.name));
      $('tabs').appendChild(btn);

      const container = document.createElement('div');
      container.className = 'panel-view';
      container.id = `panel-${panel.name}`;
      container.dataset.api = API;
      $('panel-area').appendChild(container);
      injectPanel(container, panel.html);
      loadedPanels.set(panel.name, container);
    }
  } catch {}
}

let activePanel = null;

function togglePanel(name) {
  if (activePanel === name) {
    $('panel-area').className = 'closed';
    $('tabs').querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'feed'));
    activePanel = null;
    return;
  }
  activePanel = name;
  $('panel-area').className = 'open';
  document.querySelectorAll('.panel-view').forEach(v => v.classList.toggle('active', v.id === `panel-${name}`));
  $('tabs').querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  if (LIVE_REFRESH_PANELS.has(name)) {
    refreshPanel(name).catch(() => {});
  }
}

function refreshActivePanel() {
  if (!activePanel || !LIVE_REFRESH_PANELS.has(activePanel)) return;
  refreshPanel(activePanel).catch(() => {});
}

function injectPanel(container, html) {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  const scripts = [];
  temp.querySelectorAll('script').forEach(s => { scripts.push(s.textContent); s.remove(); });
  container.innerHTML = temp.innerHTML;
  for (const code of scripts) {
    const s = document.createElement('script');
    s.textContent = code;
    container.appendChild(s);
  }
}

$('tabs').querySelector('[data-view="feed"]').addEventListener('click', () => {
  if (activePanel) {
    $('panel-area').className = 'closed';
    $('tabs').querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'feed'));
    activePanel = null;
  }
});

// =============================================================================
// Input handlers
// =============================================================================

$('send').addEventListener('click', feedSend);
$('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); feedSend(); }
});
$('input').addEventListener('input', () => {
  const el = $('input'); el.style.height = '36px';
  el.style.height = Math.min(el.scrollHeight, 150) + 'px';
});

$('branch-send').addEventListener('click', branchSend);
$('branch-text').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); branchSend(); }
});
$('branch-text').addEventListener('input', () => {
  const el = $('branch-text'); el.style.height = '36px';
  el.style.height = Math.min(el.scrollHeight, 150) + 'px';
});

$('branch-close').addEventListener('click', closeBranch);

// =============================================================================
// Init
// =============================================================================

loadHistory().then(() => {
  connectSSE();
  updateStatus();
  discoverPanels();
  setInterval(discoverPanels, 30000);
  setInterval(refreshActivePanel, 10000);
  setInterval(updateStatus, 10000);
});











































