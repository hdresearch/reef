import type { Database } from "bun:sqlite";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import { ulid } from "ulid";
import type { FleetClient, RouteDocs, ServiceContext, ServiceModule } from "../../src/core/types.js";
import type { SignalType, VMTreeStore } from "../vm-tree/store.js";

type ScheduledKind = "follow_up" | "await_signal" | "await_store" | "await_status" | "deadline";
type ScheduledStatus = "pending" | "fired" | "cancelled" | "superseded";

interface TriggerCondition {
  signalType?: SignalType;
  signalFromAgent?: string;
  statusIn?: string[];
  storeKey?: string;
  storeEquals?: unknown;
}

interface AutoCancelOn extends TriggerCondition {}

interface ScheduledCheck {
  id: string;
  ownerAgent: string;
  ownerVmId: string | null;
  targetAgent: string | null;
  targetVmId: string | null;
  taskId: string | null;
  subtreeRootVmId: string | null;
  kind: ScheduledKind;
  message: string;
  payload: Record<string, unknown> | null;
  triggerOn: TriggerCondition | null;
  autoCancelOn: AutoCancelOn | null;
  dueAt: number;
  status: ScheduledStatus;
  statusReason: string | null;
  createdAt: number;
  updatedAt: number;
  firedAt: number | null;
  cancelledAt: number | null;
  supersededAt: number | null;
}

let vmTreeStore: VMTreeStore | null = null;
let db: Database | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

function parseDelay(delay?: string): number | null {
  if (!delay) return null;
  const match = delay.trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith("s")) return value * 1000;
  if (unit.startsWith("m")) return value * 60 * 1000;
  if (unit.startsWith("h")) return value * 60 * 60 * 1000;
  return null;
}

function initTable() {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_checks (
      id                TEXT PRIMARY KEY,
      owner_agent       TEXT NOT NULL,
      owner_vm_id       TEXT,
      target_agent      TEXT,
      target_vm_id      TEXT,
      task_id           TEXT,
      subtree_root_vm_id TEXT,
      kind              TEXT NOT NULL,
      message           TEXT NOT NULL,
      payload           TEXT,
      trigger_on        TEXT,
      auto_cancel_on    TEXT,
      due_at            INTEGER NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      status_reason     TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      fired_at          INTEGER,
      cancelled_at      INTEGER,
      superseded_at     INTEGER
    )
  `);
  const columns = db.query("PRAGMA table_info(scheduled_checks)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has("trigger_on")) {
    db.exec("ALTER TABLE scheduled_checks ADD COLUMN trigger_on TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_checks(status, due_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_owner ON scheduled_checks(owner_agent, status, due_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_target ON scheduled_checks(target_agent, status, due_at)");
}

function rowToScheduled(row: any): ScheduledCheck {
  return {
    id: row.id,
    ownerAgent: row.owner_agent,
    ownerVmId: row.owner_vm_id || null,
    targetAgent: row.target_agent || null,
    targetVmId: row.target_vm_id || null,
    taskId: row.task_id || null,
    subtreeRootVmId: row.subtree_root_vm_id || null,
    kind: row.kind,
    message: row.message,
    payload: row.payload ? JSON.parse(row.payload) : null,
    triggerOn: row.trigger_on ? JSON.parse(row.trigger_on) : null,
    autoCancelOn: row.auto_cancel_on ? JSON.parse(row.auto_cancel_on) : null,
    dueAt: row.due_at,
    status: row.status,
    statusReason: row.status_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    firedAt: row.fired_at || null,
    cancelledAt: row.cancelled_at || null,
    supersededAt: row.superseded_at || null,
  };
}

function queryScheduled(
  filters: {
    status?: ScheduledStatus;
    ownerAgent?: string;
    targetAgent?: string;
    kind?: ScheduledKind;
    dueBefore?: number;
    limit?: number;
  } = {},
): ScheduledCheck[] {
  if (!db) return [];
  let sql = "SELECT * FROM scheduled_checks";
  const conditions: string[] = [];
  const params: any[] = [];
  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.ownerAgent) {
    conditions.push("owner_agent = ?");
    params.push(filters.ownerAgent);
  }
  if (filters.targetAgent) {
    conditions.push("target_agent = ?");
    params.push(filters.targetAgent);
  }
  if (filters.kind) {
    conditions.push("kind = ?");
    params.push(filters.kind);
  }
  if (filters.dueBefore) {
    conditions.push("due_at <= ?");
    params.push(filters.dueBefore);
  }
  if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
  sql += " ORDER BY due_at ASC";
  if (filters.limit) sql += ` LIMIT ${filters.limit}`;
  return db
    .query(sql)
    .all(...params)
    .map(rowToScheduled);
}

function insertScheduled(input: {
  ownerAgent: string;
  ownerVmId?: string | null;
  targetAgent?: string | null;
  targetVmId?: string | null;
  taskId?: string | null;
  subtreeRootVmId?: string | null;
  kind: ScheduledKind;
  message: string;
  payload?: Record<string, unknown> | null;
  triggerOn?: TriggerCondition | null;
  autoCancelOn?: AutoCancelOn | null;
  dueAt: number;
}) {
  if (!db) throw new Error("scheduled DB unavailable");
  const now = Date.now();
  const id = ulid();
  db.run(
    `INSERT INTO scheduled_checks (
      id, owner_agent, owner_vm_id, target_agent, target_vm_id, task_id, subtree_root_vm_id,
      kind, message, payload, trigger_on, auto_cancel_on, due_at, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id,
      input.ownerAgent,
      input.ownerVmId || null,
      input.targetAgent || null,
      input.targetVmId || null,
      input.taskId || null,
      input.subtreeRootVmId || null,
      input.kind,
      input.message,
      input.payload ? JSON.stringify(input.payload) : null,
      input.triggerOn ? JSON.stringify(input.triggerOn) : null,
      input.autoCancelOn ? JSON.stringify(input.autoCancelOn) : null,
      input.dueAt,
      now,
      now,
    ],
  );
  return getScheduled(id)!;
}

