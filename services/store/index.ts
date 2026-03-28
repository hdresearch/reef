/**
 * Key-value store service — persistence primitive for agents.
 *
 * v2: Backed by SQLite (store + store_history tables in the unified fleet.sqlite).
 * Every write is versioned in store_history with agent lineage tracking.
 * Same API as v1 — transparent backend change.
 *
 * Agents use this to pass state between tasks, coordinate work, and
 * persist data that survives VM destruction.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import type { FleetClient, RouteDocs, ServiceContext, ServiceModule } from "../../src/core/types.js";
import type { VMTreeStore } from "../vm-tree/store.js";

let vmTreeStore: VMTreeStore | null = null;

// Fallback in-memory store for when vm-tree isn't available (e.g. tests)
const fallback = new Map<string, { value: unknown; createdAt: number; updatedAt: number }>();

function storeGet(key: string) {
  if (vmTreeStore) return vmTreeStore.storeGet(key);
  const entry = fallback.get(key);
  return entry
    ? {
        key,
        value: entry.value,
        agentName: null,
        agentId: null,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }
    : undefined;
}

function storePut(key: string, value: unknown, agentName?: string, agentId?: string) {
  if (vmTreeStore) return vmTreeStore.storePut(key, value, agentName, agentId);
  const now = Date.now();
  const existing = fallback.get(key);
  fallback.set(key, { value, createdAt: existing?.createdAt ?? now, updatedAt: now });
  return {
    key,
    value,
    agentName: agentName || null,
    agentId: agentId || null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function storeDelete(key: string): boolean {
  if (vmTreeStore) return vmTreeStore.storeDelete(key);
  return fallback.delete(key);
}

function storeList() {
  if (vmTreeStore) return vmTreeStore.storeList();
  return Array.from(fallback.entries()).map(([key, entry]) => ({
    key,
    value: entry.value,
    agentName: null,
    agentId: null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }));
}

function storeFilter(options: { prefix?: string; agentName?: string; limit?: number }) {
  const prefix = options.prefix?.trim();
  let entries = storeList();
  if (options.agentName) {
    entries = entries.filter((entry) => entry.agentName === options.agentName);
  }
  if (prefix) {
    entries = entries.filter((entry) => {
      if (entry.key.startsWith(prefix)) return true;
      const colon = entry.key.indexOf(":");
      if (colon === -1) return false;
      return entry.key.slice(colon + 1).startsWith(prefix);
    });
  }
  if (options.limit && options.limit > 0) {
    entries = entries.slice(0, options.limit);
  }
  return entries;
}

function resolveStoreEntriesForKey(key: string) {
  const direct = storeGet(key);
  if (direct) return [direct];
  const trimmed = key.trim();
  if (!trimmed || trimmed.includes(":")) return [];
  return storeList().filter((entry) => {
    const colon = entry.key.indexOf(":");
    if (colon === -1) return false;
    return entry.key.slice(colon + 1) === trimmed;
  });
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function waitForStoreCondition(options: {
  key?: string;
  prefix?: string;
  equals?: unknown;
  minCount?: number;
  timeoutSeconds?: number;
  pollMs?: number;
}) {
  const timeoutMs = Math.max(1, options.timeoutSeconds || 60) * 1000;
  const pollMs = Math.max(50, options.pollMs || 250);
  const startedAt = Date.now();

  const check = () => {
    if (options.key) {
      const entries = resolveStoreEntriesForKey(options.key);
      if (entries.length === 0) return { matched: false, entries: [] as ReturnType<typeof storeList> };
      if (options.equals !== undefined) {
        const matching = entries.filter((entry) => valuesEqual(entry.value, options.equals));
        if (matching.length === 0) {
          return { matched: false, entries };
        }
        return { matched: true, entries: matching };
      }
      return { matched: true, entries };
    }

    const entries = storeFilter({
      prefix: options.prefix,
      limit: undefined,
    });
    const minCount = Math.max(1, options.minCount || 1);
    if (entries.length < minCount) return { matched: false, entries };
    return { matched: true, entries };
  };

  while (Date.now() - startedAt < timeoutMs) {
    const result = check();
    if (result.matched) {
      return {
        matched: true,
        timedOut: false,
        elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
        entries: result.entries,
      };
    }
    await Bun.sleep(pollMs);
  }

  const final = check();
  return {
    matched: false,
    timedOut: true,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
    entries: final.entries,
  };
}

// =============================================================================
// Migration: import data/store.json into SQLite on first init
// =============================================================================

async function migrateFromJson() {
  if (!vmTreeStore) return;
  try {
    const file = Bun.file("data/store.json");
    if (!(await file.exists())) return;

    // Only migrate if store table is empty
    const existing = vmTreeStore.storeList();
    if (existing.length > 0) return;

    const data = await file.json();
    let migrated = 0;
    for (const [key, entry] of Object.entries(data)) {
      const e = entry as any;
      if (e?.value !== undefined) {
        vmTreeStore.storePut(key, e.value);
        migrated++;
      }
    }
    if (migrated > 0) {
      console.log(`  [store] migrated ${migrated} entries from data/store.json to SQLite`);
    }
  } catch {
    /* ignore migration errors */
  }
}

