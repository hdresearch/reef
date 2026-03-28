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
		<div style="font-family:monospace;font-size:13px;color:#ccc;display:flex;flex-direction:column;gap:10px;min-height:0">
			<div style="display:flex;align-items:end;justify-content:space-between;gap:12px;flex-wrap:wrap">
				<div>
					<div style="color:#ddd;font-size:12px">fleet logs</div>
					<div id="logs-panel-summary" style="color:#888;font-size:11px">Loading full log history…</div>
				</div>
				<div style="color:#666;font-size:11px">Keyword + date range search runs server-side.</div>
			</div>
			<form id="logs-panel-filters" style="display:grid;grid-template-columns:2fr repeat(4,minmax(0,1fr)) auto auto;gap:8px;align-items:end">
				<label style="display:flex;flex-direction:column;gap:4px;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">
					<span>keyword</span>
					<input name="q" type="search" placeholder="decision, error, agent name, message…" style="background:#111;border:1px solid #333;color:#ddd;padding:6px 8px;border-radius:4px;font:inherit" />
				</label>
				<label style="display:flex;flex-direction:column;gap:4px;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">
					<span>from</span>
					<input name="from" type="datetime-local" style="background:#111;border:1px solid #333;color:#ddd;padding:6px 8px;border-radius:4px;font:inherit" />
				</label>
				<label style="display:flex;flex-direction:column;gap:4px;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">
					<span>to</span>
					<input name="to" type="datetime-local" style="background:#111;border:1px solid #333;color:#ddd;padding:6px 8px;border-radius:4px;font:inherit" />
				</label>
				<label style="display:flex;flex-direction:column;gap:4px;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">
					<span>level</span>
					<select name="level" style="background:#111;border:1px solid #333;color:#ddd;padding:6px 8px;border-radius:4px;font:inherit">
						<option value="">all</option>
						<option value="info">info</option>
						<option value="warn">warn</option>
						<option value="error">error</option>
					</select>
				</label>
				<label style="display:flex;flex-direction:column;gap:4px;color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.5px">
					<span>agent</span>
					<input name="agent" type="text" placeholder="optional agent name" style="background:#111;border:1px solid #333;color:#ddd;padding:6px 8px;border-radius:4px;font:inherit" />
				</label>
				<button type="submit" style="background:#16213e;border:1px solid #2c4f7a;color:#d9f6ff;padding:6px 10px;border-radius:4px;font:inherit;cursor:pointer">search</button>
				<button type="button" id="logs-panel-reset" style="background:#111;border:1px solid #333;color:#bbb;padding:6px 10px;border-radius:4px;font:inherit;cursor:pointer">reset</button>
			</form>
			<div id="logs-panel-table-wrap" style="min-height:0;overflow:auto;border:1px solid #222;border-radius:6px;background:#0c0c0c">
				<table style="width:100%;border-collapse:collapse">
					<thead style="position:sticky;top:0;background:#101010;z-index:1">
						<tr style="color:#666;font-size:11px;text-align:left;border-bottom:1px solid #333">
							<th style="padding:6px 8px">Time</th>
							<th style="padding:6px 8px">Level</th>
							<th style="padding:6px 8px">Agent</th>
							<th style="padding:6px 8px">Category</th>
							<th style="padding:6px 8px">Message</th>
						</tr>
					</thead>
					<tbody id="logs-panel-body">
						<tr><td colspan="5" style="padding:12px;color:#666;font-style:italic">Loading logs…</td></tr>
					</tbody>
				</table>
			</div>
			<script>
				(() => {
					const root = document.currentScript.parentElement;
					const form = root.querySelector('#logs-panel-filters');
					const reset = root.querySelector('#logs-panel-reset');
					const body = root.querySelector('#logs-panel-body');
					const summary = root.querySelector('#logs-panel-summary');
					const levelColor = { info: '#4f9', warn: '#ff9800', error: '#f44' };

					function esc(s) {
						return String(s)
							.replace(/&/g, '&amp;')
							.replace(/</g, '&lt;')
							.replace(/>/g, '&gt;');
					}

					function toEpoch(value, endOfMinute = false) {
						if (!value) return '';
						const date = new Date(value);
						if (Number.isNaN(date.getTime())) return '';
						if (endOfMinute) date.setSeconds(59, 999);
						return String(date.getTime());
					}

					async function loadLogs() {
						const params = new URLSearchParams();
						const q = form.elements.q.value.trim();
						const from = form.elements.from.value;
						const to = form.elements.to.value;
						const level = form.elements.level.value;
						const agent = form.elements.agent.value.trim();
						if (q) params.set('q', q);
						if (from) params.set('since', toEpoch(from));
						if (to) params.set('until', toEpoch(to, true));
						if (level) params.set('level', level);
						if (agent) params.set('agent', agent);

						summary.textContent = 'Loading…';
						const res = await fetch(\`\${window.location.origin}/logs/?\${params.toString()}\`);
						const data = await res.json();
						if (!res.ok) {
							summary.textContent = data.error || 'Failed to load logs';
							body.innerHTML = \`<tr><td colspan="5" style="padding:12px;color:#f55">\${esc(data.error || 'Failed to load logs')}</td></tr>\`;
							return;
						}

						const logs = data.logs || [];
						summary.textContent = \`\${data.totalCount ?? logs.length} matching log(s)\${logs.length !== (data.totalCount ?? logs.length) ? \` · showing \${logs.length}\` : ''}\`;
						if (!logs.length) {
							body.innerHTML = '<tr><td colspan="5" style="padding:12px;color:#666;font-style:italic">No logs match the current filters.</td></tr>';
							return;
						}

						body.innerHTML = logs.map((log) => {
							const created = new Date(log.createdAt).toLocaleString();
							const meta = log.metadata ? \` — \${JSON.stringify(log.metadata)}\` : '';
							return \`<tr style="border-bottom:1px solid #161616">
								<td style="padding:6px 8px;color:#888;white-space:nowrap">\${esc(created)}</td>
								<td style="padding:6px 8px;color:\${levelColor[log.level] || '#ccc'};white-space:nowrap">\${esc(log.level)}</td>
								<td style="padding:6px 8px;color:#64b5f6;white-space:nowrap">\${esc(log.agentName)}</td>
								<td style="padding:6px 8px;color:#888;white-space:nowrap">\${esc(log.category || '')}</td>
								<td style="padding:6px 8px;word-break:break-word">\${esc(log.message + meta)}</td>
							</tr>\`;
						}).join('');
					}

					form.addEventListener('submit', (event) => {
						event.preventDefault();
						loadLogs().catch((error) => {
							summary.textContent = error.message || 'Failed to load logs';
						});
					});
					reset.addEventListener('click', () => {
						form.reset();
						loadLogs().catch((error) => {
							summary.textContent = error.message || 'Failed to load logs';
						});
					});

					loadLogs().catch((error) => {
						summary.textContent = error.message || 'Failed to load logs';
					});
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
