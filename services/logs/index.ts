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
  const vm = vmId ? vmTreeStore?.getVM(vmId) || null : agentName ? vmTreeStore?.getVMByName(agentName) || null : null;
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
  return vmTreeStore?.descendants(actor.vm.vmId).some((vm) => vm.vmId === target.vmId) || false;
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
  const since = c.req.query("since");
  const limit = c.req.query("limit");

  let agentName = requestedAgentName || undefined;
  let agentId = requestedAgentId || undefined;

  if (!isOperatorRequest(actor) && !isRootActor(actor)) {
    if (!agentName && !agentId) {
      agentName = actor.vm?.name || actor.agentName || undefined;
      agentId = actor.vm?.vmId || actor.vmId || undefined;
    }

    const target =
      (agentId ? vmTreeStore.getVM(agentId) : null) || (agentName ? vmTreeStore.getVMByName(agentName) : null) || null;

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
    since: since ? Number.parseInt(since, 10) : undefined,
    limit: limit ? Number.parseInt(limit, 10) : 100,
  });

  return c.json({ logs, count: logs.length });
});

// GET /_panel — debug view
routes.get("/_panel", (c) => {
  if (!vmTreeStore) {
    return c.html('<div style="font-family:monospace;color:#888">Logs service not initialized</div>');
  }

  const recent = vmTreeStore.queryLogs({ limit: 30 });

  function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const levelColor: Record<string, string> = { info: "#4f9", warn: "#ff9800", error: "#f44" };

  const rows = recent
    .map((l) => {
      const color = levelColor[l.level] || "#ccc";
      const age = Math.round((Date.now() - l.createdAt) / 1000);
      const cat = l.category ? `[${l.category}]` : "";
      return `<tr>
				<td style="padding:2px 6px;color:${color};font-size:11px">${esc(l.level)}</td>
				<td style="padding:2px 6px;color:#64b5f6">${esc(l.agentName)}</td>
				<td style="padding:2px 6px;color:#888;font-size:11px">${esc(cat)}</td>
				<td style="padding:2px 6px">${esc(l.message.slice(0, 120))}</td>
				<td style="padding:2px 6px;color:#666;font-size:11px">${age}s ago</td>
			</tr>`;
    })
    .join("");

  return c.html(`
		<div style="font-family:monospace;font-size:13px;color:#ccc">
			<div style="margin-bottom:8px;color:#888">${recent.length} recent log entries</div>
			${
        recent.length > 0
          ? `<table style="width:100%;border-collapse:collapse">
						<thead><tr style="color:#666;font-size:11px;text-align:left;border-bottom:1px solid #333">
							<th style="padding:2px 6px">Level</th>
							<th style="padding:2px 6px">Agent</th>
							<th style="padding:2px 6px">Category</th>
							<th style="padding:2px 6px">Message</th>
							<th style="padding:2px 6px">Age</th>
						</tr></thead>
						<tbody>${rows}</tbody>
					</table>`
          : '<div style="color:#666;font-style:italic">No logs yet</div>'
      }
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
      since: { type: "string", description: "Epoch ms timestamp" },
      limit: { type: "string", description: "Max results (default: 100)" },
    },
    response: "{ logs: [...], count }",
  },
  "GET /_panel": { summary: "HTML debug view of recent logs", response: "text/html" },
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
