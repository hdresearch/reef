// =============================================================================
// reef — persisted conversations + activity feed
// =============================================================================

const API = PANEL_API;

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function md(text) {
  if (!text) return '';
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _l, c) => `<pre><code>${esc(c.trimEnd())}</code></pre>`);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return text
    .split(/(<pre>[\s\S]*?<\/pre>)/g)
    .map((part) => (part.startsWith('<pre>') ? part : part.replace(/\n/g, '<br>')))
    .join('');
}

function timeStr(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const sec = Math.max(1, Math.floor(diff / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function taskLabel(status) {
  if (status === 'done') return 'done';
  if (status === 'error') return 'error';
  return 'running';
}

const $ = (id) => document.getElementById(id);

function autoScroll(el) {
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (nearBottom) requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}

function updateFeedScope() {
  const scope = $('feed-scope');
  const items = feedEl.querySelectorAll('.feed-item');
  if (!activeConversationId || !conversations.has(activeConversationId)) {
    scope.textContent = 'global reef activity';
    for (const item of items) item.classList.remove('hidden');
    return;
  }

  const conversation = conversations.get(activeConversationId);
  scope.textContent = `${conversation.title} activity`;

  for (const item of items) {
    const conversationId = item.dataset.conversationId || '';
    item.classList.toggle('hidden', Boolean(conversationId) && conversationId !== activeConversationId);
  }
}

function resizeInput(id) {
  const el = $(id);
  el.style.height = '36px';
  el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
}

// =============================================================================
// Feed
// =============================================================================

const feedEl = $('feed-entries');
const feedScroll = $('feed-scroll');
const feedNodes = new Map();

function feedAdd(nodeId, parentNodeId, tag, text, opts = {}) {
  const item = document.createElement('div');
  item.className = 'feed-item';
  if (nodeId) item.dataset.nodeId = nodeId;
  if (opts.taskId) item.dataset.taskId = opts.taskId;
  if (opts.taskId) item.dataset.conversationId = opts.taskId;

  const row = document.createElement('div');
  row.className = 'feed-row' + (opts.clickable ? ' clickable' : '');
  if (opts.clickable && opts.taskId) {
    row.addEventListener('click', () => selectConversation(opts.taskId));
  }

  const statusHtml = opts.status ? `<span class="feed-status">${opts.status}</span>` : '';
  row.innerHTML = `
    <span class="feed-time">${timeStr(opts.timestamp || Date.now())}</span>
    <span class="feed-tag ${tag}">${tag}</span>
    <span class="feed-text">${esc(text)}</span>
    ${statusHtml}
  `;

  item.appendChild(row);

  // Flat chronological list — always append to the root feed
  feedEl.appendChild(item);

  if (nodeId) feedNodes.set(nodeId, item);
  updateFeedScope();
  autoScroll(feedScroll);
  return item;
}

// =============================================================================
// Persisted conversations
// =============================================================================

const conversations = new Map();
let activeConversationId = null;

function ensureConversation(id, meta = {}) {
  if (!id) return null;
  if (!conversations.has(id)) {
    conversations.set(id, {
      id,
      title: meta.title || `conversation ${id}`,
      status: meta.status || 'done',
      closed: !!meta.closed,
      createdAt: meta.createdAt || Date.now(),
      lastActivityAt: meta.lastActivityAt || meta.createdAt || Date.now(),
      leafId: meta.leafId || null,
      messages: [],
      currentMsg: null,
      currentText: '',
      working: meta.status === 'running',
      loaded: false,
    });
  }

  const conversation = conversations.get(id);
  Object.assign(conversation, meta);
  if (typeof meta.closed === 'boolean') conversation.closed = meta.closed;
  if (meta.status) conversation.working = meta.status === 'running';
  if (!conversation.title) conversation.title = `conversation ${id}`;
  return conversation;
}

function sortedConversations() {
  return [...conversations.values()].sort((a, b) => {
    if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
    return a.id.localeCompare(b.id);
  });
}

function renderConversationList(listEl, items, emptyText) {
  listEl.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'conversation-empty';
    empty.textContent = emptyText;
    listEl.appendChild(empty);
    return;
  }

  for (const conversation of items) {
    const item = document.createElement('div');
    item.className = 'conversation-item' + (activeConversationId === conversation.id ? ' active' : '');
    item.addEventListener('click', () => selectConversation(conversation.id));

    const main = document.createElement('div');
    main.className = 'conversation-main';
    main.innerHTML = `
      <div class="conversation-title">${esc(conversation.title)}</div>
      <div class="conversation-meta">${esc(`${taskLabel(conversation.status)} · ${relativeTime(conversation.lastActivityAt)}`)}</div>
    `;

    const toggle = document.createElement('button');
    toggle.className = 'conversation-toggle';
    toggle.type = 'button';
    toggle.textContent = conversation.closed ? 'open' : 'close';
    toggle.addEventListener('click', async (event) => {
      event.stopPropagation();
      await setConversationClosed(conversation.id, !conversation.closed);
    });

    item.appendChild(main);
    item.appendChild(toggle);
    listEl.appendChild(item);
  }
}

function renderConversationLists() {
  const items = sortedConversations();
  renderConversationList(
    $('conversation-list-open'),
    items.filter((conversation) => !conversation.closed),
    'No open conversations.',
  );
  renderConversationList(
    $('conversation-list-closed'),
    items.filter((conversation) => conversation.closed),
    'No closed conversations.',
  );
}

function renderConversationHeader() {
  const label = $('branch-label');
  const meta = $('branch-meta');
  const toggle = $('branch-toggle');
  const empty = $('branch-empty');
  const input = $('branch-text');
  const send = $('branch-send');

  if (!activeConversationId || !conversations.has(activeConversationId)) {
    label.textContent = 'select a conversation';
    meta.textContent = '';
    toggle.hidden = true;
    empty.style.display = '';
    $('branch-messages').innerHTML = '';
    input.disabled = false;
    send.disabled = false;
    send.classList.remove('working');
    send.textContent = '↵';
    send.title = '';
    input.placeholder = 'Start a new conversation…';
    updateFeedScope();
    return;
  }

  const conversation = conversations.get(activeConversationId);
  label.textContent = conversation.title;
  meta.textContent = `${conversation.id} · ${taskLabel(conversation.status)} · ${relativeTime(conversation.lastActivityAt)}`;
  toggle.hidden = false;
  toggle.textContent = conversation.closed ? 'reopen' : 'close';
  empty.style.display = conversation.messages.length === 0 ? '' : 'none';
  input.disabled = conversation.closed;
  send.disabled = conversation.closed;
  if (conversation.working) {
    send.classList.add('working');
    send.textContent = '■';
    send.title = 'Stop agent';
  } else {
    send.classList.remove('working');
    send.textContent = '↵';
    send.title = '';
  }
  input.placeholder = conversation.closed ? 'Reopen this conversation to continue talking.' : 'Continue the conversation…';
  updateFeedScope();
}

function renderConversationMessages(conversationId) {
  const messagesEl = $('branch-messages');
  messagesEl.innerHTML = '';
  if (!conversationId || !conversations.has(conversationId)) {
    renderConversationHeader();
    return;
  }

  const conversation = conversations.get(conversationId);
  for (const message of conversation.messages) {
    messagesEl.appendChild(message);
  }
  renderConversationHeader();
  autoScroll($('branch-scroll'));
}

async function loadConversation(conversationId) {
  const response = await fetch(`${API}/reef/conversations/${conversationId}`);
  if (!response.ok) throw new Error(`Failed to load conversation ${conversationId}`);
  const data = await response.json();

  const conversation = ensureConversation(conversationId, data);
  conversation.messages = [];
  conversation.currentMsg = null;
  conversation.currentText = '';
  conversation.loaded = true;
  conversation.leafId = data.leafId || null;

  let currentAssistant = null;
  for (const node of data.nodes || []) {
    if (node.role === 'user') {
      currentAssistant = null;
      conversation.messages.push(createMessage('user', node.content));
      continue;
    }
    if (node.role === 'assistant') {
      currentAssistant = createMessage('assistant', node.content);
      conversation.messages.push(currentAssistant);
      continue;
    }
    if (node.role === 'tool_call') {
      if (!currentAssistant) {
        currentAssistant = createMessage('assistant', '');
        conversation.messages.push(currentAssistant);
      }
      appendToolCall(currentAssistant, node.toolName || node.content, node.id, node.toolParams);
      continue;
    }
    if (node.role === 'tool_result' && currentAssistant) {
      applyToolResult(currentAssistant, node.toolCallId || node.parentId || '', {
        content: [{ type: 'text', text: node.content }],
      });
    }
  }

  if (activeConversationId === conversationId) renderConversationMessages(conversationId);
  renderConversationLists();
  return conversation;
}

async function selectConversation(conversationId) {
  if (!conversationId) return;
  activeConversationId = conversationId;
  ensureConversation(conversationId);
  renderConversationLists();
  renderConversationHeader();
  if (!conversations.get(conversationId).loaded) {
    try {
      await loadConversation(conversationId);
    } catch (error) {
      console.error('loadConversation:', error);
    }
  } else {
    renderConversationMessages(conversationId);
  }
  $('branch-text').focus();
}

function deselectConversation() {
  activeConversationId = null;
  renderConversationLists();
  renderConversationHeader();
  $('branch-text').focus();
}

function createMessage(role, content) {
  const el = document.createElement('div');
  el.className = 'branch-msg';
  el.innerHTML = `
    <div class="branch-msg-role ${role}">${role === 'user' ? 'you' : role}</div>
    <div class="branch-msg-content">${role === 'user' ? esc(content) : md(content)}</div>
  `;
  return el;
}

function addConversationMessage(conversationId, role, content) {
  const conversation = ensureConversation(conversationId);
  if (!conversation) return null;

  const last = conversation.messages[conversation.messages.length - 1];
  if (last && last.dataset.role === role && last.dataset.rawContent === content) {
    return last;
  }

  const message = createMessage(role, content);
  message.dataset.role = role;
  message.dataset.rawContent = content;
  conversation.messages.push(message);
  if (activeConversationId === conversationId) {
    $('branch-empty').style.display = 'none';
    $('branch-messages').appendChild(message);
    autoScroll($('branch-scroll'));
  }
  return message;
}

function ensureStreamingAssistant(conversationId) {
  const conversation = ensureConversation(conversationId);
  if (!conversation) return null;
  if (!conversation.currentMsg) {
    conversation.currentMsg = addConversationMessage(conversationId, 'assistant', '');
    conversation.currentText = '';
  }
  return conversation.currentMsg;
}

function appendToolCall(messageEl, toolName, toolCallId, args) {
  const body = messageEl.querySelector('.branch-msg-content');
  const preview = args
    ? Object.entries(args).map(([, value]) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return text.length > 40 ? `${text.slice(0, 40)}…` : text;
      }).join(', ')
    : '';

  const tool = document.createElement('div');
  tool.className = 'branch-tool';
  tool.dataset.toolCallId = toolCallId || '';
  tool.innerHTML = `
    <div class="branch-tool-header">
      <span class="branch-tool-arrow">▶</span> ${esc(toolName)}(${esc(preview)})
    </div>
    <div class="branch-tool-body"></div>
  `;
  tool.querySelector('.branch-tool-header').addEventListener('click', () => {
    tool.querySelector('.branch-tool-arrow').classList.toggle('open');
    tool.querySelector('.branch-tool-body').classList.toggle('open');
  });
  body.appendChild(tool);
  return tool;
}

function applyToolResult(messageEl, toolCallId, result, isError) {
  const tool = messageEl.querySelector(`[data-tool-call-id="${toolCallId}"]`);
  if (!tool) return;
  const body = tool.querySelector('.branch-tool-body');
  const text = result?.content?.filter((item) => item.type === 'text').map((item) => item.text).join('') || '';
  if (text) {
    body.textContent = text.slice(-500);
    body.classList.add('open');
  }
  if (isError) body.style.color = 'var(--error)';
}

function streamConversationDelta(conversationId, delta) {
  const conversation = ensureConversation(conversationId);
  if (!conversation) return;
  const message = ensureStreamingAssistant(conversationId);
  if (!message) return;
  conversation.currentText += delta;
  const content = message.querySelector('.branch-msg-content');
  content.innerHTML = `${md(conversation.currentText)}<span class="cursor"></span>`;
  message.dataset.rawContent = conversation.currentText;
  if (activeConversationId === conversationId) autoScroll($('branch-scroll'));
}

function addConversationTool(conversationId, toolName, toolCallId, args) {
  const conversation = ensureConversation(conversationId);
  if (!conversation) return;
  const message = ensureStreamingAssistant(conversationId);
  if (!message) return;
  appendToolCall(message, toolName, toolCallId, args);
  if (activeConversationId === conversationId) autoScroll($('branch-scroll'));
}

function updateConversationTool(conversationId, toolCallId, result, isError) {
  const conversation = conversations.get(conversationId);
  if (!conversation || !conversation.currentMsg) return;
  applyToolResult(conversation.currentMsg, toolCallId, result, isError);
}

function finishConversation(conversationId, fallbackSummary) {
  const conversation = conversations.get(conversationId);
  if (!conversation) return;
  if (conversation.currentMsg) {
    const content = conversation.currentMsg.querySelector('.branch-msg-content');
    const finalText = conversation.currentText || fallbackSummary || '';
    content.innerHTML = md(finalText);
    conversation.currentMsg.dataset.rawContent = finalText;
    conversation.currentMsg = null;
    conversation.currentText = '';
  } else if (fallbackSummary) {
    addConversationMessage(conversationId, 'assistant', fallbackSummary);
  }
  conversation.working = false;
}

async function setConversationClosed(conversationId, closed) {
  const action = closed ? 'close' : 'open';
  const response = await fetch(`${API}/reef/conversations/${conversationId}/${action}`, { method: 'POST' });
  if (!response.ok) throw new Error(`Failed to ${action} conversation`);
  const data = await response.json();
  ensureConversation(conversationId, data);
  renderConversationLists();
  renderConversationHeader();
}

// =============================================================================
// Send
// =============================================================================

async function submitNewConversation(text, attachments = []) {
  const body = { task: text };
  if (attachments.length > 0) body.attachments = attachments;
  const response = await fetch(`${API}/reef/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `Failed to create conversation`);
  ensureConversation(data.id, {
    title: data.title || text,
    status: 'running',
    closed: false,
    lastActivityAt: Date.now(),
    leafId: data.nodeId,
  });
  await selectConversation(data.id);
  syncConversationList();
}

async function submitConversationReply(conversationId, text, attachments = []) {
  addConversationMessage(conversationId, 'user', text);
  const body = { task: text };
  if (attachments.length > 0) body.attachments = attachments;
  const response = await fetch(`${API}/reef/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `Failed to send reply`);
  ensureConversation(conversationId, { status: 'running', closed: false, lastActivityAt: Date.now(), leafId: data.nodeId });
  renderConversationLists();
  renderConversationHeader();
}

async function feedSend() {
  const input = $('branch-text');
  const text = input.value.trim();
  if (!text && pendingFiles.length === 0) return;
  input.value = '';
  resizeInput('branch-text');
  try {
    const { prompt, attachments } = await uploadAndBuildPrompt(text);
    await submitNewConversation(prompt, attachments);
  } catch (error) {
    feedAdd(null, null, 'error', error.message);
  }
}

async function branchSend() {
  if (!activeConversationId) {
    feedSend();
    return;
  }

  const conversation = conversations.get(activeConversationId);
  if (!conversation || conversation.working || conversation.closed) return;

  const input = $('branch-text');
  const text = input.value.trim();
  if (!text && pendingFiles.length === 0) return;
  input.value = '';
  resizeInput('branch-text');
  try {
    const { prompt, attachments } = await uploadAndBuildPrompt(text);
    await submitConversationReply(activeConversationId, prompt, attachments);
  } catch (error) {
    feedAdd(null, null, 'error', error.message, { taskId: activeConversationId });
  }
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
    .then((response) => {
      if (!response.ok) throw new Error(`${response.status}`);
      readSSE(response.body.getReader());
    })
    .catch(() => {
      sseConnected = false;
      setStatus('err', 'disconnected');
      setTimeout(reconnectSSE, 3000);
    });
}

function reconnectSSE() {
  // Catch up on any state changes that happened while disconnected
  syncConversationList();
  updateStatus();
  if (activePanel && LIVE_REFRESH_PANELS.has(activePanel)) {
    refreshPanel(activePanel).catch(() => {});
  }
  connectSSE();
}

async function readSSE(reader) {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          handleEvent(JSON.parse(line.slice(6)));
        } catch {}
      }
    }
  } catch {}

  sseConnected = false;
  setStatus('err', 'disconnected');
  setTimeout(reconnectSSE, 3000);
}

