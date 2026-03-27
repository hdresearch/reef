/**
 * Signals service — bidirectional communication between agents.
 *
 * Upward signals: child → parent (done, blocked, failed, progress, need-resources, checkpoint)
 * Downward commands: parent → child (abort, pause, resume, steer)
 *
 * All agents read/write through reef_signal, reef_command, and reef_inbox tools.
 * Signals are persisted to SQLite (signals table in the unified fleet.sqlite).
 * Auto-triggers a root task when a direct child signals failed or blocked.
 *
 * Tools (3):
 *   reef_signal  — send upward to parent
 *   reef_command — send downward to a child
 *   reef_inbox   — unified inbox with filters (direction, type, from)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import type { ServiceEventBus } from "../../src/core/events.js";
import type { FleetClient, RouteDocs, ServiceContext, ServiceModule } from "../../src/core/types.js";
import type { VMTreeStore } from "../vm-tree/store.js";

let vmTreeStore: VMTreeStore | null = null;
let events: ServiceEventBus | null = null;

// =============================================================================
// Routes
// =============================================================================

const routes = new Hono();

// POST / — send a signal or command
routes.post("/", async (c) => {
  if (!vmTreeStore) return c.json({ error: "vm-tree store not available" }, 503);

  try {
    const body = await c.req.json();
    const { fromAgent, toAgent, direction, signalType, payload } = body;

    if (!fromAgent || !toAgent || !direction || !signalType) {
      return c.json({ error: "fromAgent, toAgent, direction, and signalType are required" }, 400);
    }

    const signal = vmTreeStore.insertSignal({
      fromAgent,
      toAgent,
      direction,
      signalType,
      payload: payload || undefined,
    });

    // Emit on the event bus for real-time listeners
    events?.emit(`signal:${signalType}`, signal);
    events?.emit("signal:new", signal);

    // v2: Update sender's vm_tree status and take completion snapshot on done/failed
    if (direction === "up" && vmTreeStore) {
      try {
        const sender = vmTreeStore.getVMByName(fromAgent);
        if (sender) {
          if (signalType === "done" || signalType === "failed") {
            vmTreeStore.updateVM(sender.vmId, { status: "stopped" });
            // Completion snapshot — best effort, non-blocking
            // Note: actual vers_vm_commit would require pi-vers VersClient access
            // which the signals service doesn't have. Log the intent as an agent_event.
            vmTreeStore.insertAgentEvent(sender.vmId, signalType === "done" ? "task_completed" : "error", {
              summary: payload?.summary || payload?.error || signalType,
            });
          }
        }
      } catch {
        /* best effort */
      }
    }

    // v2: Auto-trigger root task on urgent signals from direct children
    if (
      direction === "up" &&
      (signalType === "failed" || signalType === "blocked") &&
      toAgent === (process.env.VERS_AGENT_NAME || "root-reef")
    ) {
      try {
        const payloadSummary = payload?.reason || payload?.error || payload?.message || signalType;
        const infraUrl = process.env.VERS_INFRA_URL || `http://localhost:${process.env.PORT || 3000}`;
        const authToken = process.env.VERS_AUTH_TOKEN;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (authToken) headers.Authorization = `Bearer ${authToken}`;
        fetch(`${infraUrl}/reef/submit`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            task: `URGENT: Agent "${fromAgent}" signaled ${signalType}. Reason: ${payloadSummary}. Check reef_inbox and reef_fleet_status, then decide how to respond.`,
          }),
        }).catch(() => {
          /* best effort — don't block signal delivery */
        });
      } catch {
        /* best effort */
      }
    }

    return c.json(signal, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET / — query signals (used by reef_inbox)
routes.get("/", (c) => {
  if (!vmTreeStore) return c.json({ error: "vm-tree store not available" }, 503);

  const toAgent = c.req.query("to");
  const fromAgent = c.req.query("from");
  const direction = c.req.query("direction") as "up" | "down" | undefined;
  const signalType = c.req.query("type") as any;
  const acknowledged = c.req.query("acknowledged");
  const since = c.req.query("since");
  const limit = c.req.query("limit");

  const signals = vmTreeStore.querySignals({
    toAgent: toAgent || undefined,
    fromAgent: fromAgent || undefined,
    direction: direction || undefined,
    signalType: signalType || undefined,
    acknowledged: acknowledged !== undefined ? acknowledged === "true" : undefined,
    since: since ? Number.parseInt(since, 10) : undefined,
    limit: limit ? Number.parseInt(limit, 10) : undefined,
  });

  return c.json({ signals, count: signals.length });
});

// POST /acknowledge — mark signals as read
routes.post("/acknowledge", async (c) => {
  if (!vmTreeStore) return c.json({ error: "vm-tree store not available" }, 503);

  try {
    const body = await c.req.json();
    const { ids } = body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return c.json({ error: "ids array is required" }, 400);
    }
    vmTreeStore.acknowledgeSignals(ids);
    return c.json({ acknowledged: ids.length });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// GET /_panel — debug view
routes.get("/_panel", (c) => {
  if (!vmTreeStore) {
    return c.html('<div style="font-family:monospace;color:#888">Signals service not initialized</div>');
  }

  const recent = vmTreeStore.querySignals({ limit: 20 });
  const unacked = vmTreeStore.querySignals({ acknowledged: false, limit: 50 });

  function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const rows = recent
    .map((s) => {
      const dir = s.direction === "up" ? "&#x2191;" : "&#x2193;";
      const ack = s.acknowledged
        ? '<span style="color:#4f9">&#x2713;</span>'
        : '<span style="color:#ff9800">&#x25cf;</span>';
      const age = Math.round((Date.now() - s.createdAt) / 1000);
      const payload = s.payload ? JSON.stringify(s.payload).slice(0, 80) : "";
      return `<tr>
				<td style="padding:2px 6px;color:#888">${ack}</td>
				<td style="padding:2px 6px">${dir}</td>
				<td style="padding:2px 6px;color:#4f9">${esc(s.fromAgent)}</td>
				<td style="padding:2px 6px;color:#888">→</td>
				<td style="padding:2px 6px;color:#64b5f6">${esc(s.toAgent)}</td>
				<td style="padding:2px 6px;color:#ff9800">${esc(s.signalType)}</td>
				<td style="padding:2px 6px;color:#666;font-size:11px">${age}s ago</td>
				<td style="padding:2px 6px;color:#666;font-size:11px">${esc(payload)}</td>
			</tr>`;
    })
    .join("");

  return c.html(`
		<div style="font-family:monospace;font-size:13px;color:#ccc">
			<div style="margin-bottom:8px;color:#888">
				${unacked.length} unacknowledged signal${unacked.length !== 1 ? "s" : ""}
			</div>
			${
        recent.length > 0
          ? `<table style="width:100%;border-collapse:collapse">
						<thead><tr style="color:#666;font-size:11px;text-align:left;border-bottom:1px solid #333">
							<th style="padding:2px 6px">Ack</th>
							<th style="padding:2px 6px">Dir</th>
							<th style="padding:2px 6px">From</th>
							<th></th>
							<th style="padding:2px 6px">To</th>
							<th style="padding:2px 6px">Type</th>
							<th style="padding:2px 6px">Age</th>
							<th style="padding:2px 6px">Payload</th>
						</tr></thead>
						<tbody>${rows}</tbody>
					</table>`
          : '<div style="color:#666;font-style:italic">No signals yet</div>'
      }
		</div>
	`);
});

// =============================================================================
// Tools
// =============================================================================

function registerTools(pi: ExtensionAPI, client: FleetClient) {
  // reef_signal — send upward to parent
  pi.registerTool({
    name: "reef_signal",
    label: "Signal: Send to Parent",
    description: `Send a signal upward to your parent agent. Your parent is auto-resolved from your identity.

Signal types:
  - "done"           — mission/task complete. Include artifact pointers in payload.
  - "blocked"        — can't proceed. Include reason and what you need.
  - "failed"         — unrecoverable error. Include error details and partial work pointers.
  - "progress"       — status update. Include message and optionally percentComplete.
  - "need-resources" — need more compute or access. Include what you're requesting.
  - "checkpoint"     — saved state + VM snapshot. Include commitId and message.`,
    parameters: Type.Object({
      signal: Type.Union(
        [
          Type.Literal("done"),
          Type.Literal("blocked"),
          Type.Literal("failed"),
          Type.Literal("progress"),
          Type.Literal("need-resources"),
          Type.Literal("checkpoint"),
        ],
        { description: "Signal type" },
      ),
      payload: Type.Optional(
        Type.Record(Type.String(), Type.Any(), { description: "Signal payload (summary, artifacts, reason, etc.)" }),
      ),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        // Resolve parent name from identity
        const selfRes = await client.api<any>(
          "GET",
          `/vm-tree/vms/${encodeURIComponent(process.env.VERS_VM_ID || "")}`,
        );
        const parentId = selfRes?.parentId;
        let toAgent = "root";
        if (parentId) {
          const parentRes = await client.api<any>("GET", `/vm-tree/vms/${encodeURIComponent(parentId)}`);
          toAgent = parentRes?.name || "root";
        }

        const result = await client.api<any>("POST", "/signals/", {
          fromAgent: client.agentName,
          toAgent,
          direction: "up",
          signalType: params.signal,
          payload: params.payload,
        });

        return client.ok(`Signal "${params.signal}" sent to ${toAgent}.`, { signal: result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  // reef_command — send downward to a child
  pi.registerTool({
    name: "reef_command",
    label: "Command: Send to Child",
    description: `Send a command downward to one of your child agents.

Command types:
  - "steer"  — course correction, new context, new direction. Payload should include message.
  - "abort"  — stop everything, tear down sub-fleet, self-terminate.
  - "pause"  — suspend work, hold state.
  - "resume" — continue from where you stopped.`,
    parameters: Type.Object({
      to: Type.String({ description: "Child agent name to send the command to" }),
      command: Type.Union(
        [Type.Literal("steer"), Type.Literal("abort"), Type.Literal("pause"), Type.Literal("resume")],
        { description: "Command type" },
      ),
      payload: Type.Optional(
        Type.Record(Type.String(), Type.Any(), { description: "Command payload (message, reason, etc.)" }),
      ),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api<any>("POST", "/signals/", {
          fromAgent: client.agentName,
          toAgent: params.to,
          direction: "down",
          signalType: params.command,
          payload: params.payload,
        });

        return client.ok(`Command "${params.command}" sent to ${params.to}.`, { signal: result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  // reef_inbox — unified inbox with filters
  pi.registerTool({
    name: "reef_inbox",
    label: "Inbox: Read Signals & Commands",
    description: `Read your unified inbox — signals from your children AND commands from your parent. Returns unacknowledged messages by default.

Filters:
  - direction: "up" (signals from children) or "down" (commands from parent)
  - type: filter by signal/command type (e.g. "done", "steer", "abort")
  - from: filter by sender agent name

Messages are auto-acknowledged when you read them.`,
    parameters: Type.Object({
      direction: Type.Optional(
        Type.Union([Type.Literal("up"), Type.Literal("down")], { description: "Filter by direction" }),
      ),
      type: Type.Optional(Type.String({ description: "Filter by signal/command type" })),
      from: Type.Optional(Type.String({ description: "Filter by sender agent name" })),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        let qs = `to=${encodeURIComponent(client.agentName)}&acknowledged=false`;
        if (params.direction) qs += `&direction=${params.direction}`;
        if (params.type) qs += `&type=${params.type}`;
        if (params.from) qs += `&from=${encodeURIComponent(params.from)}`;

        const result = await client.api<any>("GET", `/signals/?${qs}`);
        const signals = result.signals || [];

        // Auto-acknowledge
        if (signals.length > 0) {
          const ids = signals.map((s: any) => s.id);
          await client.api("POST", "/signals/acknowledge", { ids });
        }

        if (signals.length === 0) {
          return client.ok("Inbox is empty — no unacknowledged messages.");
        }

        const lines = signals.map((s: any) => {
          const dir = s.direction === "up" ? "↑" : "↓";
          const payload = s.payload ? ` — ${JSON.stringify(s.payload).slice(0, 200)}` : "";
          return `${dir} [${s.signalType}] from ${s.fromAgent}${payload}`;
        });

        return client.ok(`${signals.length} message(s):\n${lines.join("\n")}`, { signals });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  // reef_fleet_status — live view of direct children
  pi.registerTool({
    name: "reef_fleet_status",
    label: "Fleet: Status",
    description: [
      "Get a live view of your direct children in the fleet tree.",
      "Shows each child's name, category, status, model, last signal, and context.",
      "Use this to monitor your fleet without polling individual agents.",
    ].join("\n"),
    parameters: Type.Object({}),
    async execute() {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        // Get our VM ID
        const vmId = process.env.VERS_VM_ID;
        if (!vmId) return client.ok("No VERS_VM_ID set — cannot determine fleet position.");

        // Get direct children from vm_tree
        const treeResult = await client.api<any>("GET", `/vm-tree/vms/${encodeURIComponent(vmId)}/children`);
        const children = treeResult.children || [];

        if (children.length === 0) {
          return client.ok("No children in fleet. You haven't spawned any agents yet.");
        }

        // Get fleet-wide status
        const fleetResult = await client.api<any>("GET", "/vm-tree/fleet/status");

        // For each child, get their last signal
        const lines: string[] = [`Fleet: ${fleetResult.alive} alive VMs, ${children.length} direct children\n`];

        for (const child of children) {
          const statusColor = child.status === "running" ? "running" : child.status;
          let lastSignal = "none";

          // Try to get last signal from this child
          try {
            const sigResult = await client.api<any>("GET", `/signals/?from=${encodeURIComponent(child.name)}&limit=1`);
            const sig = sigResult.signals?.[0];
            if (sig) {
              const payload =
                sig.payload?.summary || sig.payload?.message || JSON.stringify(sig.payload || {}).slice(0, 80);
              lastSignal = `${sig.signalType}: ${payload}`;
            }
          } catch {
            /* best effort */
          }

          const elapsed = child.createdAt ? `${Math.round((Date.now() - child.createdAt) / 1000 / 60)}min` : "?";
          const ctx = child.context ? `${child.context.slice(0, 80).replace(/\n/g, " ")}...` : "no context";

          lines.push(
            `${child.name} (${child.category}, ${statusColor}, ${elapsed})`,
            `  Model: ${child.model || "default"} | Last signal: ${lastSignal}`,
            `  Context: ${ctx}`,
            "",
          );
        }

        return client.ok(lines.join("\n"), { children, fleet: fleetResult });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });

  // reef_checkpoint — snapshot VM and signal parent
  pi.registerTool({
    name: "reef_checkpoint",
    label: "Checkpoint: Snapshot VM",
    description: [
      "Snapshot your VM at a meaningful state. Creates a Vers commit and signals your parent.",
      "Use at phase boundaries or before risky operations. Your parent can rewind you to this checkpoint.",
      "",
      "Lieutenants: checkpoint at phase boundaries.",
      "Agent VMs: checkpoint if work has clear phases.",
      "Swarm workers: generally don't checkpoint.",
    ].join("\n"),
    parameters: Type.Object({
      message: Type.String({
        description: "What state this checkpoint captures (e.g. 'Phase 1 complete, tests pass')",
      }),
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const vmId = process.env.VERS_VM_ID;
        if (!vmId) return client.err("No VERS_VM_ID — cannot checkpoint.");

        // Snapshot the VM via vers_vm_commit
        let commitId: string | undefined;
        try {
          const commitResult = await client.api<any>("POST", `/vers/vm/${vmId}/commit`);
          commitId = commitResult?.commitId || commitResult?.id;
        } catch (e: any) {
          // Try the pi-vers extension tool path
          return client.err(`Checkpoint snapshot failed: ${e.message}. Use vers_vm_commit manually if available.`);
        }

        // Update vm_tree with checkpoint commit
        if (commitId) {
          try {
            await client.api("PATCH", `/vm-tree/vms/${vmId}`, { lastCheckpointCommit: commitId });
          } catch {
            /* best effort */
          }
        }

        // Signal parent with checkpoint info
        try {
          const selfRes = await client.api<any>("GET", `/vm-tree/vms/${encodeURIComponent(vmId)}`);
          const parentId = selfRes?.parentId;
          let toAgent = "root";
          if (parentId) {
            const parentRes = await client.api<any>("GET", `/vm-tree/vms/${encodeURIComponent(parentId)}`);
            toAgent = parentRes?.name || "root";
          }

          await client.api("POST", "/signals/", {
            fromAgent: client.agentName,
            toAgent,
            direction: "up",
            signalType: "checkpoint",
            payload: { commitId, message: params.message },
          });
        } catch {
          /* best effort */
        }

        return client.ok(
          `Checkpoint created${commitId ? ` (commit: ${commitId.slice(0, 12)})` : ""}. Message: ${params.message}`,
          { commitId, message: params.message },
        );
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}

// =============================================================================
// Behaviors — periodic inbox check for urgent signals
// =============================================================================

function registerBehaviors(pi: ExtensionAPI, client: FleetClient) {
  let inboxTimer: ReturnType<typeof setInterval> | null = null;

  pi.on("session_start", async () => {
    if (!client.getBaseUrl()) return;

    // Poll inbox every 10 seconds for urgent signals (failed, blocked from children)
    inboxTimer = setInterval(async () => {
      try {
        const qs = `to=${encodeURIComponent(client.agentName)}&acknowledged=false&direction=up`;
        const result = await client.api<any>("GET", `/signals/?${qs}`);
        const signals = result.signals || [];

        // Check for urgent signals that should auto-trigger attention
        const urgent = signals.filter(
          (s: any) => s.signalType === "failed" || s.signalType === "blocked" || s.signalType === "done",
        );

        if (urgent.length > 0) {
          // Emit on the extension event bus so the agent can react
          for (const sig of urgent) {
            pi.events.emit(`reef:signal:${sig.signalType}`, {
              from: sig.fromAgent,
              type: sig.signalType,
              payload: sig.payload,
            });
          }
        }
      } catch {
        /* best effort — never crash for inbox polling */
      }
    }, 10_000);
  });

  pi.on("session_shutdown", async () => {
    if (inboxTimer) {
      clearInterval(inboxTimer);
      inboxTimer = null;
    }
  });
}

// =============================================================================
// Module
// =============================================================================

const routeDocs: Record<string, RouteDocs> = {
  "POST /": {
    summary: "Send a signal or command",
    body: {
      fromAgent: { type: "string", required: true, description: "Sender agent name" },
      toAgent: { type: "string", required: true, description: "Recipient agent name" },
      direction: { type: "string", required: true, description: "up | down" },
      signalType: { type: "string", required: true, description: "Signal or command type" },
      payload: { type: "object", description: "Signal/command payload" },
    },
    response: "The created signal object",
  },
  "GET /": {
    summary: "Query signals (used by reef_inbox)",
    query: {
      to: { type: "string", description: "Filter by recipient" },
      from: { type: "string", description: "Filter by sender" },
      direction: { type: "string", description: "up | down" },
      type: { type: "string", description: "Signal/command type" },
      acknowledged: { type: "string", description: "true | false" },
      since: { type: "string", description: "Epoch ms timestamp" },
      limit: { type: "string", description: "Max results" },
    },
    response: "{ signals: [...], count }",
  },
  "POST /acknowledge": {
    summary: "Acknowledge signals by ID",
    body: { ids: { type: "string[]", required: true, description: "Signal IDs to acknowledge" } },
    response: "{ acknowledged: count }",
  },
  "GET /_panel": { summary: "HTML debug view of recent signals", response: "text/html" },
};

const signals: ServiceModule = {
  name: "signals",
  description: "Bidirectional signal & command system for fleet communication",
  routes,
  routeDocs,
  registerTools,
  registerBehaviors,

  init(ctx: ServiceContext) {
    // Get the shared vm-tree store via the exposed vmTreeStore getter
    const storeHandle = ctx.getStore<any>("vm-tree");
    if (storeHandle?.vmTreeStore) {
      vmTreeStore = storeHandle.vmTreeStore as VMTreeStore;
    }
    events = ctx.events as any;
  },

  dependencies: ["vm-tree"],
  capabilities: ["agent.signal", "agent.command", "agent.inbox"],
};

export default signals;
