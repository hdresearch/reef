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

function storePut(key: string, value: unknown) {
  if (vmTreeStore) return vmTreeStore.storePut(key, value);
  const now = Date.now();
  const existing = fallback.get(key);
  fallback.set(key, { value, createdAt: existing?.createdAt ?? now, updatedAt: now });
  return { key, value, agentName: null, agentId: null, createdAt: existing?.createdAt ?? now, updatedAt: now };
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
  const entries = storeList();
  const keys = entries.map((e) => ({ key: e.key, createdAt: e.createdAt, updatedAt: e.updatedAt }));
  return c.json({ keys });
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

  // v2: Server-side namespace enforcement — non-root agents must prefix keys with their name
  if (callerCategory !== "infra_vm" && callerName) {
    const prefix = `${callerName}:`;
    if (!key.startsWith(prefix)) {
      return c.json(
        { error: `Store namespacing: key must start with "${prefix}" (your agent name). Got "${key}".` },
        403,
      );
    }
  }

  const body = await c.req.json();
  const result = storePut(key, body.value);
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
        { error: `Store namespacing: key must start with "${prefix}" (your agent name). Got "${key}".` },
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
                `Store namespacing: key must start with "${prefix}" (your agent name). Got "${params.key}".`,
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
      description: "List all keys in the reef key-value store.",
      parameters: Type.Object({}),
      async execute() {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const data = await client.api<any>("GET", "/store");
          const keys = data.keys.map((k: any) => k.key);
          return client.ok(keys.length ? keys.join("\n") : "Store is empty.", { keys });
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });
  },
};

export default mod;
