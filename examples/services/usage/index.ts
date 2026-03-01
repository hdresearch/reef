import type { ServiceModule } from "../src/core/types.js";
import { registerBehaviors } from "./behaviors.js";
import { createRoutes } from "./routes.js";
import { UsageStore } from "./store.js";
import { registerTools } from "./tools.js";

const store = new UsageStore();

const usage: ServiceModule = {
  name: "usage",
  description: "Cost & token tracking",
  routes: createRoutes(store),
  store: {
    close: () => {
      store.close();
      return Promise.resolve();
    },
  },
  registerTools,
  registerBehaviors,
  dependencies: ["feed"], // publishes agent_stopped to feed

  routeDocs: {
    "GET /": {
      summary: "Usage summary for a time range",
      query: {
        range: { type: "string", description: "Time range: '1d', '7d', '30d'. Default: '7d'" },
      },
      response: "Aggregated usage stats — total tokens, cost, sessions, VMs",
    },
    "POST /sessions": {
      summary: "Record a session's usage",
      body: {
        agent: { type: "string", required: true, description: "Agent name" },
        model: { type: "string", description: "Model used" },
        inputTokens: { type: "number", required: true, description: "Input tokens consumed" },
        outputTokens: { type: "number", required: true, description: "Output tokens produced" },
        cost: { type: "number", description: "Estimated cost in USD" },
        duration: { type: "number", description: "Session duration in seconds" },
      },
      response: "The recorded session with ID and timestamp",
    },
    "GET /sessions": {
      summary: "List recorded sessions",
      query: {
        agent: { type: "string", description: "Filter by agent" },
        range: { type: "string", description: "Time range: '1d', '7d', '30d'" },
      },
      response: "{ sessions, count }",
    },
    "POST /vms": {
      summary: "Record a VM's usage",
      body: {
        vmId: { type: "string", required: true, description: "VM ID" },
        role: { type: "string", description: "VM role" },
        agent: { type: "string", description: "Agent running on the VM" },
        uptime: { type: "number", description: "Uptime in seconds" },
        cost: { type: "number", description: "Estimated cost in USD" },
      },
      response: "The recorded VM usage with ID and timestamp",
    },
    "GET /_panel": {
      summary: "HTML panel showing 7-day usage summary",
      response: "text/html",
    },
    "GET /vms": {
      summary: "List VM usage records",
      query: {
        role: { type: "string", description: "Filter by VM role" },
        agent: { type: "string", description: "Filter by agent" },
        range: { type: "string", description: "Time range: '1d', '7d', '30d'" },
      },
      response: "{ vms, count }",
    },
  },
};

export default usage;
