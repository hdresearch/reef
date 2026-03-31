/**
 * Logs service — operational trace for all agents.
 *
 * Captures tool calls, errors, decisions, and state changes.
 * Logs live on root's SQLite (logs table in fleet.sqlite), so they
 * survive VM crashes and are available for handoff and debugging.
 *
 * Tools (2):
 *   reef_log  — write a structured log entry
 *   reef_logs — read logs (own or another agent's)
 *
 * Auto-logging: RPC event stream is tapped by a behavior to
 * automatically log tool_call and tool_result events.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import type { FleetClient, RouteDocs, ServiceContext, ServiceModule } from "../../src/core/types.js";
import type { VMNode, VMTreeStore } from "../vm-tree/store.js";

let vmTreeStore: VMTreeStore | null = null;

type RequestActor = {
  agentName: string | null;
  vmId: string | null;
  category: string | null;
  vm: VMNode | null;
};

function resolveRequestActor(req: Request): RequestActor {
  const agentName = req.headers.get("X-Reef-Agent-Name");
  const vmId = req.headers.get("X-Reef-VM-ID");
  const category = req.headers.get("X-Reef-Category");
  const vm = vmId
    ? vmTreeStore?.getVM(vmId) || null
    : agentName
      ? vmTreeStore?.getVMByName(agentName, { activeOnly: true }) || null
      : null;
  return { agentName, vmId, category, vm };
}

function isOperatorRequest(actor: RequestActor): boolean {
  return !actor.agentName && !actor.vmId;
}

function isRootActor(actor: RequestActor): boolean {
  return !!actor.vm && actor.vm.category === "infra_vm" && !actor.vm.parentId;
}

function requestIdentityError(actor: RequestActor): string | null {
  if (isOperatorRequest(actor)) return null;
  if (!actor.vm) return "requesting agent is not registered in vm-tree";
  if (actor.agentName && actor.vm.name !== actor.agentName) {
    return `request agent mismatch: header agent "${actor.agentName}" does not match vm-tree name "${actor.vm.name}"`;
  }
  if (actor.vmId && actor.vm.vmId !== actor.vmId) {
    return `request VM mismatch: header VM "${actor.vmId}" does not match vm-tree VM "${actor.vm.vmId}"`;
  }
  return null;
}

function canReadTargetLogs(actor: RequestActor, target: VMNode): boolean {
  if (isOperatorRequest(actor) || isRootActor(actor)) return true;
  if (!actor.vm) return false;
  if (target.vmId === actor.vm.vmId) return true;
  if (actor.vm.parentId === target.vmId) return true;
  if (actor.vm.parentId && target.parentId && actor.vm.parentId === target.parentId) return true;
  return (
    vmTreeStore?.descendants(actor.vm.vmId, { includeHistory: true }).some((vm) => vm.vmId === target.vmId) || false
  );
}

// =============================================================================
// Routes
// =============================================================================

const routes = new Hono();

// POST / — write a log entry
routes.post("/", async (c) => {
  if (!vmTreeStore) return c.json({ error: "vm-tree store not available" }, 503);

  try {
    const body = await c.req.json();
    const { agentId, agentName, level, category, message, metadata } = body;

    if (!agentName || !message) {
      return c.json({ error: "agentName and message are required" }, 400);
    }

    const entry = vmTreeStore.insertLog({
      agentId: agentId || "unknown",
      agentName,
      level: level || "info",
      category: category || undefined,
      message,
      metadata: metadata || undefined,
    });

    return c.json(entry, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET / — query logs
routes.get("/", (c) => {
  if (!vmTreeStore) return c.json({ error: "vm-tree store not available" }, 503);

  const actor = resolveRequestActor(c.req.raw);
  const identityError = requestIdentityError(actor);
  if (identityError) {
    return c.json({ error: identityError }, 403);
  }

  const requestedAgentName = c.req.query("agent");
  const requestedAgentId = c.req.query("agentId");
  const level = c.req.query("level");
  const category = c.req.query("category");
  const q = c.req.query("q");
  const since = c.req.query("since");
  const until = c.req.query("until");
  const limit = c.req.query("limit");
  const offset = c.req.query("offset");

  let agentName = requestedAgentName || undefined;
  let agentId = requestedAgentId || undefined;

  if (!isOperatorRequest(actor) && !isRootActor(actor)) {
    if (!agentName && !agentId) {
      agentName = actor.vm?.name || actor.agentName || undefined;
      agentId = actor.vm?.vmId || actor.vmId || undefined;
    }

    const target =
      (agentId ? vmTreeStore.getVM(agentId) : null) ||
      (agentName ? vmTreeStore.getVMByName(agentName, { activeOnly: false }) : null) ||
      null;

    if (!target) {
      return c.json({ error: "target agent is not registered in vm-tree" }, 404);
    }

    if (!canReadTargetLogs(actor, target)) {
      return c.json({ error: `log access to "${target.name}" is outside the requester's scope` }, 403);
    }

    agentName = target.name;
    agentId = target.vmId;
  }

  const logs = vmTreeStore.queryLogs({
    agentName: agentName || undefined,
    agentId: agentId || undefined,
    level: level || undefined,
    category: category || undefined,
    q: q || undefined,
    since: since ? Number.parseInt(since, 10) : undefined,
    until: until ? Number.parseInt(until, 10) : undefined,
    limit: limit ? Number.parseInt(limit, 10) : undefined,
    offset: offset ? Number.parseInt(offset, 10) : undefined,
  });
  const totalCount = vmTreeStore.countLogs({
    agentName: agentName || undefined,
    agentId: agentId || undefined,
    level: level || undefined,
    category: category || undefined,
    q: q || undefined,
    since: since ? Number.parseInt(since, 10) : undefined,
    until: until ? Number.parseInt(until, 10) : undefined,
  });

  return c.json({ logs, count: logs.length, totalCount });
});

// GET /_panel — debug view
routes.get("/_panel", (c) => {
  if (!vmTreeStore) {
    return c.html('<div style="font-family:monospace;color:#888">Logs service not initialized</div>');
  }

  return c.html(`
		<div class="logs-panel">
			<style>
				.logs-panel {
					font-family: monospace;
					font-size: 13px;
					color: #ccc;
					display: flex;
					flex-direction: column;
					gap: 12px;
					min-height: 0;
				}
				.logs-panel-header {
					display: flex;
					align-items: end;
					justify-content: space-between;
					gap: 12px;
					flex-wrap: wrap;
				}
				.logs-panel-title {
					color: #ddd;
					font-size: 12px;
				}
				.logs-panel-summary,
				.logs-panel-note,
				.logs-panel-filter-summary {
					color: #888;
					font-size: 11px;
				}
				.logs-panel-note {
					max-width: 34ch;
				}
				.logs-panel-form {
					display: flex;
					flex-direction: column;
					gap: 10px;
				}
				.logs-panel-search-row,
				.logs-panel-action-row,
				.logs-panel-filter-grid,
				.logs-panel-filter-chips,
				.logs-panel-cards {
					display: grid;
					gap: 8px;
				}
				.logs-panel-search-row {
					grid-template-columns: minmax(0, 1fr) auto auto;
					align-items: end;
				}
				.logs-panel-filter-grid {
					grid-template-columns: repeat(2, minmax(0, 1fr));
				}
				.logs-panel-field {
					display: flex;
					flex-direction: column;
					gap: 4px;
					color: #888;
					font-size: 10px;
					text-transform: uppercase;
					letter-spacing: 0.5px;
					min-width: 0;
				}
				.logs-panel-field input,
				.logs-panel-field select {
					background: #111;
					border: 1px solid #333;
					color: #ddd;
					padding: 8px 10px;
					border-radius: 8px;
					font: inherit;
					min-width: 0;
				}
				.logs-panel-btn {
					padding: 8px 12px;
					border-radius: 8px;
					font: inherit;
					cursor: pointer;
					border: 1px solid #333;
					background: #111;
					color: #bbb;
				}
				.logs-panel-btn.primary {
					background: #16213e;
					border-color: #2c4f7a;
					color: #d9f6ff;
				}
				.logs-panel-details {
					border: 1px solid #222;
					border-radius: 10px;
					background: #0d0d0d;
					overflow: hidden;
				}
				.logs-panel-details summary {
					list-style: none;
					cursor: pointer;
					padding: 10px 12px;
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 12px;
				}
				.logs-panel-details summary::-webkit-details-marker {
					display: none;
				}
				.logs-panel-details[open] summary {
					border-bottom: 1px solid #1e1e1e;
				}
				.logs-panel-details-body {
					padding: 10px 12px 12px;
					display: flex;
					flex-direction: column;
					gap: 10px;
				}
				.logs-panel-filter-chips {
					grid-template-columns: repeat(auto-fit, minmax(110px, max-content));
				}
				.logs-panel-chip {
					display: inline-flex;
					align-items: center;
					padding: 4px 8px;
					border-radius: 999px;
					border: 1px solid #2a2a2a;
					background: #121212;
					color: #a7a7a7;
					font-size: 10px;
					max-width: 100%;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
				.logs-panel-results {
					min-height: 0;
					border: 1px solid #222;
					border-radius: 10px;
					background: #0c0c0c;
					overflow: hidden;
				}
				.logs-panel-table-wrap {
					min-height: 0;
					overflow: auto;
				}
				.logs-panel-table {
					width: 100%;
					border-collapse: collapse;
				}
				.logs-panel-table-head {
					position: sticky;
					top: 0;
					background: #101010;
					z-index: 1;
				}
				.logs-panel-table-head tr {
					color: #666;
					font-size: 11px;
					text-align: left;
					border-bottom: 1px solid #333;
				}
				.logs-panel-table-head th,
				.logs-panel-table-body td {
					padding: 8px 10px;
				}
				.logs-panel-table-body tr {
					border-bottom: 1px solid #161616;
				}
				.logs-panel-cards {
					display: none;
					padding: 10px;
				}
				.logs-panel-card {
					border: 1px solid #222;
					border-radius: 10px;
					background: #101010;
					padding: 10px;
					display: flex;
					flex-direction: column;
					gap: 8px;
				}
				.logs-panel-card-top {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 10px;
				}
				.logs-panel-level {
					display: inline-flex;
					align-items: center;
					padding: 2px 7px;
					border-radius: 999px;
					border: 1px solid #222;
					font-size: 10px;
					text-transform: uppercase;
				}
				.logs-panel-level.info { color: #4f9; border-color: rgba(79, 255, 153, 0.28); }
				.logs-panel-level.warn { color: #ff9800; border-color: rgba(255, 152, 0, 0.28); }
				.logs-panel-level.error { color: #f44; border-color: rgba(255, 68, 68, 0.28); }
				.logs-panel-time,
				.logs-panel-category {
					color: #888;
					font-size: 11px;
				}
				.logs-panel-agent {
					color: #64b5f6;
					font-size: 12px;
				}
				.logs-panel-message,
				.logs-panel-meta {
					word-break: break-word;
				}
				.logs-panel-meta {
					color: #777;
					font-size: 11px;
				}
				.logs-panel-empty {
					padding: 12px;
					color: #666;
					font-style: italic;
				}
				.logs-panel-error {
					color: #f55;
					font-style: normal;
				}
				@media (max-width: 760px) {
					.logs-panel-search-row,
					.logs-panel-filter-grid {
						grid-template-columns: 1fr;
					}
					.logs-panel-search-row .logs-panel-btn {
						width: 100%;
					}
					.logs-panel-table-wrap {
						display: none;
					}
					.logs-panel-cards {
						display: grid;
					}
					.logs-panel-note {
						max-width: none;
					}
				}
			</style>
			<div class="logs-panel-header">
				<div>
					<div class="logs-panel-title">fleet logs</div>
					<div id="logs-panel-summary" class="logs-panel-summary">Loading full log history…</div>
				</div>
				<div class="logs-panel-note">Keyword search, category, agent, and date range filtering all run server-side.</div>
			</div>
			<form id="logs-panel-filters" class="logs-panel-form">
				<div class="logs-panel-search-row">
					<label class="logs-panel-field">
						<span>search logs</span>
						<input name="q" type="search" placeholder="decision, error, agent, message, metadata…" />
					</label>
					<button type="submit" class="logs-panel-btn primary">search</button>
					<button type="button" id="logs-panel-reset" class="logs-panel-btn">reset</button>
				</div>
				<details id="logs-panel-details" class="logs-panel-details">
					<summary>
						<span>filters</span>
						<span id="logs-panel-filter-summary" class="logs-panel-filter-summary">all logs</span>
					</summary>
					<div class="logs-panel-details-body">
						<div class="logs-panel-filter-grid">
							<label class="logs-panel-field">
								<span>agent</span>
								<input name="agent" type="text" placeholder="optional agent name" />
							</label>
							<label class="logs-panel-field">
								<span>level</span>
								<select name="level">
									<option value="">all</option>
									<option value="info">info</option>
									<option value="warn">warn</option>
									<option value="error">error</option>
								</select>
							</label>
							<label class="logs-panel-field">
								<span>category</span>
								<input name="category" type="text" placeholder="decision, state_change, health…" />
							</label>
							<label class="logs-panel-field">
								<span>from date</span>
								<input name="fromDate" type="date" />
							</label>
							<label class="logs-panel-field">
								<span>from time</span>
								<input name="fromTime" type="time" />
							</label>
							<label class="logs-panel-field">
								<span>to date</span>
								<input name="toDate" type="date" />
							</label>
							<label class="logs-panel-field">
								<span>to time</span>
								<input name="toTime" type="time" />
							</label>
						</div>
						<div id="logs-panel-active-filters" class="logs-panel-filter-chips"></div>
					</div>
				</details>
			</form>
			<div class="logs-panel-results">
				<div class="logs-panel-table-wrap">
					<table class="logs-panel-table">
						<thead class="logs-panel-table-head">
							<tr>
								<th>time</th>
								<th>level</th>
								<th>agent</th>
								<th>category</th>
								<th>message</th>
							</tr>
						</thead>
						<tbody id="logs-panel-body" class="logs-panel-table-body">
							<tr><td colspan="5" class="logs-panel-empty">Loading logs…</td></tr>
						</tbody>
					</table>
				</div>
				<div id="logs-panel-cards" class="logs-panel-cards">
					<div class="logs-panel-empty">Loading logs…</div>
				</div>
			</div>
			<script>
				(() => {
					const root = document.currentScript.parentElement;
					const panelView = root.closest('.panel-view');
					const apiBase = window.PANEL_API || '/ui/api';
					const form = root.querySelector('#logs-panel-filters');
					const reset = root.querySelector('#logs-panel-reset');
					const body = root.querySelector('#logs-panel-body');
					const cards = root.querySelector('#logs-panel-cards');
					const summary = root.querySelector('#logs-panel-summary');
					const details = root.querySelector('#logs-panel-details');
					const filterSummary = root.querySelector('#logs-panel-filter-summary');
					const activeFilters = root.querySelector('#logs-panel-active-filters');
					const levelColor = { info: '#4f9', warn: '#ff9800', error: '#f44' };
					let requestCounter = 0;
					let inFlight = false;
					let queuedRefresh = false;

					function esc(s) {
						return String(s)
							.replace(/&/g, '&amp;')
							.replace(/</g, '&lt;')
							.replace(/>/g, '&gt;');
					}

					function toEpoch(dateValue, timeValue, endOfWindow = false) {
						if (!dateValue) return '';
						const normalizedTime = timeValue || (endOfWindow ? '23:59' : '00:00');
						const date = new Date(dateValue + 'T' + normalizedTime);
						if (Number.isNaN(date.getTime())) return '';
						if (endOfWindow) date.setSeconds(59, 999);
						return String(date.getTime());
					}

					function filterEntries() {
						const entries = [];
						const q = form.elements.q.value.trim();
						const agent = form.elements.agent.value.trim();
						const level = form.elements.level.value;
						const category = form.elements.category.value.trim();
						const fromDate = form.elements.fromDate.value;
						const fromTime = form.elements.fromTime.value;
						const toDate = form.elements.toDate.value;
						const toTime = form.elements.toTime.value;
						if (q) entries.push('search: ' + q);
						if (agent) entries.push('agent: ' + agent);
						if (level) entries.push('level: ' + level);
						if (category) entries.push('category: ' + category);
						if (fromDate) entries.push('from: ' + new Date(fromDate + 'T' + (fromTime || '00:00')).toLocaleString());
						if (toDate) entries.push('to: ' + new Date(toDate + 'T' + (toTime || '23:59')).toLocaleString());
						return entries;
					}

					function syncFilterSummary() {
						const entries = filterEntries();
						filterSummary.textContent = entries.length ? entries.length + ' active' : 'all logs';
						activeFilters.innerHTML = entries.length
							? entries.map((entry) => '<div class="logs-panel-chip">' + esc(entry) + '</div>').join('')
							: '<div class="logs-panel-chip">no extra filters</div>';
					}

					function renderEmpty(message, isError = false) {
						const klass = isError ? 'logs-panel-empty logs-panel-error' : 'logs-panel-empty';
						body.innerHTML = '<tr><td colspan="5" class="' + klass + '">' + esc(message) + '</td></tr>';
						cards.innerHTML = '<div class="' + klass + '">' + esc(message) + '</div>';
					}

					async function loadLogs() {
						if (inFlight) {
							queuedRefresh = true;
							return;
						}
						inFlight = true;
						const requestId = ++requestCounter;
						const params = new URLSearchParams();
						const q = form.elements.q.value.trim();
						const fromDate = form.elements.fromDate.value;
						const fromTime = form.elements.fromTime.value;
						const toDate = form.elements.toDate.value;
						const toTime = form.elements.toTime.value;
						const level = form.elements.level.value;
						const agent = form.elements.agent.value.trim();
						const category = form.elements.category.value.trim();
						if (q) params.set('q', q);
						if (fromDate) params.set('since', toEpoch(fromDate, fromTime));
						if (toDate) params.set('until', toEpoch(toDate, toTime, true));
						if (level) params.set('level', level);
						if (agent) params.set('agent', agent);
						if (category) params.set('category', category);

						summary.textContent = 'Loading…';
						syncFilterSummary();
						try {
							const res = await fetch(\`\${apiBase}/logs/?\${params.toString()}\`, { credentials: 'same-origin' });
							const data = await res.json();
							if (requestId !== requestCounter) return;
							if (!res.ok) {
								summary.textContent = data.error || 'Failed to load logs';
								renderEmpty(data.error || 'Failed to load logs', true);
								return;
							}

							const logs = data.logs || [];
							summary.textContent = \`\${data.totalCount ?? logs.length} matching log(s)\${logs.length !== (data.totalCount ?? logs.length) ? \` · showing \${logs.length}\` : ''}\`;
							if (!logs.length) {
								renderEmpty('No logs match the current filters.');
								return;
							}

							body.innerHTML = logs.map((log) => {
								const created = new Date(log.createdAt).toLocaleString();
								const meta = log.metadata ? esc(JSON.stringify(log.metadata)) : '';
								return \`<tr>
									<td style="color:#888;white-space:nowrap">\${esc(created)}</td>
									<td style="color:\${levelColor[log.level] || '#ccc'};white-space:nowrap">\${esc(log.level)}</td>
									<td style="color:#64b5f6;white-space:nowrap">\${esc(log.agentName)}</td>
									<td style="color:#888;white-space:nowrap">\${esc(log.category || '')}</td>
									<td style="word-break:break-word">\${esc(log.message)}\${meta ? '<div class="logs-panel-meta">' + meta + '</div>' : ''}</td>
								</tr>\`;
							}).join('');

							cards.innerHTML = logs.map((log) => {
								const created = new Date(log.createdAt).toLocaleString();
								const categoryLabel = log.category || 'uncategorized';
								const meta = log.metadata ? '<div class="logs-panel-meta">' + esc(JSON.stringify(log.metadata)) + '</div>' : '';
								return \`<article class="logs-panel-card">
									<div class="logs-panel-card-top">
										<span class="logs-panel-level \${esc(log.level)}">\${esc(log.level)}</span>
										<div class="logs-panel-time">\${esc(created)}</div>
									</div>
									<div class="logs-panel-agent">\${esc(log.agentName)}</div>
									<div class="logs-panel-category">\${esc(categoryLabel)}</div>
									<div class="logs-panel-message">\${esc(log.message)}</div>
									\${meta}
								</article>\`;
							}).join('');
						} catch (error) {
							if (requestId !== requestCounter) return;
							summary.textContent = error.message || 'Failed to load logs';
							renderEmpty(error.message || 'Failed to load logs', true);
						} finally {
							if (requestId === requestCounter) {
								inFlight = false;
								if (queuedRefresh) {
									queuedRefresh = false;
									loadLogs();
								}
							}
						}
					}

					form.addEventListener('submit', (event) => {
						event.preventDefault();
						loadLogs().catch((error) => {
							summary.textContent = error.message || 'Failed to load logs';
							renderEmpty(error.message || 'Failed to load logs', true);
						});
					});
					reset.addEventListener('click', () => {
						form.reset();
						syncFilterSummary();
						loadLogs().catch((error) => {
							summary.textContent = error.message || 'Failed to load logs';
							renderEmpty(error.message || 'Failed to load logs', true);
						});
					});
					form.addEventListener('input', syncFilterSummary);
					form.addEventListener('change', syncFilterSummary);

					if (window.matchMedia && !window.matchMedia('(max-width: 760px)').matches) {
						details.open = true;
					}

					if (panelView) {
						panelView.__panelRefresh = () => loadLogs();
					}

					syncFilterSummary();
					loadLogs();
				})();
			</script>
		</div>
	`);
});

// =============================================================================
// Tools
// =============================================================================

function registerTools(pi: ExtensionAPI, client: FleetClient) {
  // reef_log — write a structured log entry
  pi.registerTool({
    name: "reef_log",
    label: "Log: Write Entry",
    description:
      "Write a structured log entry to root's SQLite. Use this for significant decisions, state changes, and errors. Logs survive VM crashes and are readable by other agents for handoff and debugging.",
    parameters: Type.Object({
      level: Type.Optional(
        Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")], {
          description: "Log level (default: info)",
        }),
      ),
      category: Type.Optional(
        Type.String({
          description: "Category: decision, state_change, error, or custom",
        }),
      ),
      message: Type.String({ description: "Human-readable log message" }),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Structured metadata (JSON)" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        await client.api("POST", "/logs/", {
          agentId: process.env.VERS_VM_ID || "unknown",
          agentName: client.agentName,
          level: params.level || "info",
          category: params.category,
          message: params.message,
          metadata: params.metadata,
        });
        return client.ok(`Logged: [${params.level || "info"}] ${params.message.slice(0, 80)}`);
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  // reef_logs — read logs
  pi.registerTool({
    name: "reef_logs",
    label: "Log: Read Entries",
    description:
      "Read log entries — your own by default, or another agent's by name. Use for debugging, handoff context, and understanding what an agent did.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Agent name to read logs for (default: yourself)" })),
      level: Type.Optional(Type.String({ description: "Filter by level: info, warn, error" })),
      category: Type.Optional(Type.String({ description: "Filter by category: tool_call, decision, error, etc." })),
      q: Type.Optional(Type.String({ description: "Keyword search across agent, category, message, and metadata" })),
      since: Type.Optional(Type.Number({ description: "Epoch ms lower bound for createdAt" })),
      until: Type.Optional(Type.Number({ description: "Epoch ms upper bound for createdAt" })),
      limit: Type.Optional(Type.Number({ description: "Max entries to return (default: 20)" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        let qs = `limit=${params.limit || 20}`;
        const agentName = params.agent || client.agentName;
        qs += `&agent=${encodeURIComponent(agentName)}`;
        if (params.level) qs += `&level=${params.level}`;
        if (params.category) qs += `&category=${encodeURIComponent(params.category)}`;
        if (params.q) qs += `&q=${encodeURIComponent(params.q)}`;
        if (params.since) qs += `&since=${params.since}`;
        if (params.until) qs += `&until=${params.until}`;

        const result = await client.api<any>("GET", `/logs/?${qs}`);
        const logs = result.logs || [];

        if (logs.length === 0) {
          return client.ok(`No logs found for ${agentName}.`);
        }

        const lines = logs.map((l: any) => {
          const cat = l.category ? `[${l.category}]` : "";
          const meta = l.metadata ? ` — ${JSON.stringify(l.metadata).slice(0, 100)}` : "";
          return `[${l.level}] ${cat} ${l.message}${meta}`;
        });

        return client.ok(`${logs.length} log(s) for ${agentName}:\n${lines.join("\n")}`, { logs });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}

// =============================================================================
// Behaviors — auto-log tool calls from RPC event stream
// =============================================================================

function registerBehaviors(pi: ExtensionAPI, client: FleetClient) {
  // Auto-log tool calls and results
  pi.on("tool_call", async (event: any) => {
    if (!client.getBaseUrl()) return;
    try {
      await client.api("POST", "/logs/", {
        agentId: process.env.VERS_VM_ID || "unknown",
        agentName: client.agentName,
        level: "info",
        category: "tool_call",
        message: `${event.toolName || event.name || "unknown_tool"}(${JSON.stringify(event.params || event.input || {}).slice(0, 200)})`,
        metadata: { toolName: event.toolName || event.name, toolCallId: event.id || event.toolCallId },
      });
    } catch {
      /* best effort — never crash the agent for logging */
    }
  });

  pi.on("tool_result", async (event: any) => {
    if (!client.getBaseUrl()) return;
    const isError = event.isError || event.error;
    try {
      await client.api("POST", "/logs/", {
        agentId: process.env.VERS_VM_ID || "unknown",
        agentName: client.agentName,
        level: isError ? "error" : "info",
        category: "tool_result",
        message: isError
          ? `Tool error: ${event.error || event.content?.[0]?.text?.slice(0, 200) || "unknown"}`
          : `Tool result: ${event.content?.[0]?.text?.slice(0, 200) || "(no text)"}`,
        metadata: { toolCallId: event.id || event.toolCallId, isError: !!isError },
      });
    } catch {
      /* best effort */
    }
  });
}