function handleEvent(event) {
  const conversationId = event.conversationId || event.taskId || '';
  const nodeId = event.nodeId || null;
  const parentId = event.parentId || null;

  switch (event.type) {
    case 'task_started': {
      ensureConversation(conversationId, {
        title: conversations.get(conversationId)?.title || event.prompt || conversationId,
        status: 'running',
        closed: false,
        lastActivityAt: Date.now(),
        leafId: nodeId,
      });

      feedAdd(nodeId, parentId, 'task', (event.prompt || '').slice(0, 80), {
        taskId: conversationId,
        clickable: true,
        status: '⏳',
      });

      addConversationMessage(conversationId, 'user', event.prompt || '');
      if (!activeConversationId) {
        selectConversation(conversationId).catch(() => {});
      } else {
        renderConversationLists();
        renderConversationHeader();
      }
      break;
    }

    case 'task_done': {
      const conversation = ensureConversation(conversationId, {
        status: 'done',
        lastActivityAt: Date.now(),
        leafId: nodeId,
      });

      feedAdd(nodeId, parentId, 'done', (event.summary || 'done').slice(0, 80), { taskId: conversationId });
      const taskItem = feedEl.querySelector(`[data-task-id="${conversationId}"] .feed-status`);
      if (taskItem) taskItem.textContent = '✓';

      finishConversation(conversationId, event.summary || '');
      conversation.leafId = nodeId;
      renderConversationLists();
      renderConversationHeader();
      updateStatus();
      break;
    }

    case 'task_error': {
      ensureConversation(conversationId, {
        status: 'error',
        lastActivityAt: Date.now(),
      });

      feedAdd(null, parentId, 'error', (event.error || 'failed').slice(0, 80), { taskId: conversationId });
      const taskItem = feedEl.querySelector(`[data-task-id="${conversationId}"] .feed-status`);
      if (taskItem) taskItem.textContent = '✗';

      finishConversation(conversationId, event.error || '');
      renderConversationLists();
      renderConversationHeader();
      updateStatus();
      break;
    }

    case 'message_update': {
      const message = event.assistantMessageEvent;
      if (message?.type === 'text_delta') streamConversationDelta(conversationId, message.delta);
      break;
    }

    case 'tool_execution_start': {
      const preview = event.args
        ? Object.entries(event.args).map(([, value]) => {
            const text = typeof value === 'string' ? value : JSON.stringify(value);
            return text.length > 30 ? `${text.slice(0, 30)}…` : text;
          }).join(', ')
        : '';
      feedAdd(nodeId, parentId, 'tool', `${event.toolName}(${preview})`, { taskId: conversationId });
      addConversationTool(conversationId, event.toolName, event.toolCallId, event.args);
      break;
    }

    case 'tool_execution_end': {
      const resultText =
        event.result?.content?.filter((item) => item.type === 'text').map((item) => item.text).join('') || '';
      if (resultText && nodeId) {
        feedAdd(nodeId, parentId, event.isError ? 'error' : 'result', resultText.slice(0, 60));
      }
      updateConversationTool(conversationId, event.toolCallId, event.result, event.isError);
      break;
    }

    case 'service_reload':
    case 'service_unload':
    case 'service_deploy':
      feedAdd(nodeId, parentId, 'system', `${event.type.replace('service_', '')} ${event.name || ''}`);
      discoverPanels();
      break;

    case 'cron_start':
      feedAdd(nodeId, parentId, 'cron', `${event.jobName} (${event.jobType || 'exec'})`);
      break;
    case 'cron_done':
      feedAdd(nodeId, parentId, 'done', (event.output || 'ok').slice(0, 80));
      break;
    case 'cron_error':
      feedAdd(nodeId, parentId, 'error', (event.error || 'failed').slice(0, 80));
      break;
  }
}

