/**
 * Registry service module — VM service discovery for agent fleets.
 */

import type { FleetClient, ServiceModule } from "../../src/core/types.js";
import { registerBehaviors } from "./behaviors.js";
import { createRoutes } from "./routes.js";
import { RegistryStore } from "./store.js";
import { registerTools } from "./tools.js";

const store = new RegistryStore();

const registry: ServiceModule = {
  name: "registry",
  description: "VM service discovery",
  routes: createRoutes(store),
  store,
  registerTools,
  registerBehaviors,

  routeDocs: {
    "POST /vms": {
      summary: "Register a VM",
      body: {
        id: { type: "string", required: true, description: "VM ID" },
        role: { type: "string", required: true, description: "Role: orchestrator | worker | builder | golden" },
        address: { type: "string", description: "Hostname or IP" },
        port: { type: "number", description: "Service port" },
        agent: { type: "string", description: "Agent name running on this VM" },
        labels: { type: "Record<string, string>", description: "Arbitrary key-value labels" },
      },
      response: "The registered VM with status and timestamps",
    },
    "GET /vms": {
      summary: "List VMs with optional filters",
      query: {
        role: { type: "string", description: "Filter by role" },
        status: { type: "string", description: "Filter by status: running | stopped | error" },
      },
      response: "{ vms, count }",
    },
    "GET /vms/:id": {
      summary: "Get a VM by ID",
      params: { id: { type: "string", required: true, description: "VM ID" } },
    },
    "PATCH /vms/:id": {
      summary: "Update a VM's fields",
      params: { id: { type: "string", required: true, description: "VM ID" } },
      body: {
        status: { type: "string", description: "New status" },
        role: { type: "string", description: "New role" },
        labels: { type: "Record<string, string>", description: "Updated labels" },
      },
    },
    "DELETE /vms/:id": {
      summary: "Deregister a VM",
      params: { id: { type: "string", required: true, description: "VM ID" } },
    },
    "POST /vms/:id/heartbeat": {
      summary: "Send a heartbeat for a VM",
      params: { id: { type: "string", required: true, description: "VM ID" } },
      response: "{ id, lastSeen }",
    },
    "GET /_panel": {
      summary: "HTML panel showing registered VMs",
      response: "text/html",
    },
    "GET /discover/:role": {
      summary: "Discover VMs by role (only running VMs with recent heartbeats)",
      params: { role: { type: "string", required: true, description: "Role to discover" } },
      response: "{ vms, count }",
    },
  },

  widget: {
    async getLines(client: FleetClient) {
      try {
        const res = await client.api<{ vms: { status: string }[]; count: number }>("GET", "/registry/vms");
        const running = res.vms.filter((v) => v.status === "running").length;
        return [`Registry: ${res.count} VMs (${running} running)`];
      } catch {
        return [];
      }
    },
  },
};

export default registry;
