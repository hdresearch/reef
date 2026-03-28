import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer } from "../src/core/server.js";
import logs from "../services/logs/index.js";
import vmTree from "../services/vm-tree/index.js";
import { VMTreeStore } from "../services/vm-tree/store.js";

const AUTH_TOKEN = "logs-search-token";

function authHeaders(extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    ...extra,
  };
}

async function json(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json() : await res.text();
  return { status: res.status, data };
}

beforeEach(() => {
  process.env.VERS_AUTH_TOKEN = AUTH_TOKEN;
  process.env.VERS_VM_ID = `vm-root-${Date.now()}`;
  process.env.VERS_AGENT_NAME = "root-reef";
});

afterEach(() => {
  delete process.env.VERS_AUTH_TOKEN;
  delete process.env.VERS_VM_ID;
  delete process.env.VERS_AGENT_NAME;
});

describe("logs search and panel", () => {
  test("queries logs by keyword and date range with totalCount", async () => {
    const server = await createServer({ modules: [vmTree, logs] });
    const store = server.ctx.getStore<{ vmTreeStore: VMTreeStore }>("vm-tree")?.vmTreeStore;
    expect(store).toBeDefined();

    const suffix = `${Date.now()}-logs-search`;
    const rootVmId = `root-${suffix}`;
    const agentVmId = `agent-${suffix}`;
    const agentName = `agent-${suffix}`;

    store!.upsertVM({ vmId: rootVmId, name: `root-${suffix}`, category: "infra_vm", status: "running" });
    store!.upsertVM({
      vmId: agentVmId,
      name: agentName,
      category: "agent_vm",
      status: "running",
      parentId: rootVmId,
    });

    const older = store!.insertLog({
      agentId: agentVmId,
      agentName,
      level: "info",
      category: "decision",
      message: "phase one completed successfully",
      metadata: { step: 1 },
    });
    const newer = store!.insertLog({
      agentId: agentVmId,
      agentName,
      level: "error",
      category: "tool_result",
      message: "timeout while fetching provider status",
      metadata: { provider: "vers", code: 500 },
    });
    const newest = store!.insertLog({
      agentId: agentVmId,
      agentName,
      level: "warn",
      category: "state_change",
      message: "provider timeout recovered after retry",
      metadata: { retries: 2 },
    });

    const db = store!.getDb();
    db.run("UPDATE logs SET created_at = ? WHERE id = ?", [older.createdAt - 120_000, older.id]);
    db.run("UPDATE logs SET created_at = ? WHERE id = ?", [newer.createdAt - 20_000, newer.id]);
    db.run("UPDATE logs SET created_at = ? WHERE id = ?", [newest.createdAt, newest.id]);
    db.exec("INSERT INTO logs_fts(logs_fts) VALUES ('rebuild')");

    const res = await json(
      server.app,
      `/logs/?agent=${encodeURIComponent(agentName)}&q=${encodeURIComponent("provider timeout")}&since=${newer.createdAt - 30_000}&until=${Date.now() + 1000}`,
      { headers: authHeaders() },
    );

    expect(res.status).toBe(200);
    expect(res.data.totalCount).toBe(2);
    expect(res.data.count).toBe(2);
    expect(res.data.logs.map((entry: any) => entry.id).sort()).toEqual([newer.id, newest.id].sort());
  });

  test("logs panel exposes keyword/date-range search UI", async () => {
    const server = await createServer({ modules: [vmTree, logs] });
    const res = await server.app.fetch(
      new Request("http://localhost/logs/_panel", {
        headers: authHeaders(),
      }),
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("fleet logs");
    expect(html).toContain("logs-panel-filters");
    expect(html).toContain('type="search"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain("Keyword + date range search runs server-side.");
    expect(html).toContain("const apiBase = window.PANEL_API || '/ui/api';");
  });
});
