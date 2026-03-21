/**
 * Key-value store service — a simple persistence primitive for agents.
 *
 * Agents use this to pass state between tasks, coordinate work, and
 * persist small pieces of data. Not a database — just keys and values.
 *
 * All values are stored as JSON in data/store.json.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import type { FleetClient, RouteDocs, ServiceModule } from "../../src/core/types.js";

interface StoreEntry {
  value: unknown;
  updatedAt: number;
  createdAt: number;
}

const STORE_PATH = "data/store.json";
let entries: Record<string, StoreEntry> = {};

async function load() {
  try {
    const file = Bun.file(STORE_PATH);
    if (await file.exists()) {
      entries = await file.json();
    }
  } catch {
    entries = {};
  }
}

async function save() {
  await Bun.write(STORE_PATH, JSON.stringify(entries, null, 2));
}

async function ensureDataDir() {
  const { mkdirSync } = await import("node:fs");
  try {
    mkdirSync("data", { recursive: true });
  } catch {}
}

const app = new Hono();

// GET /store — list all keys
app.get("/", (c) => {
  const keys = Object.keys(entries).map((key) => ({
    key,
    createdAt: entries[key].createdAt,
    updatedAt: entries[key].updatedAt,
  }));
  return c.json({ keys });
});

// GET /store/:key — get a value
app.get("/:key", (c) => {
  const key = c.req.param("key");
  const entry = entries[key];
  if (!entry) return c.json({ error: "not found" }, 404);
  return c.json({ key, value: entry.value, createdAt: entry.createdAt, updatedAt: entry.updatedAt });
});

// PUT /store/:key — set a value
app.put("/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json();
  const now = Date.now();
  const existing = entries[key];
  entries[key] = {
    value: body.value,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await save();
  return c.json({ key, value: body.value, updatedAt: now });
});

// DELETE /store/:key — delete a key
app.delete("/:key", async (c) => {
  const key = c.req.param("key");
  if (!entries[key]) return c.json({ error: "not found" }, 404);
  delete entries[key];
  await save();
  return c.json({ deleted: key });
});

// GET /store/_panel — debug view of all keys
app.get("/_panel", (c) => {
  const keys = Object.keys(entries);
  const rows = keys
    .sort()
    .map((key) => {
      const entry = entries[key];
      const val = JSON.stringify(entry.value);
      const preview = val.length > 80 ? `${val.slice(0, 80)}…` : val;
      const age = entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : "—";
      return `<tr><td style="color:#4f9;font-weight:600">${esc(key)}</td><td style="color:#888">${esc(preview)}</td><td style="color:#666;font-size:11px">${esc(age)}</td></tr>`;
    })
    .join("");

  return c.html(`
    <div style="font-family:monospace;font-size:13px;color:#ccc">
      <div style="margin-bottom:8px;color:#888">${keys.length} key${keys.length !== 1 ? "s" : ""} in store</div>
      ${
        keys.length === 0
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

const routeDocs: Record<string, RouteDocs> = {
  "GET /_panel": {
    summary: "HTML debug view of all stored keys and values",
    response: "text/html",
  },
  "GET /": {
    summary: "List all keys",
    response: "{ keys: [{ key, createdAt, updatedAt }] }",
  },
  "GET /:key": {
    summary: "Get a value by key",
    params: { key: { type: "string", required: true, description: "The key to look up" } },
    response: "{ key, value, createdAt, updatedAt }",
  },
  "PUT /:key": {
    summary: "Set a value",
    params: { key: { type: "string", required: true, description: "The key to set" } },
    body: { value: { type: "any", required: true, description: "The value to store (any JSON)" } },
    response: "{ key, value, updatedAt }",
  },
  "DELETE /:key": {
    summary: "Delete a key",
    params: { key: { type: "string", required: true, description: "The key to delete" } },
    response: "{ deleted: key }",
  },
};

const mod: ServiceModule = {
  name: "store",
  description: "Key-value store — a simple persistence primitive for agents",
  routes: app,
  routeDocs,
  async init() {
    await ensureDataDir();
    await load();
  },
  store: {
    flush() {
      Bun.write(STORE_PATH, JSON.stringify(entries, null, 2));
    },
  },
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
          const data = await client.api<any>("GET", `/store/${params.key}`);
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
        "Store a value in the reef key-value store. Use this to save state, pass data to other agents, or persist results across tasks.",
      parameters: Type.Object({
        key: Type.String({ description: "The key to set" }),
        value: Type.Any({ description: "The value to store (any JSON — string, number, object, array)" }),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          await client.api("PUT", `/store/${params.key}`, { value: params.value });
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