// =============================================================================
// History
// =============================================================================

async function loadConversationList() {
  try {
    const response = await fetch(`${API}/reef/conversations?includeClosed=true`);
    if (!response.ok) return;
    const data = await response.json();
    for (const conversation of data.conversations || []) {
      ensureConversation(conversation.id, conversation);
    }
    renderConversationLists();

    const firstOpen = sortedConversations().find((conversation) => !conversation.closed) || sortedConversations()[0];
    if (firstOpen) await selectConversation(firstOpen.id);
    else renderConversationHeader();
  } catch (error) {
    console.error('loadConversationList:', error);
  }
}

// Lightweight sync — refetch conversation list from server without changing selection
async function syncConversationList() {
  try {
    const response = await fetch(`${API}/reef/conversations?includeClosed=true`);
    if (!response.ok) return;
    const data = await response.json();
    for (const conversation of data.conversations || []) {
      ensureConversation(conversation.id, conversation);
    }
    renderConversationLists();
    renderConversationHeader();
  } catch {}
}

async function loadFeedHistory() {
  try {
    const response = await fetch(`${API}/reef/tree`);
    if (!response.ok) return;
    const data = await response.json();
    const nodes = data.nodes || {};
    const refs = data.refs || {};
    const taskData = data.tasks || {};

    const childrenOf = {};
    for (const [nodeId, node] of Object.entries(nodes)) {
      if (node.parentId) {
        (childrenOf[node.parentId] = childrenOf[node.parentId] || []).push(nodeId);
      }
    }
    for (const children of Object.values(childrenOf)) {
      children.sort((a, b) => (nodes[a]?.timestamp || 0) - (nodes[b]?.timestamp || 0));
    }

    function renderNode(nodeId) {
      const node = nodes[nodeId];
      if (!node) return;
      if (node.role === 'system') {
        for (const childId of childrenOf[nodeId] || []) renderNode(childId);
        return;
      }

      const tag = nodeTag(node);
      const text = nodeText(node);
      if (tag) {
        const opts = { timestamp: node.timestamp, nodeId };
        const taskName = Object.entries(taskData).find(([name]) => {
          const leaf = refs[name];
          if (!leaf) return false;
          let current = leaf;
          const seen = new Set();
          while (current && nodes[current] && !seen.has(current)) {
            seen.add(current);
            if (current === nodeId) return true;
            current = nodes[current].parentId;
          }
          return false;
        })?.[0];

        if (taskName) {
          opts.taskId = taskName;
          opts.clickable = true;
          const info = taskData[taskName];
          if (node.role === 'user' && info?.trigger === node.content) {
            opts.status = info.status === 'done' ? '✓' : info.status === 'error' ? '✗' : '⏳';
          }
        }

        feedAdd(nodeId, node.parentId, tag, text, opts);
      }

      for (const childId of childrenOf[nodeId] || []) renderNode(childId);
    }

    function nodeTag(node) {
      if (node.role === 'user') return 'task';
      if (node.role === 'assistant') return 'done';
      if (node.role === 'tool_call') return 'tool';
      if (node.role === 'tool_result') return 'result';
      if (node.role === 'event') {
        const eventType = node.eventType || 'event';
        if (eventType === 'cron_start') return 'cron';
        if (eventType === 'cron_done') return 'done';
        if (eventType === 'cron_error') return 'error';
        return 'system';
      }
      return null;
    }

    function nodeText(node) {
      if (node.role === 'user' || node.role === 'assistant') {
        return node.content.length > 80 ? `${node.content.slice(0, 80)}…` : node.content;
      }
      if (node.role === 'tool_call') {
        const args = node.toolParams ? JSON.stringify(node.toolParams).slice(0, 40) : '';
        return `${node.toolName || node.content}(${args})`;
      }
      if (node.role === 'tool_result') return node.content.slice(0, 60);
      if (node.role === 'event') {
        if (node.eventType === 'cron_start') return `${node.content} (${node.meta?.jobType || 'exec'})`;
        return node.content;
      }
      return node.content;
    }

    if (data.root) renderNode(data.root);
  } catch (error) {
    console.error('loadFeedHistory:', error);
  }
}

