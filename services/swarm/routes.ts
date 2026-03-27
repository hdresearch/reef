/**
 * Swarm HTTP routes — spawn, task, status, read, wait, discover, teardown.
 */

import { Hono } from "hono";
import type { SwarmRuntime } from "./runtime.js";
import { NotFoundError } from "./runtime.js";

export function createRoutes(getRuntime: () => SwarmRuntime): Hono {
  const routes = new Hono();

  // POST /agents — spawn N worker agents
  routes.post("/agents", async (c) => {
    try {
      const body = await c.req.json();
      const { commitId, count, labels, llmProxyKey, model, context, category, directive, effort } = body;

      if (!count || typeof count !== "number" || count < 1) {
        return c.json({ error: "count is required and must be >= 1" }, 400);
      }

      const result = await getRuntime().spawn({
        commitId,
        count,
        labels,
        llmProxyKey,
        model,
        context,
        category,
        directive,
        effort,
      });
      return c.json(
        {
          agents: result.agents.map((a) => ({ id: a.id, vmId: a.vmId, status: a.status })),
          messages: result.messages,
          count: result.agents.length,
        },
        201,
      );
    } catch (e) {
      if (e instanceof Error && e.message.includes("LLM_PROXY_KEY")) {
        return c.json({ error: e.message }, 400);
      }
      throw e;
    }
  });

  // GET /agents — list all agents
  routes.get("/agents", (c) => {
    const agents = getRuntime()
      .getAgents()
      .map((a) => ({
        id: a.id,
        vmId: a.vmId,
        status: a.status,
        task: a.task,
        outputLength: a.lastOutput.length,
        eventCount: a.events.length,
        lastActivityAt: a.lastActivityAt,
        createdAt: a.createdAt,
        lifecycle: a.lifecycle.slice(-5),
      }));
    return c.json({ agents, count: agents.length, summary: getRuntime().summary() });
  });

  // GET /agents/:id — get single agent
  routes.get("/agents/:id", (c) => {
    const agent = getRuntime().getAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json({
      id: agent.id,
      vmId: agent.vmId,
      status: agent.status,
      task: agent.task,
      outputLength: agent.lastOutput.length,
      eventCount: agent.events.length,
      lastActivityAt: agent.lastActivityAt,
      createdAt: agent.createdAt,
      lifecycle: agent.lifecycle,
    });
  });

  // POST /agents/:id/task — send task to agent
  routes.post("/agents/:id/task", async (c) => {
    try {
      const body = await c.req.json();
      const { task } = body;
      if (!task || typeof task !== "string") return c.json({ error: "task is required" }, 400);

      getRuntime().sendTask(c.req.param("id"), task);
      return c.json({ sent: true, agentId: c.req.param("id"), task });
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  // GET /agents/:id/read — read agent output
  routes.get("/agents/:id/read", (c) => {
    try {
      const tail = c.req.query("tail") ? parseInt(c.req.query("tail")!, 10) : undefined;
      const { agent, output, warning } = getRuntime().readOutput(c.req.param("id"), tail);
      return c.json({
        id: agent.id,
        status: agent.status,
        output,
        warning,
        outputLength: agent.lastOutput.length,
        lastActivityAt: agent.lastActivityAt,
        lifecycle: agent.lifecycle.slice(-10),
      });
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  // POST /wait — wait for agents to finish
  routes.post("/wait", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { agentIds, timeoutSeconds } = body as { agentIds?: string[]; timeoutSeconds?: number };

    const result = await getRuntime().wait(agentIds, timeoutSeconds);
    return c.json(result);
  });

  // POST /discover — discover agents from registry
  routes.post("/discover", async (c) => {
    const results = await getRuntime().discover();
    return c.json({
      results,
      summary: getRuntime().summary(),
    });
  });

  // DELETE /agents/:id — destroy a single agent
  routes.delete("/agents/:id", async (c) => {
    try {
      const result = await getRuntime().destroy(c.req.param("id"));
      return c.json({ result });
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  // POST /teardown — destroy all agents
  routes.post("/teardown", async (c) => {
    const results = await getRuntime().destroyAll();
    return c.json({ results });
  });

  // GET /_panel — HTML dashboard
  routes.get("/_panel", (c) => {
    const agents = getRuntime().getAgents();
    const rows = agents
      .map((a) => {
        const statusColor =
          a.status === "idle"
            ? "#4f9"
            : a.status === "working"
              ? "#ff9800"
              : a.status === "done"
                ? "#888"
                : a.status === "error"
                  ? "#f55"
                  : "#aaa";
        const icon =
          a.status === "working"
            ? "&#x27F3;"
            : a.status === "idle"
              ? "&#x25CF;"
              : a.status === "done"
                ? "&#x2713;"
                : a.status === "error"
                  ? "&#x2717;"
                  : "&#x25CB;";
        return `<tr>
        <td><span style="color:${statusColor}">${icon}</span> ${a.label}</td>
        <td style="color:${statusColor}">${a.status}</td>
        <td>${a.vmId.slice(0, 12)}</td>
        <td>${a.task ? a.task.slice(0, 60) : "---"}</td>
        <td>${a.lastActivityAt ? new Date(a.lastActivityAt).toLocaleTimeString() : "---"}</td>
      </tr>`;
      })
      .join("\n");

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Swarm Dashboard</title>
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
  <h1>Swarm Workers</h1>
  <p class="count">${agents.length} worker${agents.length !== 1 ? "s" : ""} active</p>
  <table>
    <thead>
      <tr><th>Label</th><th>Status</th><th>VM</th><th>Task</th><th>Last Active</th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="5"><em>No swarm workers active</em></td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

    return c.html(html);
  });

  return routes;
}
