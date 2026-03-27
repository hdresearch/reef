/**
 * Swarm service — parallel worker agent orchestration.
 *
 * Spawns N pi coding agents on Vers VMs from a golden commit, dispatches
 * tasks, monitors progress, and collects results. Workers run in RPC mode
 * and are managed through the reef server.
 *
 * Tools (7):
 *   reef_swarm_spawn    — Branch N VMs from golden commit and start pi agents
 *   reef_swarm_task     — Send a task to a specific worker
 *   reef_swarm_status   — Overview of all swarm workers
 *   reef_swarm_read     — Read a worker's latest output
 *   reef_swarm_wait     — Block until workers finish, return results
 *   reef_swarm_discover — Recover workers from registry
 *   reef_swarm_teardown — Destroy all workers and VMs
 *
 * Events: swarm:agent_spawned, swarm:agent_destroyed, swarm:agent_task_sent,
 *         swarm:agent_completed, swarm:agent_error, swarm:agent_reconnected
 */

import { ServiceEventBus } from "../../src/core/events.js";
import type { FleetClient, ServiceContext, ServiceModule } from "../../src/core/types.js";
import type { VMTreeStore } from "../vm-tree/store.js";
import { createRoutes } from "./routes.js";
import { SwarmRuntime } from "./runtime.js";
import { registerTools } from "./tools.js";

let runtime = new SwarmRuntime({ events: new ServiceEventBus() });
const routes = createRoutes(() => runtime);

const swarm: ServiceModule = {
  name: "swarm",
  description: "Parallel worker agent orchestration — spawn, task, wait, teardown",
  routes,

  init(ctx: ServiceContext) {
    const vmTreeHandle = ctx.getStore<{ vmTreeStore: VMTreeStore }>("vm-tree");
    runtime = new SwarmRuntime({
      events: ctx.events,
      vmTreeStore: vmTreeHandle?.vmTreeStore,
    });
    runtime.startOrphanCleanup();
  },

  store: {
    async close() {
      await runtime.shutdown();
    },
  },

  registerTools(pi, client: FleetClient) {
    registerTools(pi, client);
  },

  widget: {
    async getLines(client: FleetClient) {
      try {
        const res = await client.api<{ agents: any[]; count: number }>("GET", "/swarm/agents");
        if (res.count === 0) return [];
        const working = res.agents.filter((a) => a.status === "working").length;
        const idle = res.agents.filter((a) => a.status === "idle").length;
        const done = res.agents.filter((a) => a.status === "done").length;
        const parts = [`${res.count} workers`];
        if (working) parts.push(`${working} working`);
        if (idle) parts.push(`${idle} idle`);
        if (done) parts.push(`${done} done`);
        return [`Swarm: ${parts.join(", ")}`];
      } catch {
        return [];
      }
    },
  },

  dependencies: ["lieutenant", "vm-tree"],
  capabilities: ["swarm.spawn", "swarm.communicate", "swarm.lifecycle"],

  routeDocs: {
    "POST /agents": {
      summary: "Spawn N worker agents from a golden commit",
      body: {
        commitId: { type: "string", description: "Golden image commit ID (optional)" },
        count: { type: "number", required: true, description: "Number of agents to spawn" },
        labels: { type: "string[]", description: "Labels for each agent" },
        llmProxyKey: { type: "string", description: "Vers LLM proxy key override" },
        model: { type: "string", description: "Model ID (default: claude-sonnet-4-6)" },
      },
      response: "{ agents, messages, count }",
    },
    "GET /agents": {
      summary: "List all swarm workers",
      response: "{ agents, count, summary }",
    },
    "GET /agents/:id": {
      summary: "Get a single agent",
      params: { id: { type: "string", required: true, description: "Agent label/ID" } },
      response: "Agent object",
    },
    "POST /agents/:id/task": {
      summary: "Send a task to a worker",
      params: { id: { type: "string", required: true, description: "Agent label/ID" } },
      body: { task: { type: "string", required: true, description: "Task prompt to send" } },
      response: "{ sent, agentId, task }",
    },
    "GET /agents/:id/read": {
      summary: "Read worker output",
      params: { id: { type: "string", required: true, description: "Agent label/ID" } },
      query: { tail: { type: "number", description: "Characters from end" } },
      response: "{ id, status, output, warning?, outputLength }",
    },
    "POST /wait": {
      summary: "Wait for workers to finish",
      body: {
        agentIds: { type: "string[]", description: "Specific IDs to wait for (default: all)" },
        timeoutSeconds: { type: "number", description: "Max wait time (default: 300)" },
      },
      response: "{ elapsed, timedOut, agents }",
    },
    "POST /discover": {
      summary: "Discover workers from registry",
      response: "{ results, summary }",
    },
    "DELETE /agents/:id": {
      summary: "Destroy a single worker",
      params: { id: { type: "string", required: true, description: "Agent label/ID" } },
    },
    "POST /teardown": {
      summary: "Destroy all swarm workers",
      response: "{ results }",
    },
    "GET /_panel": {
      summary: "HTML dashboard showing active workers",
      response: "text/html",
    },
  },
};

export default swarm;