// =============================================================================
// Routes
// =============================================================================

const app = new Hono();

// GET /store — list all keys
app.get("/", (c) => {
  const prefix = c.req.query("prefix") || undefined;
  const agentName = c.req.query("agent") || undefined;
  const includeValues = c.req.query("includeValues") === "1" || c.req.query("includeValues") === "true";
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
  const entries = storeFilter({ prefix, agentName, limit });
  const keys = entries.map((e) => ({
    key: e.key,
    agentName: e.agentName,
    agentId: e.agentId,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    ...(includeValues ? { value: e.value } : {}),
  }));
  return c.json({ keys });
});

// POST /store/wait — block until a key/prefix condition becomes true
app.post("/wait", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { key, prefix, equals, minCount, timeoutSeconds, pollMs } = body as {
    key?: string;
    prefix?: string;
    equals?: unknown;
    minCount?: number;
    timeoutSeconds?: number;
    pollMs?: number;
  };

  if (!key && !prefix) {
    return c.json({ error: "key or prefix is required" }, 400);
  }
  if (key && prefix) {
    return c.json({ error: "provide either key or prefix, not both" }, 400);
  }

  const result = await waitForStoreCondition({ key, prefix, equals, minCount, timeoutSeconds, pollMs });
  return c.json(result);
});

// GET /store/:key — get a value
app.get("/:key", (c) => {
  const key = c.req.param("key");
  const entry = storeGet(key);
  if (!entry) return c.json({ error: "not found" }, 404);
  return c.json({ key, value: entry.value, createdAt: entry.createdAt, updatedAt: entry.updatedAt });
});

// PUT /store/:key — set a value (server-side namespace enforcement)
app.put("/:key", async (c) => {
  const key = c.req.param("key");
  const callerCategory = c.req.header("X-Reef-Category") || "infra_vm";
  const callerName = c.req.header("X-Reef-Agent-Name");
  const callerVmId = c.req.header("X-Reef-VM-ID") || undefined;

  // v2: Server-side namespace enforcement — non-root agents must prefix keys with their name
  if (callerCategory !== "infra_vm" && callerName) {
    const prefix = `${callerName}:`;
    if (!key.startsWith(prefix)) {
      return c.json(
        {
          error: `Store namespacing: key must start with "${prefix}" (your agent name). Got "${key}". Try "${prefix}${key}" for your own writes. Use reef_store_list or reef_store_wait with a prefix for cross-agent coordination.`,
        },
        403,
      );
    }
  }

  const body = await c.req.json();
  const result = storePut(key, body.value, callerName || undefined, callerVmId);
  return c.json({ key, value: body.value, updatedAt: result.updatedAt });
});

// DELETE /store/:key — delete a key (server-side namespace enforcement)
app.delete("/:key", (c) => {
  const key = c.req.param("key");
  const callerCategory = c.req.header("X-Reef-Category") || "infra_vm";
  const callerName = c.req.header("X-Reef-Agent-Name");

  if (callerCategory !== "infra_vm" && callerName) {
    const prefix = `${callerName}:`;
    if (!key.startsWith(prefix)) {
      return c.json(
        {
          error: `Store namespacing: key must start with "${prefix}" (your agent name). Got "${key}". Try "${prefix}${key}" for your own writes. Use reef_store_list or reef_store_wait with a prefix for cross-agent coordination.`,
        },
        403,
      );
    }
  }

  if (!storeGet(key)) return c.json({ error: "not found" }, 404);
  storeDelete(key);
  return c.json({ deleted: key });
});

