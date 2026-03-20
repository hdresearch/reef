/**
 * Lieutenant service — persistent, conversational agent sessions.
 *
 * Unlike ephemeral tasks (one pi process per prompt), lieutenants are
 * long-lived agent sessions that persist across tasks, accumulate context,
 * and support multi-turn interaction. They can run locally or on Vers VMs.
 *
 * Tools (8):
 *   reef_lt_create   — Spawn a lieutenant (local or remote)
 *   reef_lt_send     — Send a message (prompt, steer, followUp)
 *   reef_lt_read     — Read current/historical output
 *   reef_lt_status   — Overview of all lieutenants
 *   reef_lt_pause    — Pause a VM lieutenant (preserves state)
 *   reef_lt_resume   — Resume a paused lieutenant
 *   reef_lt_destroy  — Tear down a lieutenant (or all)
 *   reef_lt_discover — Recover lieutenants from registry
 *
 * State: data/lieutenants.sqlite (via LieutenantStore)
 * Events: lieutenant:created, lieutenant:completed, lieutenant:paused,
 *         lieutenant:resumed, lieutenant:destroyed
 */

import { ServiceEventBus } from "../../src/core/events.js";
import type { FleetClient, ServiceContext, ServiceModule } from "../../src/core/types.js";
import { createRoutes } from "./routes.js";
import { LieutenantRuntime } from "./runtime.js";
import { LieutenantStore } from "./store.js";
import { registerTools } from "./tools.js";

const store = new LieutenantStore();

// Create runtime with a placeholder event bus — will be replaced in init()
let runtime = new LieutenantRuntime({ events: new ServiceEventBus(), store });
const routes = createRoutes(store, () => runtime);

const lieutenant: ServiceModule = {
  name: "lieutenant",
  description: "Persistent agent sessions — long-lived lieutenants with multi-turn context",
  routes,

  init(ctx: ServiceContext) {
    runtime = new LieutenantRuntime({
      events: ctx.events,
      store,
    });
    runtime.rehydrate().catch((err) => {
      console.error(`  [lieutenant] rehydrate failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  },

  store: {
    flush() {
      store.flush();
    },
    async close() {
      await runtime.shutdown();
      store.close();
    },
  },

  registerTools(pi, client: FleetClient) {
    registerTools(pi, client);
  },

  widget: {
    async getLines(client: FleetClient) {
      try {
        const res = await client.api<{ lieutenants: any[]; count: number }>("GET", "/lieutenant/lieutenants");
        if (res.count === 0) return [];
        const working = res.lieutenants.filter((l) => l.status === "working").length;
        const idle = res.lieutenants.filter((l) => l.status === "idle").length;
        const paused = res.lieutenants.filter((l) => l.status === "paused").length;
        const parts = [`${res.count} LT`];
        if (working) parts.push(`${working} working`);
        if (idle) parts.push(`${idle} idle`);
        if (paused) parts.push(`${paused} paused`);
        return [`Lieutenants: ${parts.join(", ")}`];
      } catch {
        return [];
      }
    },
  },

  dependencies: ["store"],
  capabilities: ["agent.spawn", "agent.communicate", "agent.lifecycle"],

  routeDocs: {
    "POST /lieutenants": {
      summary: "Create a new lieutenant",
      body: {
        name: { type: "string", required: true, description: "Lieutenant name" },
        role: { type: "string", required: true, description: "Role description (becomes system prompt context)" },
        local: { type: "boolean", description: "Run locally as subprocess (default: false)" },
        model: { type: "string", description: "Model ID" },
        commitId: {
          type: "string",
          description: "Golden image commit ID (optional if a default golden is configured)",
        },
        anthropicApiKey: { type: "string", description: "Anthropic API key override (defaults to server env)" },
      },
      response: "The created lieutenant object",
    },
    "GET /lieutenants": {
      summary: "List all active lieutenants",
      query: { status: { type: "string", description: "Filter by status" } },
      response: "{ lieutenants: [...], count }",
    },
    "POST /lieutenants/register": {
      summary: "Register an already-bootstrapped remote agent VM as a lieutenant",
      body: {
        name: { type: "string", required: true, description: "Lieutenant name" },
        role: { type: "string", required: true, description: "Role label for the lieutenant" },
        vmId: { type: "string", required: true, description: "Vers VM ID for the remote agent VM" },
        parentAgent: { type: "string", description: "Optional parent/root agent name" },
      },
      response: "The registered lieutenant object",
    },
    "GET /lieutenants/:name": {
      summary: "Get a lieutenant by name",
      params: { name: { type: "string", required: true, description: "Lieutenant name" } },
      response: "Lieutenant object",
    },
    "POST /lieutenants/:name/send": {
      summary: "Send a message to a lieutenant",
      params: { name: { type: "string", required: true, description: "Lieutenant name" } },
      body: {
        message: { type: "string", required: true, description: "Message to send" },
        mode: { type: "string", description: "prompt | steer | followUp" },
      },
      response: "{ sent, mode, note? }",
    },
    "GET /lieutenants/:name/read": {
      summary: "Read lieutenant output",
      params: { name: { type: "string", required: true, description: "Lieutenant name" } },
      query: {
        tail: { type: "number", description: "Characters from end" },
        history: { type: "number", description: "Previous responses to include" },
      },
      response: "{ name, status, taskCount, output, ... }",
    },
    "POST /lieutenants/:name/pause": {
      summary: "Pause a VM lieutenant (preserves state)",
      params: { name: { type: "string", required: true, description: "Lieutenant name" } },
    },
    "POST /lieutenants/:name/resume": {
      summary: "Resume a paused lieutenant",
      params: { name: { type: "string", required: true, description: "Lieutenant name" } },
    },
    "DELETE /lieutenants/:name": {
      summary: "Destroy a lieutenant",
      params: { name: { type: "string", required: true, description: "Lieutenant name" } },
    },
    "POST /lieutenants/destroy-all": {
      summary: "Destroy all lieutenants",
    },
    "POST /lieutenants/discover": {
      summary: "Discover lieutenants from the registry",
      response: "{ results: [...] }",
    },
    "GET /_panel": {
      summary: "HTML dashboard showing active lieutenants",
      response: "text/html",
    },
  },
};

export default lieutenant;
