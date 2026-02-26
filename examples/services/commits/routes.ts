import { Hono } from "hono";
import type { CommitStore } from "./store.js";
import { ValidationError } from "./store.js";

export function createRoutes(store: CommitStore): Hono {
  const routes = new Hono();

  routes.post("/", async (c) => {
    try {
      const body = await c.req.json();
      const record = store.record(body);
      return c.json(record, 201);
    } catch (e) {
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  routes.get("/", (c) => {
    const commits = store.list({
      tag: c.req.query("tag") || undefined,
      agent: c.req.query("agent") || undefined,
      label: c.req.query("label") || undefined,
      vmId: c.req.query("vmId") || undefined,
      since: c.req.query("since") || undefined,
    });
    return c.json({ commits, count: commits.length });
  });

  routes.get("/:id", (c) => {
    const commit = store.get(c.req.param("id"));
    if (!commit) return c.json({ error: "commit not found" }, 404);
    return c.json(commit);
  });

  routes.delete("/:id", (c) => {
    const deleted = store.delete(c.req.param("id"));
    if (!deleted) return c.json({ error: "commit not found" }, 404);
    return c.json({ deleted: true });
  });

  return routes;
}