// =============================================================================
// Status
// =============================================================================

function setStatus(state, text) {
  const el = $('status');
  el.className = `status ${state}`;
  el.querySelector('.label').textContent = text;
}

async function updateStatus() {
  try {
    const [stateRes, vmsRes, ltsRes, sessionRes] = await Promise.all([
      fetch(`${API}/reef/state`),
      fetch(`${API}/registry/vms`).catch(() => null),
      fetch(`${API}/lieutenant/lieutenants`).catch(() => null),
      fetch('/ui/session').catch(() => null),
    ]);

    if (!stateRes.ok) return;
    const data = await stateRes.json();

    let vmCount = 1; // root reef VM is always running
    if (vmsRes?.ok) {
      const vmsData = await vmsRes.json();
      vmCount = Math.max(1, vmsData.count || 0);
    }

    let ltCount = 0;
    if (ltsRes?.ok) {
      const ltsData = await ltsRes.json();
      ltCount = (ltsData.lieutenants || ltsData.data || []).length;
    }

    let sessionExpiry = null;
    if (sessionRes?.ok) {
      const sessionData = await sessionRes.json().catch(() => null);
      if (sessionData?.authenticated && sessionData.expiresAt) {
        sessionExpiry = sessionData.expiresAt;
      }
    }

    const chatCount = data.conversations || conversations.size;
    const parts = ['vers.sh'];
    parts.push(`${vmCount} VM${vmCount !== 1 ? 's' : ''}`);
    if (ltCount > 0) parts.push(`${ltCount} lt`);
    parts.push(`${chatCount} chats`);
    if (data.activeTasks > 0) parts.push(`${data.activeTasks} active`);
    if (sessionExpiry) {
      const ms = new Date(sessionExpiry).getTime() - Date.now();
      const days = Math.floor(ms / (24 * 60 * 60 * 1000));
      const hrs = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
      const mins = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
      const timeParts = [];
      if (days > 0) timeParts.push(`${days}d`);
      if (hrs > 0) timeParts.push(`${hrs}h`);
      timeParts.push(`${mins}m`);
      parts.push(`${timeParts.join(' ')} left`);
    }
    setStatus('ok', parts.join(' · '));
  } catch {}
}