function updateScheduledStatus(id: string, status: ScheduledStatus, reason?: string) {
  if (!db) throw new Error("scheduled DB unavailable");
  const now = Date.now();
  db.run(
    `UPDATE scheduled_checks
       SET status = ?, status_reason = ?, updated_at = ?, fired_at = ?, cancelled_at = ?, superseded_at = ?
     WHERE id = ?`,
    [
      status,
      reason || null,
      now,
      status === "fired" ? now : null,
      status === "cancelled" ? now : null,
      status === "superseded" ? now : null,
      id,
    ],
  );
}

function getScheduled(id: string): ScheduledCheck | undefined {
  if (!db) return undefined;
  const row = db.query("SELECT * FROM scheduled_checks WHERE id = ?").get(id) as any;
  return row ? rowToScheduled(row) : undefined;
}

function matchCondition(check: ScheduledCheck, condition: TriggerCondition | null | undefined): string | null {
  if (!condition || !vmTreeStore) return null;

  if (condition.signalType) {
    const matched = vmTreeStore.querySignals({
      fromAgent: condition.signalFromAgent || check.targetAgent || undefined,
      signalType: condition.signalType,
      since: check.createdAt,
      limit: 1,
    });
    if (matched.length > 0) {
      return `matching signal ${condition.signalType}`;
    }
  }

  if (condition.statusIn && condition.statusIn.length > 0) {
    const target =
      (check.targetVmId && vmTreeStore.getVM(check.targetVmId)) ||
      (check.targetAgent && vmTreeStore.getVMByName(check.targetAgent, { activeOnly: false }));
    if (target && condition.statusIn.includes(target.status)) {
      return `target status became ${target.status}`;
    }
  }

  if (condition.storeKey) {
    const entry = vmTreeStore.storeGet(condition.storeKey);
    if (entry) {
      if (
        condition.storeEquals === undefined ||
        JSON.stringify(entry.value) === JSON.stringify(condition.storeEquals)
      ) {
        return `store condition matched ${condition.storeKey}`;
      }
    }
  }

  return null;
}

