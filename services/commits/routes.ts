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

  routes.get("/_panel", (c) => {
    const commits = store.list({});
    const rows = commits
      .slice(-20)
      .reverse()
      .map((commit: any) => {
        const time = new Date(commit.timestamp).toLocaleTimeString();
        const tag = commit.tag ? ` <span style="color:#f90">${commit.tag}</span>` : "";
        const label = commit.label || commit.commitId?.slice(0, 8) || "—";
        return `<div style="padding:4px 0;border-bottom:1px solid #222"><span style="color:#666">${time}</span> ${label}${tag}</div>`;
      })
      .join("");
    return c.html(`<div style="font-family:monospace;font-size:13px;color:#ccc;padding:12px">
      <h3 style="margin:0 0 8px;color:#4f9">Commits</h3>
      ${rows || '<div style="color:#666">No commits recorded</div>'}
    </div>`);
  });

  return routes;
}