// =============================================================================
// Panel discovery
// =============================================================================

const loadedPanels = new Map();
const LIVE_REFRESH_PANELS = new Set(['registry', 'vm-tree', 'lieutenant', 'commits', 'store', 'installer', 'signals', 'logs', 'swarm', 'cron']);
let activePanel = null;

async function fetchPanel(name) {
  const response = await fetch(`${API}/${name}/_panel`);
  if (!response.ok) return null;
  if (!(response.headers.get('content-type') || '').includes('html')) return null;
  return { name, html: await response.text() };
}

async function refreshPanel(name) {
  if (!loadedPanels.has(name)) return;
  const panel = await fetchPanel(name);
  if (!panel) return;
  injectPanel(loadedPanels.get(name), panel.html);
}

async function loadProfilePanel() {
  if (loadedPanels.has('profile')) return;
  try {
    const response = await fetch(`${API}/reef/profile/_panel`);
    if (!response.ok) return;
    if (!(response.headers.get('content-type') || '').includes('html')) return;
    const html = await response.text();

    const button = document.createElement('button');
    button.className = 'tab';
    button.dataset.view = 'profile';
    button.textContent = 'profile';
    button.addEventListener('click', () => togglePanel('profile'));
    $('tabs').appendChild(button);

    const container = document.createElement('div');
    container.className = 'panel-view';
    container.id = 'panel-profile';
    container.dataset.api = API;
    $('panel-area').appendChild(container);
    injectPanel(container, html);
    loadedPanels.set('profile', container);
  } catch {}
}

