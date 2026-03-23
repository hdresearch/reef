/**
 * Lieutenant HTTP routes — management, messaging, status.
 */

import { Hono } from "hono";
import type { LieutenantRuntime } from "./runtime.js";
import type { LieutenantStore, LtStatus } from "./store.js";
import { ConflictError, NotFoundError, ValidationError } from "./store.js";

export function createRoutes(store: LieutenantStore, getRuntime: () => LieutenantRuntime): Hono {
  const routes = new Hono();

  // POST /lieutenants — create a new lieutenant
  routes.post("/lieutenants", async (c) => {
    try {
      const body = await c.req.json();
      const { name, role, model, commitId, llmProxyKey } = body;

      if (!name || typeof name !== "string") return c.json({ error: "name is required" }, 400);
      if (!role || typeof role !== "string") return c.json({ error: "role is required" }, 400);

      const lt = await getRuntime().create({
        name,
        role,
        model,
        commitId,
        llmProxyKey,
      });
      return c.json(lt, 201);
    } catch (e) {
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      if (e instanceof ConflictError) return c.json({ error: e.message }, 409);
      throw e;
    }
  });

  routes.post("/lieutenants/register", async (c) => {
    try {
      const body = await c.req.json();
      const { name, role, vmId, parentAgent } = body;

      if (!name || typeof name !== "string") return c.json({ error: "name is required" }, 400);
      if (!role || typeof role !== "string") return c.json({ error: "role is required" }, 400);
      if (!vmId || typeof vmId !== "string") return c.json({ error: "vmId is required" }, 400);

      const lt = await getRuntime().registerRemote({ name, role, vmId, parentAgent });
      return c.json(lt, 201);
    } catch (e) {
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      if (e instanceof ConflictError) return c.json({ error: e.message }, 409);
      throw e;
    }
  });

  // GET /lieutenants — list all active lieutenants
  routes.get("/lieutenants", async (c) => {
    await getRuntime().refreshAll();
    const status = c.req.query("status") as LtStatus | undefined;
    const lts = store.list(status ? { status } : undefined);
    return c.json({ lieutenants: lts, count: lts.length });
  });

  // GET /lieutenants/:name — get a lieutenant by name
  routes.get("/lieutenants/:name", async (c) => {
    await getRuntime().refresh(c.req.param("name"));
    const lt = store.getByName(c.req.param("name"));
    if (!lt || lt.status === "destroyed") return c.json({ error: "Lieutenant not found" }, 404);
    return c.json(lt);
  });

  // POST /lieutenants/:name/send — send a message to a lieutenant
  routes.post("/lieutenants/:name/send", async (c) => {
    try {
      const body = await c.req.json();
      const { message, mode } = body;
      if (!message || typeof message !== "string") return c.json({ error: "message is required" }, 400);

      const result = await getRuntime().send(c.req.param("name"), message, mode);
      return c.json(result);
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // GET /lieutenants/:name/read — read lieutenant output
  routes.get("/lieutenants/:name/read", async (c) => {
    const name = c.req.param("name");
    const tail = c.req.query("tail") ? parseInt(c.req.query("tail")!, 10) : undefined;
    const history = c.req.query("history") ? parseInt(c.req.query("history")!, 10) : undefined;

    await getRuntime().refresh(name);

    const lt = store.getByName(name);
    if (!lt || lt.status === "destroyed") return c.json({ error: "Lieutenant not found" }, 404);

    let output = lt.lastOutput;
    if (!output && lt.status !== "working") {
      output = lt.outputHistory.at(-1) || "";
    }
    if (!output) {
      output = "(no output yet)";
    }
    if (tail && output.length > tail) {
      output = `...${output.slice(-tail)}`;
    }

    const parts: string[] = [];
    if (history && history > 0) {
      const count = Math.min(history, lt.outputHistory.length);
      const start = lt.outputHistory.length - count;
      for (let i = start; i < lt.outputHistory.length; i++) {
        parts.push(`=== Response ${i + 1} ===\n${lt.outputHistory[i]}\n`);
      }
      parts.push(`=== Current (${lt.status}) ===\n${output}`);
    } else {
      parts.push(output);
    }

    return c.json({
      name,
      status: lt.status,
      taskCount: lt.taskCount,
      outputLength: lt.lastOutput.length,
      historyCount: lt.outputHistory.length,
      output: parts.join("\n"),
    });
  });

  // POST /lieutenants/:name/pause — pause a lieutenant
  routes.post("/lieutenants/:name/pause", async (c) => {
    try {
      const result = await getRuntime().pause(c.req.param("name"));
      return c.json(result);
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // POST /lieutenants/:name/resume — resume a paused lieutenant
  routes.post("/lieutenants/:name/resume", async (c) => {
    try {
      const result = await getRuntime().resume(c.req.param("name"));
      return c.json(result);
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // DELETE /lieutenants/:name — destroy a lieutenant
  routes.delete("/lieutenants/:name", async (c) => {
    try {
      const name = c.req.param("name");
      const result = await getRuntime().destroy(name);
      return c.json(result);
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  // POST /lieutenants/destroy-all — destroy all lieutenants
  routes.post("/lieutenants/destroy-all", async (c) => {
    const results = await getRuntime().destroyAll();
    return c.json({ results });
  });

  // POST /lieutenants/discover — discover lieutenants from registry
  routes.post("/lieutenants/discover", async (c) => {
    const results = await getRuntime().discover();
    return c.json({ results });
  });

  // GET /_panel — HTML dashboard
  routes.get("/_panel", async (c) => {
    await getRuntime().refreshAll();
    const lts = store.list();
    const rows = lts
      .map((lt) => {
        const statusColor =
          lt.status === "idle"
            ? "#4f9"
            : lt.status === "working"
              ? "#ff9800"
              : lt.status === "paused"
                ? "#888"
                : lt.status === "error"
                  ? "#f55"
                  : "#aaa";
        const icon =
          lt.status === "working"
            ? "&#x27F3;"
            : lt.status === "idle"
              ? "&#x25CF;"
              : lt.status === "paused"
                ? "&#x23F8;"
                : lt.status === "error"
                  ? "&#x2717;"
                  : "&#x25CB;";
        const location = `VM: ${lt.vmId.slice(0, 12)}`;
        return `<tr>
        <td><span style="color:${statusColor}">${icon}</span> ${lt.name}</td>
        <td>${lt.role.slice(0, 50)}</td>
        <td style="color:${statusColor}">${lt.status}</td>
        <td>${location}</td>
        <td>${lt.taskCount}</td>
        <td>${lt.lastActivityAt ? new Date(lt.lastActivityAt).toLocaleTimeString() : "---"}</td>
      </tr>`;
      })
      .join("\n");

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Lieutenant Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #1a1a2e; color: #e0e0e0; }
    h1 { color: #64b5f6; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { padding: 0.6rem 1rem; text-align: left; border-bottom: 1px solid #333; }
    th { background: #16213e; color: #90caf9; }
    tr:hover { background: #1a1a3e; }
    .count { color: #888; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>Lieutenants</h1>
  <p class="count">${lts.length} lieutenant${lts.length !== 1 ? "s" : ""} active</p>
  <table>
    <thead>
      <tr><th>Name</th><th>Role</th><th>Status</th><th>Location</th><th>Tasks</th><th>Last Active</th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="6"><em>No lieutenants active</em></td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

    return c.html(html);
  });

  return routes;
}
