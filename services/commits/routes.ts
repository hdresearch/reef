import { Hono } from "hono";
import { type EnsureGoldenResult, ensureGoldenCommit } from "./golden.js";
import type { CommitStore } from "./store.js";
import { ValidationError } from "./store.js";

export function createRoutes(
  store: CommitStore,
  ensureGolden: (options?: { force?: boolean; label?: string }) => Promise<EnsureGoldenResult> = (options) =>
    ensureGoldenCommit(store, options),
): Hono {
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

  routes.get("/current/golden", (c) => {
    const envCommitId = process.env.VERS_GOLDEN_COMMIT_ID || process.env.VERS_COMMIT_ID;
    if (envCommitId?.trim()) {
      return c.json({ commitId: envCommitId.trim(), source: "env" });
    }

    const commit = store.latestByTag("golden");
    if (!commit) return c.json({ error: "golden commit not found" }, 404);
    return c.json({ commitId: commit.commitId, source: "store", record: commit });
  });

  routes.post("/ensure-golden", async (c) => {
    try {
      const body = c.req.header("content-type")?.includes("application/json") ? await c.req.json() : {};
      const result = await ensureGolden({
        force: body?.force === true,
        label: typeof body?.label === "string" ? body.label : undefined,
      });
      return c.json(result, result.created ? 201 : 200);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
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

  routes.get("/_panel", (c) => {
    const commits = store.list({});
    const currentGolden = store.latestByTag("golden");
    const rows = commits
      .slice(0, 20)
      .map((commit) => {
        const time = new Date(commit.createdAt).toLocaleTimeString();
        const tag = commit.tags.length > 0 ? ` <span style="color:#f90">${commit.tags.join(",")}</span>` : "";
        const label = commit.label || commit.commitId.slice(0, 8);
        return `<div style="padding:4px 0;border-bottom:1px solid #222"><span style="color:#666">${time}</span> ${label}${tag}</div>`;
      })
      .join("");

    return c.html(`<div style="font-family:monospace;font-size:13px;color:#ccc;padding:12px">
      <h3 style="margin:0 0 8px;color:#4f9">Commits</h3>
      <div style="margin-bottom:8px;color:#888">Current golden: ${currentGolden?.commitId || process.env.VERS_GOLDEN_COMMIT_ID || process.env.VERS_COMMIT_ID || "none"}</div>
      ${rows || '<div style="color:#666">No commits recorded</div>'}
    </div>`);
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