async function discoverPanels() {
  try {
    const response = await fetch(`${API}/services`);
    if (!response.ok) return;
    const data = await response.json();
    const services = data.modules || data.services || [];
    const SKIP_PANELS = new Set(['ui', 'agent-context', 'bootloader', 'vers-config', 'installer']);
    const results = await Promise.allSettled(services.filter((service) => !SKIP_PANELS.has(service.name)).map((service) => fetchPanel(service.name)));
    const panels = results.filter((result) => result.status === 'fulfilled' && result.value).map((result) => result.value);

    for (const panel of panels) {
      if (loadedPanels.has(panel.name) || panel.name === 'feed') continue;

      const button = document.createElement('button');
      button.className = 'tab';
      button.dataset.view = panel.name;
      button.textContent = panel.name;
      button.addEventListener('click', () => togglePanel(panel.name));
      $('tabs').appendChild(button);

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

function togglePanel(name) {
  if (activePanel === name) {
    $('panel-area').className = 'closed';
    $('tabs').querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === 'feed'));
    activePanel = null;
    return;
  }
  activePanel = name;
  $('panel-area').className = 'open';
  document.querySelectorAll('.panel-view').forEach((view) => view.classList.toggle('active', view.id === `panel-${name}`));
  $('tabs').querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
  // Always refresh immediately when switching to a live panel
  if (LIVE_REFRESH_PANELS.has(name)) refreshPanel(name).catch(() => {});
}

function refreshActivePanel() {
  if (!activePanel || !LIVE_REFRESH_PANELS.has(activePanel)) return;
  refreshPanel(activePanel).catch(() => {});
}

function injectPanel(container, html) {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  const scripts = [];
  temp.querySelectorAll('script').forEach((script) => {
    scripts.push(script.textContent);
    script.remove();
  });
  container.innerHTML = temp.innerHTML;
  for (const code of scripts) {
    const script = document.createElement('script');
    script.textContent = code;
    container.appendChild(script);
  }
}

$('tabs').querySelector('[data-view="feed"]').addEventListener('click', () => {
  if (!activePanel) return;
  $('panel-area').className = 'closed';
  $('tabs').querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === 'feed'));
  activePanel = null;
});

