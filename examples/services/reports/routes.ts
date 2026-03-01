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

  routes.get("/_panel", (c) => {
    const reports = store.list({});
    const rows = reports
      .slice(-15)
      .reverse()
      .map((r: any) => {
        const time = new Date(r.createdAt).toLocaleTimeString();
        const tags = r.tags?.length ? ` <span style="color:#888">[${r.tags.join(", ")}]</span>` : "";
        return `<div style="padding:4px 0;border-bottom:1px solid #222"><span style="color:#666">${time}</span> <strong>${r.title}</strong>${tags}</div>`;
      })
      .join("");
    return c.html(`<div style="font-family:monospace;font-size:13px;color:#ccc;padding:12px">
      <h3 style="margin:0 0 8px;color:#4f9">Reports — ${reports.length} total</h3>
      ${rows || '<div style="color:#666">No reports yet</div>'}
    </div>`);
  });

  return routes;
}
