import { Hono } from "hono";
import type { UsageStore } from "./store.js";
import { ValidationError } from "./store.js";

export function createRoutes(store: UsageStore): Hono {
  const routes = new Hono();

  routes.get("/", (c) => {
    const range = c.req.query("range") || "7d";
    return c.json(store.summary(range));
  });

  routes.post("/sessions", async (c) => {
    try {
      const body = await c.req.json();
      const record = store.recordSession(body);
      return c.json(record, 201);
    } catch (e) {
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  routes.get("/sessions", (c) => {
    const sessions = store.listSessions({
      agent: c.req.query("agent") || undefined,
      range: c.req.query("range") || undefined,
    });
    return c.json({ sessions, count: sessions.length });
  });

  routes.post("/vms", async (c) => {
    try {
      const body = await c.req.json();
      const record = store.recordVM(body);
      return c.json(record, 201);
    } catch (e) {
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  routes.get("/vms", (c) => {
    const vms = store.listVMs({
      role: c.req.query("role") || undefined,
      agent: c.req.query("agent") || undefined,
      range: c.req.query("range") || undefined,
    });
    return c.json({ vms, count: vms.length });
  });

  routes.get("/_panel", (c) => {
    const summary = store.summary("7d");
    return c.html(`<div style="font-family:monospace;font-size:13px;color:#ccc;padding:12px">
      <h3 style="margin:0 0 8px;color:#4f9">Usage (7d)</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>Sessions: <strong>${summary.totalSessions ?? 0}</strong></div>
        <div>VMs: <strong>${summary.totalVMs ?? 0}</strong></div>
        <div>Input tokens: <strong>${(summary.totalInputTokens ?? 0).toLocaleString()}</strong></div>
        <div>Output tokens: <strong>${(summary.totalOutputTokens ?? 0).toLocaleString()}</strong></div>
        <div>Cost: <strong>$${(summary.totalCost ?? 0).toFixed(2)}</strong></div>
      </div>
    </div>`);
  });

  return routes;
}