function shouldAutoCancel(check: ScheduledCheck): string | null {
  const matched = matchCondition(check, check.autoCancelOn);
  return matched ? `auto-cancelled after ${matched}` : null;
}

function fireScheduled(check: ScheduledCheck, reason?: string) {
  if (!vmTreeStore) return;
  const targetName = check.targetAgent || check.ownerAgent;
  const target =
    (check.targetVmId && vmTreeStore.getVM(check.targetVmId)) ||
    (targetName && vmTreeStore.getVMByName(targetName, { activeOnly: false }));

  const payload = {
    source: "scheduled",
    scheduledCheckId: check.id,
    kind: check.kind,
    message: check.message,
    payload: check.payload,
  } as Record<string, unknown>;

  if (target && (target.status === "creating" || target.status === "running" || target.status === "paused")) {
    const signal = vmTreeStore.insertSignal({
      fromAgent: "reef-scheduler",
      toAgent: target.name,
      direction: "down",
      signalType: "steer",
      payload,
    });
    updateScheduledStatus(check.id, "fired", reason || `delivered to ${target.name}`);
    return signal;
  }

  if (target) {
    vmTreeStore.insertLog({
      agentId: target.vmId,
      agentName: target.name,
      level: "warn",
      category: "scheduled",
      message: `Scheduled check fired but target was not active: ${check.message}`,
      metadata: payload,
    });
  }
  updateScheduledStatus(
    check.id,
    "fired",
    reason || (target ? `target ${target.name} inactive at fire time` : "no target available"),
  );
  return null;
}

async function tickScheduled() {
  const now = Date.now();
  const pending = queryScheduled({ status: "pending", limit: 100 });
  for (const check of pending) {
    const reason = shouldAutoCancel(check);
    if (reason) {
      updateScheduledStatus(check.id, "superseded", reason);
      continue;
    }

    const triggerMatched = matchCondition(check, check.triggerOn);
    if (triggerMatched) {
      fireScheduled(check, `triggered after ${triggerMatched}`);
      continue;
    }

    const isAwaiting = check.kind === "await_signal" || check.kind === "await_store" || check.kind === "await_status";
    if (isAwaiting) {
      if (check.dueAt > 0 && check.dueAt <= now) {
        fireScheduled(check, `timed out waiting for ${check.kind}`);
      }
      continue;
    }

    if (check.dueAt <= now) {
      fireScheduled(check);
    }
  }
}

const app = new Hono();

app.get("/", (c) => {
  const status = c.req.query("status") as ScheduledStatus | undefined;
  const ownerAgent = c.req.query("ownerAgent") || undefined;
  const targetAgent = c.req.query("targetAgent") || undefined;
  const kind = c.req.query("kind") as ScheduledKind | undefined;
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
  const checks = queryScheduled({ status, ownerAgent, targetAgent, kind, limit });
  return c.json({ checks, count: checks.length });
});

app.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const actorName = c.req.header("X-Reef-Agent-Name") || process.env.VERS_AGENT_NAME || "root-reef";
  const actorVmId = c.req.header("X-Reef-VM-ID") || process.env.VERS_VM_ID || null;
  const {
    targetAgent,
    targetVmId,
    taskId,
    subtreeRootVmId,
    kind,
    message,
    payload,
    triggerOn,
    autoCancelOn,
    delay,
    dueAt,
  } = body as {
    targetAgent?: string;
    targetVmId?: string;
    taskId?: string;
    subtreeRootVmId?: string;
    kind?: ScheduledKind;
    message?: string;
    payload?: Record<string, unknown>;
    triggerOn?: TriggerCondition;
    autoCancelOn?: AutoCancelOn;
    delay?: string;
    dueAt?: number | string;
  };

  if (!kind || !message) return c.json({ error: "kind and message are required" }, 400);
  const requiresTrigger = kind === "await_signal" || kind === "await_store" || kind === "await_status";
  const delayMs = delay ? parseDelay(delay) : null;
  let resolvedDueAt: number | null = null;
  if (typeof dueAt === "number") resolvedDueAt = dueAt;
  else if (typeof dueAt === "string" && dueAt.trim()) {
    const parsed = Date.parse(dueAt);
    resolvedDueAt = Number.isFinite(parsed) ? parsed : null;
  } else if (delayMs !== null) {
    resolvedDueAt = Date.now() + delayMs;
  }
  if (requiresTrigger) {
    if (!triggerOn) {
      return c.json({ error: "triggerOn is required for await_signal, await_store, and await_status" }, 400);
    }
    resolvedDueAt ??= 0;
  } else if (!resolvedDueAt) {
    return c.json({ error: "delay or dueAt is required" }, 400);
  }

  const created = insertScheduled({
    ownerAgent: actorName,
    ownerVmId: actorVmId,
    targetAgent: targetAgent || null,
    targetVmId: targetVmId || null,
    taskId: taskId || null,
    subtreeRootVmId: subtreeRootVmId || null,
    kind,
    message,
    payload: payload || null,
    triggerOn: triggerOn || null,
    autoCancelOn: autoCancelOn || null,
    dueAt: resolvedDueAt,
  });

  return c.json(created, 201);
});

