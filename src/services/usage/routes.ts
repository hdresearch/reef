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

  return routes;
}