// =============================================================================
// File attachments
// =============================================================================

const pendingFiles = [];

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function renderAttachments() {
  const el = $('branch-attachments');
  el.innerHTML = '';
  for (let i = 0; i < pendingFiles.length; i++) {
    const file = pendingFiles[i];
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.innerHTML = `
      <span>${esc(file.name)}</span>
      <span class="size">${formatSize(file.size)}</span>
      <button class="attachment-remove" data-index="${i}" type="button">✕</button>
    `;
    chip.querySelector('.attachment-remove').addEventListener('click', () => {
      pendingFiles.splice(i, 1);
      renderAttachments();
    });
    el.appendChild(chip);
  }
}

async function addFiles(fileList) {
  const totalNewBytes = Array.from(fileList).reduce((sum, f) => sum + f.size, 0);
  const totalNewMib = Math.ceil(totalNewBytes / (1024 * 1024));

  // Check available disk space
  try {
    const res = await fetch(`${API}/reef/disk`);
    if (res.ok) {
      const disk = await res.json();
      if (totalNewMib >= disk.availMib) {
        showResizeDialog(disk, totalNewMib, fileList);
        return;
      }
    }
  } catch {}

  for (const file of fileList) {
    pendingFiles.push(file);
  }
  renderAttachments();
}

function showResizeDialog(disk, neededMib, fileList) {
  const currentTotal = disk.totalMib;
  const minNeeded = currentTotal + neededMib + 100; // 100 MiB buffer
  const options = [
    Math.ceil(minNeeded / 1024) * 1024,                    // round up to nearest GB
    Math.ceil(minNeeded / 1024) * 1024 + 2048,             // +2 GB extra
    Math.ceil(minNeeded / 1024) * 1024 + 5120,             // +5 GB extra
  ];

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:100;display:flex;align-items:center;justify-content:center';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:20px;max-width:420px;font-family:monospace;font-size:13px;color:#ccc';

  dialog.innerHTML = `
    <div style="color:#f55;font-weight:600;margin-bottom:12px">Not enough disk space</div>
    <div style="margin-bottom:8px">
      File${fileList.length > 1 ? 's' : ''} need ~${neededMib} MiB but only ${disk.availMib} MiB available
      (${disk.usedMib} / ${disk.totalMib} MiB used).
    </div>
    <div style="color:#888;margin-bottom:12px;font-size:11px">
      Resizing the disk will increase your Vers billing.
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">
      ${options.map((size, i) => `
        <button class="resize-option" data-size="${size}" style="
          background:#111;border:1px solid #333;color:#ccc;padding:8px 12px;
          border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;text-align:left;
        ">
          ${(size / 1024).toFixed(1)} GB (${size} MiB)
          ${i === 0 ? ' — minimum' : i === 1 ? ' — comfortable' : ' — generous'}
        </button>
      `).join('')}
    </div>
    <button id="resize-cancel" style="
      background:none;border:1px solid #333;color:#888;padding:6px 12px;
      border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px;
    ">Cancel</button>
    <div id="resize-status" style="color:#4f9;font-size:11px;margin-top:8px;min-height:16px"></div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  dialog.querySelector('#resize-cancel').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });

  dialog.querySelectorAll('.resize-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const size = parseInt(btn.dataset.size, 10);
      const statusEl = dialog.querySelector('#resize-status');
      statusEl.textContent = 'Resizing disk...';
      statusEl.style.color = '#4f9';

      // Disable all buttons
      dialog.querySelectorAll('button').forEach((b) => { b.disabled = true; b.style.opacity = '0.5'; });

      try {
        const res = await fetch(`${API}/reef/disk/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fs_size_mib: size }),
        });

        if (res.ok) {
          statusEl.textContent = `Resized to ${(size / 1024).toFixed(1)} GB. Adding files...`;
          setTimeout(() => {
            document.body.removeChild(overlay);
            for (const file of fileList) {
              pendingFiles.push(file);
            }
            renderAttachments();
          }, 1000);
        } else {
          const err = await res.json().catch(() => ({}));
          statusEl.textContent = err.error || 'Resize failed';
          statusEl.style.color = '#f55';
          dialog.querySelectorAll('button').forEach((b) => { b.disabled = false; b.style.opacity = '1'; });
        }
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.style.color = '#f55';
        dialog.querySelectorAll('button').forEach((b) => { b.disabled = false; b.style.opacity = '1'; });
      }
    });
  });
}