// GET /store/:key/history — get write history for a key
app.get("/:key/history", (c) => {
  const key = c.req.param("key");
  if (!vmTreeStore) return c.json({ error: "history not available" }, 503);
  const history = vmTreeStore.storeHistory(key);
  return c.json({ key, history, count: history.length });
});

// GET /store/_panel — debug view of all keys
app.get("/_panel", (c) => {
  const entries = storeList();
  const rows = entries
    .map((e) => {
      const val = JSON.stringify(e.value);
      const preview = val.length > 80 ? `${val.slice(0, 80)}…` : val;
      const age = e.updatedAt ? new Date(e.updatedAt).toLocaleString() : "—";
      return `<tr><td style="color:#4f9;font-weight:600">${esc(e.key)}</td><td style="color:#888">${esc(preview)}</td><td style="color:#666;font-size:11px">${esc(age)}</td></tr>`;
    })
    .join("");

  return c.html(`
		<div style="font-family:monospace;font-size:13px;color:#ccc">
			<div style="margin-bottom:8px;color:#888">${entries.length} key${entries.length !== 1 ? "s" : ""} in store (SQLite)</div>
			${
        entries.length === 0
          ? '<div style="color:#666;font-style:italic">Store is empty</div>'
          : `<table style="width:100%;border-collapse:collapse">
						<thead><tr style="color:#666;font-size:11px;text-align:left;border-bottom:1px solid #333">
							<th style="padding:4px 8px">Key</th><th style="padding:4px 8px">Value</th><th style="padding:4px 8px">Updated</th>
						</tr></thead>
						<tbody>${rows}</tbody>
					</table>`
      }
		</div>
	`);
});

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// =============================================================================
// Route documentation
// =============================================================================

const routeDocs: Record<string, RouteDocs> = {
  "GET /_panel": { summary: "HTML debug view of all stored keys and values", response: "text/html" },
  "GET /": { summary: "List all keys", response: "{ keys: [{ key, createdAt, updatedAt }] }" },
  "POST /wait": {
    summary: "Wait for a key or prefix condition to become true",
    body: {
      key: { type: "string", description: "Exact key to wait for" },
      prefix: { type: "string", description: "Prefix to scan for matching keys" },
      equals: { type: "any", description: "Optional exact JSON value to wait for when using key" },
      minCount: { type: "number", description: "Minimum matching keys required when using prefix" },
      timeoutSeconds: { type: "number", description: "Max seconds to wait (default: 60)" },
      pollMs: { type: "number", description: "Polling interval in milliseconds (default: 250)" },
    },
    response: "{ matched, timedOut, elapsedSeconds, entries }",
  },
  "GET /:key": {
    summary: "Get a value by key",
    params: { key: { type: "string", required: true, description: "The key to look up" } },
    response: "{ key, value, createdAt, updatedAt }",
  },
  "PUT /:key": {
    summary: "Set a value (creates write history entry)",
    params: { key: { type: "string", required: true, description: "The key to set" } },
    body: { value: { type: "any", required: true, description: "The value to store (any JSON)" } },
    response: "{ key, value, updatedAt }",
  },
  "DELETE /:key": {
    summary: "Delete a key",
    params: { key: { type: "string", required: true, description: "The key to delete" } },
    response: "{ deleted: key }",
  },
  "GET /:key/history": {
    summary: "Get write history for a key (versioned state)",
    params: { key: { type: "string", required: true, description: "The key to get history for" } },
    response: "{ key, history: [{ value, agentName, agentId, writtenAt }], count }",
  },
};

// =============================================================================
// Module
// =============================================================================