app.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const existing = getScheduled(id);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (existing.status !== "pending") return c.json(existing);
  updateScheduledStatus(id, "cancelled", "cancelled explicitly");
  return c.json(getScheduled(id));
});

app.post("/_tick", async (c) => {
  await tickScheduled();
  return c.json({ ok: true });
});

const routeDocs: Record<string, RouteDocs> = {
  "GET /": {
    summary: "List scheduled checks",
    query: {
      status: { type: "string", description: "pending | fired | cancelled | superseded" },
      ownerAgent: { type: "string", description: "Filter by owner agent name" },
      targetAgent: { type: "string", description: "Filter by target agent name" },
      kind: { type: "string", description: "follow_up | await_signal | await_store | await_status | deadline" },
      limit: { type: "number", description: "Maximum checks to return" },
    },
  },
  "POST /": {
    summary: "Create a scheduled check",
    body: {
      kind: { type: "string", required: true, description: "Scheduled check type" },
      message: { type: "string", required: true, description: "What to do when the check fires" },
      delay: {
        type: "string",
        description:
          "Delay like 30s, 5m, 1h. Required for follow_up/deadline, optional as a timeout for await_* kinds.",
      },
      dueAt: {
        type: "string|number",
        description:
          "Absolute due time as ms or ISO string. Required for follow_up/deadline, optional timeout for await_* kinds.",
      },
      targetAgent: { type: "string", description: "Agent to notify when this fires" },
      taskId: { type: "string", description: "Optional task identifier" },
      triggerOn: {
        type: "object",
        description: "Condition that causes await_* checks to fire immediately when matched",
      },
      autoCancelOn: { type: "object", description: "Signal/status/store condition that supersedes this check" },
    },
  },
  "POST /:id/cancel": { summary: "Cancel a pending scheduled check" },
};