// =============================================================================
// Module
// =============================================================================

const routeDocs: Record<string, RouteDocs> = {
  "POST /": {
    summary: "Write a log entry",
    body: {
      agentId: { type: "string", description: "VM ID of the agent" },
      agentName: { type: "string", required: true, description: "Agent name" },
      level: { type: "string", description: "info | warn | error (default: info)" },
      category: { type: "string", description: "tool_call | tool_result | decision | error | state_change" },
      message: { type: "string", required: true, description: "Log message" },
      metadata: { type: "object", description: "Structured metadata" },
    },
    response: "The created log entry",
  },
  "GET /": {
    summary: "Query logs",
    query: {
      agent: { type: "string", description: "Filter by agent name" },
      agentId: { type: "string", description: "Filter by VM ID" },
      level: { type: "string", description: "Filter by level" },
      category: { type: "string", description: "Filter by category" },
      q: { type: "string", description: "Keyword search across agent, level, category, message, and metadata" },
      since: { type: "string", description: "Epoch ms timestamp" },
      until: { type: "string", description: "Epoch ms timestamp upper bound" },
      limit: { type: "string", description: "Max results (default: 100)" },
      offset: { type: "string", description: "Offset for pagination" },
    },
    response: "{ logs: [...], count, totalCount }",
  },
  "GET /_panel": { summary: "HTML log browser with keyword and date-range search", response: "text/html" },
};

const logs: ServiceModule = {
  name: "logs",
  description: "Operational trace — tool calls, errors, decisions for all agents",
  routes,
  routeDocs,
  registerTools,
  registerBehaviors,

  init(ctx: ServiceContext) {
    const storeHandle = ctx.getStore<any>("vm-tree");
    if (storeHandle?.vmTreeStore) {
      vmTreeStore = storeHandle.vmTreeStore as VMTreeStore;
    }
  },

  dependencies: ["vm-tree"],
  capabilities: ["agent.log", "agent.logs"],
};

export default logs;