async function uploadAndBuildPrompt(text) {
  if (pendingFiles.length === 0) return { prompt: text, attachments: [] };

  // Upload files to the reef VM
  const formData = new FormData();
  for (const file of pendingFiles) {
    formData.append('file', file);
  }

  let uploaded = [];
  try {
    const res = await fetch(`${API}/reef/upload`, { method: 'POST', body: formData });
    if (res.ok) {
      const data = await res.json();
      uploaded = data.files || [];
    }
  } catch {}

  // Build prompt text and collect attachment metadata
  const parts = [text];
  const attachments = [];
  for (let i = 0; i < pendingFiles.length; i++) {
    const file = pendingFiles[i];
    const uploadInfo = uploaded[i];
    const path = uploadInfo?.path || file.name;
    const url = uploadInfo?.url || null;
    const location = url ? `url: ${url}, local: ${path}` : `saved to ${path}`;
    const mimeType = file.type || null;

    // Images: add as attachment for multimodal, plus text reference
    if (mimeType?.startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(file.name)) {
      attachments.push({ path, name: file.name, mimeType: mimeType || 'image/png' });
      parts.push(`\n\n--- Image: ${file.name} (${location}, ${formatSize(file.size)}) ---`);
    } else if (file.type.startsWith('text/') || /\.(txt|md|json|js|ts|py|sh|css|html|yaml|yml|toml|csv|xml|sql|rs|go|rb|java|c|cpp|h)$/i.test(file.name)) {
      try {
        const content = await file.text();
        parts.push(`\n\n--- File: ${file.name} (${location}) ---\n${content}`);
      } catch {
        parts.push(`\n\n--- File: ${file.name} (${location}, ${formatSize(file.size)}) ---`);
      }
    } else {
      parts.push(`\n\n--- File: ${file.name} (${location}, ${formatSize(file.size)}) ---`);
    }
  }

  pendingFiles.length = 0;
  renderAttachments();
  return { prompt: parts.join(''), attachments };
}

// Drag and drop
const branchEl = $('branch');
let dragCounter = 0;

branchEl.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  branchEl.classList.add('drag-over');
});

branchEl.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    branchEl.classList.remove('drag-over');
  }
});

branchEl.addEventListener('dragover', (e) => {
  e.preventDefault();
});

branchEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  branchEl.classList.remove('drag-over');
  if (e.dataTransfer?.files?.length) {
    addFiles(e.dataTransfer.files);
  }
});

// Attach button
$('branch-attach').addEventListener('click', () => {
  $('branch-file').click();
});

$('branch-file').addEventListener('change', async (e) => {
  if (e.target.files?.length) {
    const files = Array.from(e.target.files);
    e.target.value = '';
    await addFiles(files);
  }
});

// =============================================================================
// Input handlers
// =============================================================================

$('branch-send').addEventListener('click', async () => {
  if (activeConversationId) {
    const conversation = conversations.get(activeConversationId);
    if (conversation?.working) {
      await stopActiveConversation();
      return;
    }
  }
  branchSend();
});
async function stopActiveConversation() {
  if (!activeConversationId) return;
  const conversation = conversations.get(activeConversationId);
  if (!conversation?.working) return;
  try {
    await fetch(`${API}/reef/conversations/${activeConversationId}/stop`, { method: 'POST' });
  } catch {}
  $('branch-text').focus();
}

$('branch-text').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    stopActiveConversation();
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    branchSend();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    stopActiveConversation();
  }
});
$('branch-text').addEventListener('input', () => resizeInput('branch-text'));

$('branch-close').addEventListener('click', deselectConversation);
$('branch-toggle').addEventListener('click', () => {
  if (!activeConversationId) return;
  const conversation = conversations.get(activeConversationId);
  if (!conversation) return;
  setConversationClosed(activeConversationId, !conversation.closed).catch((error) => {
    console.error(error);
  });
});

$('new-chat').addEventListener('click', () => {
  deselectConversation();
});

// =============================================================================
// Init
// =============================================================================

Promise.all([loadConversationList(), loadFeedHistory()]).then(() => {
  connectSSE();
  updateStatus();
  loadProfilePanel();
  discoverPanels();
  setInterval(discoverPanels, 30000);
  setInterval(refreshActivePanel, 10000);
  setInterval(updateStatus, 10000);
  // Periodically sync conversation list to catch changes from other clients
  setInterval(syncConversationList, 15000);
});