const mod: ServiceModule = {
  name: "scheduled",
  description: "Durable scheduled orchestration checks",
  routes: app,
  routeDocs,
  dependencies: ["vm-tree"],
  init(ctx: ServiceContext) {
    const handle = ctx.getStore<any>("vm-tree");
    if (!handle?.vmTreeStore) return;
    vmTreeStore = handle.vmTreeStore as VMTreeStore;
    db = vmTreeStore.getDb();
    initTable();

    if (!schedulerTimer) {
      schedulerTimer = setInterval(() => {
        tickScheduled().catch((err) => {
          console.error(`  [scheduled] tick failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, 1000);
      if (schedulerTimer.unref) schedulerTimer.unref();
    }
  },
  store: {
    async close() {
      if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = null;
      }
    },
  },
  registerTools(pi: ExtensionAPI, client: FleetClient) {
    pi.registerTool({
      name: "reef_schedule_check",
      label: "Reef: Schedule Check",
      description:
        "Create a durable scheduled orchestration check. Use follow_up/deadline for time-based checks, and await_* kinds with triggerOn for condition-first fleet coordination.",
      parameters: Type.Object({
        kind: Type.Union(
          [
            Type.Literal("follow_up"),
            Type.Literal("await_signal"),
            Type.Literal("await_store"),
            Type.Literal("await_status"),
            Type.Literal("deadline"),
          ],
          { description: "Scheduled check type" },
        ),
        message: Type.String({ description: "What to do when the check fires" }),
        delay: Type.Optional(
          Type.String({
            description:
              "Delay like 30s, 5m, 1h. Required for follow_up/deadline, optional as a timeout for await_* kinds.",
          }),
        ),
        dueAt: Type.Optional(
          Type.String({
            description:
              "Absolute due time as an ISO timestamp. Required for follow_up/deadline, optional timeout for await_* kinds.",
          }),
        ),
        targetAgent: Type.Optional(Type.String({ description: "Agent to notify when this fires" })),
        taskId: Type.Optional(Type.String({ description: "Optional task identifier" })),
        triggerOn: Type.Optional(
          Type.Any({
            description:
              "Condition that causes await_signal/await_store/await_status checks to fire when matched. Example: { storeKey: 'peer-b:coord/phase', storeEquals: 'ready' }",
          }),
        ),
        autoCancelOn: Type.Optional(
          Type.Any({ description: "Signal/status/store condition that supersedes this check" }),
        ),
        payload: Type.Optional(Type.Any({ description: "Extra structured context" })),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const result = await client.api<any>("POST", "/scheduled", params);
          return client.ok(
            `Scheduled ${result.kind} check ${result.id} for ${new Date(result.dueAt).toLocaleString()}.`,
            result,
          );
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });

    pi.registerTool({
      name: "reef_scheduled",
      label: "Reef: List Scheduled Checks",
      description: "List scheduled checks and their current status.",
      parameters: Type.Object({
        status: Type.Optional(
          Type.Union([
            Type.Literal("pending"),
            Type.Literal("fired"),
            Type.Literal("cancelled"),
            Type.Literal("superseded"),
          ]),
        ),
        ownerAgent: Type.Optional(Type.String({ description: "Filter by owner" })),
        targetAgent: Type.Optional(Type.String({ description: "Filter by target" })),
        kind: Type.Optional(
          Type.Union([
            Type.Literal("follow_up"),
            Type.Literal("await_signal"),
            Type.Literal("await_store"),
            Type.Literal("await_status"),
            Type.Literal("deadline"),
          ]),
        ),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const qs = new URLSearchParams();
          if (params.status) qs.set("status", params.status);
          if (params.ownerAgent) qs.set("ownerAgent", params.ownerAgent);
          if (params.targetAgent) qs.set("targetAgent", params.targetAgent);
          if (params.kind) qs.set("kind", params.kind);
          const result = await client.api<any>("GET", `/scheduled${qs.toString() ? `?${qs.toString()}` : ""}`);
          const lines = (result.checks || []).map(
            (check: any) =>
              `[${check.status}] ${check.id} ${check.kind} -> ${check.targetAgent || check.ownerAgent} @ ${check.dueAt > 0 ? new Date(check.dueAt).toLocaleTimeString() : "no-timeout"} :: ${check.message}`,
          );
          return client.ok(lines.length ? lines.join("\n") : "No scheduled checks.", result);
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });

    pi.registerTool({
      name: "reef_cancel_scheduled",
      label: "Reef: Cancel Scheduled Check",
      description: "Cancel a pending scheduled check by ID.",
      parameters: Type.Object({
        id: Type.String({ description: "Scheduled check ID" }),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const result = await client.api<any>("POST", `/scheduled/${encodeURIComponent(params.id)}/cancel`);
          return client.ok(`Scheduled check ${params.id} is now ${result.status}.`, result);
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });
  },
  widget: {
    async getLines(client: FleetClient) {
      try {
        const result = await client.api<any>("GET", "/scheduled?status=pending");
        if (!result.count) return [];
        return [`Scheduled: ${result.count} pending check${result.count === 1 ? "" : "s"}`];
      } catch {
        return [];
      }
    },
  },
};

export default mod;