const mod: ServiceModule = {
  name: "store",
  description: "Key-value store — SQLite-backed persistence for agents with write history",
  routes: app,
  routeDocs,

  async init(ctx: ServiceContext) {
    // Get the shared vm-tree store
    const storeHandle = ctx.getStore<any>("vm-tree");
    if (storeHandle?.vmTreeStore) {
      vmTreeStore = storeHandle.vmTreeStore;
      await migrateFromJson();
    }
  },

  store: {
    flush() {
      /* SQLite WAL handles durability */
    },
  },

  dependencies: ["vm-tree"],

  registerTools(pi: ExtensionAPI, client: FleetClient) {
    pi.registerTool({
      name: "reef_store_get",
      label: "Reef: Get Value",
      description:
        "Get a value from the reef key-value store. Use this to retrieve state saved by yourself or other agents.",
      parameters: Type.Object({
        key: Type.String({ description: "The key to look up" }),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const data = await client.api<any>("GET", `/store/${encodeURIComponent(params.key)}`);
          return client.ok(JSON.stringify(data.value, null, 2), { key: params.key, value: data.value });
        } catch (e: any) {
          if (e.message?.includes("404")) return client.ok(`Key "${params.key}" not found.`);
          return client.err(e.message);
        }
      },
    });

    pi.registerTool({
      name: "reef_store_put",
      label: "Reef: Set Value",
      description:
        "Store a value in the reef key-value store. Use this to save state, pass data to other agents, or persist results across tasks. Every write is versioned — history is queryable.",
      parameters: Type.Object({
        key: Type.String({ description: "The key to set" }),
        value: Type.Any({ description: "The value to store (any JSON — string, number, object, array)" }),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          // v2: Enforce namespacing — non-root agents can only write keys prefixed with their name
          const category = client.agentCategory;
          if (category !== "infra_vm") {
            const prefix = `${client.agentName}:`;
            if (!params.key.startsWith(prefix)) {
              return client.err(
                `Store namespacing: key must start with "${prefix}" (your agent name). Got "${params.key}". Try "${prefix}${params.key}" for your own writes. Use reef_store_list or reef_store_wait with a prefix for cross-agent coordination.`,
              );
            }
          }
          await client.api("PUT", `/store/${encodeURIComponent(params.key)}`, { value: params.value });
          return client.ok(`Stored "${params.key}".`);
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });

    pi.registerTool({
      name: "reef_store_list",
      label: "Reef: List Keys",
      description:
        "List keys in the reef key-value store, optionally filtered by prefix. Use this to discover coordination keys and artifact handoffs without guessing exact namespaced keys.",
      parameters: Type.Object({
        prefix: Type.Optional(Type.String({ description: "Only include keys starting with this prefix" })),
        includeValues: Type.Optional(Type.Boolean({ description: "Include current values in the result" })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of keys to return" })),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const qs = new URLSearchParams();
          if (params.prefix) qs.set("prefix", params.prefix);
          if (params.includeValues) qs.set("includeValues", "1");
          if (params.limit) qs.set("limit", String(params.limit));
          const data = await client.api<any>("GET", `/store${qs.toString() ? `?${qs.toString()}` : ""}`);
          const lines = (data.keys || []).map((k: any) =>
            params.includeValues
              ? `${k.key} = ${JSON.stringify(k.value)}`
              : `${k.key}${k.agentName ? ` (owner: ${k.agentName})` : ""}`,
          );
          return client.ok(lines.length ? lines.join("\n") : "Store is empty.", { keys: data.keys || [] });
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });

    pi.registerTool({
      name: "reef_store_wait",
      label: "Reef: Wait On Store",
      description:
        "Wait for a store condition instead of writing your own polling loop. Use this for barriers, rendezvous, phase gates, and artifact availability checks.",
      parameters: Type.Object({
        key: Type.Optional(Type.String({ description: "Exact key to wait for" })),
        prefix: Type.Optional(Type.String({ description: "Prefix to scan for matching keys" })),
        equals: Type.Optional(Type.Any({ description: "Optional exact JSON value required when using key" })),
        minCount: Type.Optional(Type.Number({ description: "Minimum matching key count when using prefix" })),
        timeoutSeconds: Type.Optional(Type.Number({ description: "Max seconds to wait (default: 60)" })),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const data = await client.api<any>("POST", "/store/wait", {
            key: params.key,
            prefix: params.prefix,
            equals: params.equals,
            minCount: params.minCount,
            timeoutSeconds: params.timeoutSeconds,
          });
          const keys = (data.entries || []).map((entry: any) => entry.key);
          const summary = data.matched
            ? `Store wait matched in ${data.elapsedSeconds}s.`
            : `Store wait timed out after ${data.elapsedSeconds}s.`;
          return client.ok(`${summary}\n${keys.length ? keys.join("\n") : "(no matching keys yet)"}`, data);
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });
  },
};

export default mod;
