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

  const children = document.createElement('div');
  children.className = 'feed-children';

  item.appendChild(row);
  item.appendChild(children);

  const parentEl = parentNodeId ? feedNodes.get(parentNodeId) : null;
  if (parentEl) {
    parentEl.querySelector(':scope > .feed-children').appendChild(item);
  } else {
    feedEl.appendChild(item);
  }

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

async function submitNewConversation(text) {
  const response = await fetch(`${API}/reef/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: text }),
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
}

async function submitConversationReply(conversationId, text) {
  const response = await fetch(`${API}/reef/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: text }),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `Failed to send reply`);
  ensureConversation(conversationId, { status: 'running', closed: false, lastActivityAt: Date.now(), leafId: data.nodeId });
}

function feedSend() {
  const input = $('branch-text');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  resizeInput('branch-text');
  submitNewConversation(text).catch((error) => {
    feedAdd(null, null, 'error', error.message);
  });
}

function branchSend() {
  if (!activeConversationId) {
    feedSend();
    return;
  }

  const conversation = conversations.get(activeConversationId);
  if (!conversation || conversation.working || conversation.closed) return;

  const input = $('branch-text');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  resizeInput('branch-text');
  submitConversationReply(activeConversationId, text).catch((error) => {
    feedAdd(null, null, 'error', error.message, { taskId: activeConversationId });
  });
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
      setTimeout(connectSSE, 3000);
    });
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
  setTimeout(connectSSE, 3000);
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
    const response = await fetch(`${API}/reef/state`);
    if (!response.ok) return;
    const data = await response.json();
    const parts = [`${data.services?.length || 0} svc`, `${conversations.size} chats`];
    if (data.activeTasks > 0) parts.push(`${data.activeTasks} active`);
    setStatus('ok', parts.join(' · '));
  } catch {}
}

// =============================================================================
// Panel discovery
// =============================================================================

const loadedPanels = new Map();
const LIVE_REFRESH_PANELS = new Set(['registry', 'vm-tree', 'lieutenant', 'commits']);
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

async function discoverPanels() {
  try {
    const response = await fetch(`${API}/services`);
    if (!response.ok) return;
    const data = await response.json();
    const services = data.modules || data.services || [];
    const results = await Promise.allSettled(services.filter((service) => service.name !== 'ui').map((service) => fetchPanel(service.name)));
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
// Input handlers
// =============================================================================

$('branch-send').addEventListener('click', branchSend);
$('branch-text').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    branchSend();
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
  discoverPanels();
  setInterval(discoverPanels, 30000);
  setInterval(refreshActivePanel, 10000);
  setInterval(updateStatus, 10000);
});
