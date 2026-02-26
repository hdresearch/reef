import { Hono } from "hono";
import type { ReportsStore } from "./store.js";
import { ValidationError } from "./store.js";

export function createRoutes(store: ReportsStore): Hono {
  const routes = new Hono();

  routes.post("/", async (c) => {
    try {
      const body = await c.req.json();
      const report = store.create(body);
      return c.json(report, 201);
    } catch (e) {
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  routes.get("/", (c) => {
    const reports = store.list({
      author: c.req.query("author") || undefined,
      tag: c.req.query("tag") || undefined,
    });
    // Listing: omit content for lighter payload
    const summaries = reports.map(({ content, ...rest }) => rest);
    return c.json({ reports: summaries, count: summaries.length });
  });

  routes.get("/:id", (c) => {
    const report = store.get(c.req.param("id"));
    if (!report) return c.json({ error: "report not found" }, 404);
    return c.json(report);
  });

  routes.delete("/:id", (c) => {
    const deleted = store.delete(c.req.param("id"));
    if (!deleted) return c.json({ error: "report not found" }, 404);
    return c.json({ deleted: true });
  });

  return routes;
}
