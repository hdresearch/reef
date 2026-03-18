/**
 * Registry service — VM service discovery with SQLite backing.
 *
 * Upgraded from in-memory (examples/services/registry) to SQLite with:
 *   - Persistent storage across restarts
 *   - VM lineage tracking (parent-child relationships)
 *   - Reef config per VM (organs + capabilities = "DNA")
 *   - Config diff between VMs
 */

import type { FleetClient, ServiceModule } from "../../src/core/types.js";
import { registerBehaviors } from "./behaviors.js";
import { createRoutes } from "./routes.js";
import { RegistryStore } from "./store.js";
import { registerTools } from "./tools.js";

const store = new RegistryStore();

const registry: ServiceModule = {
  name: "registry",
  description: "VM service discovery — SQLite-backed with lineage tracking",
  routes: createRoutes(store),

  store: {
    flush() {
      store.flush();
    },
    async close() {
      store.close();
    },
  },

  registerTools,
  registerBehaviors,

  capabilities: ["fleet.discovery", "fleet.registry", "fleet.lineage"],

  routeDocs: {
    "POST /vms": {
      summary: "Register a VM (upserts if ID exists)",
      body: {
        id: { type: "string", required: true, description: "VM ID" },
        name: { type: "string", required: true, description: "Human-readable name" },
        role: { type: "string", required: true, description: "Role: infra | lieutenant | worker | golden | custom" },
        address: { type: "string", required: true, description: "Network address" },
        parentVmId: { type: "string", description: "Parent VM ID for lineage" },
        reefConfig: { type: "object", description: "VM DNA: { organs: [...], capabilities: [...] }" },
        registeredBy: { type: "string", required: true, description: "Agent or system that registered" },
      },
      response: "The registered VM object",
    },
    "GET /vms": {
      summary: "List VMs with optional filters",
      query: {
        role: { type: "string", description: "Filter by role" },
        status: { type: "string", description: "Filter by status: running | paused | stopped" },
        parentVmId: { type: "string", description: "Filter by parent VM" },
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
        reefConfig: { type: "object", description: "Updated reef config (DNA)" },
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
    "GET /discover/:role": {
      summary: "Discover running VMs by role (excludes stale)",
      params: { role: { type: "string", required: true, description: "Role to discover" } },
      response: "{ vms, count }",
    },
    "GET /vms/:id/children": {
      summary: "Get direct child VMs",
      params: { id: { type: "string", required: true, description: "VM ID" } },
    },
    "GET /vms/:id/ancestors": {
      summary: "Get ancestor chain to root",
      params: { id: { type: "string", required: true, description: "VM ID" } },
    },
    "GET /vms/:id/subtree": {
      summary: "Get full subtree (BFS)",
      params: { id: { type: "string", required: true, description: "VM ID" } },
    },
    "GET /vms/:idA/diff/:idB": {
      summary: "Compare reef configs between two VMs",
      params: {
        idA: { type: "string", required: true, description: "First VM ID" },
        idB: { type: "string", required: true, description: "Second VM ID" },
      },
      response: "{ added: { organs, capabilities }, removed: { organs, capabilities } }",
    },
    "GET /_panel": {
      summary: "HTML dashboard showing registered VMs with lineage",
      response: "text/html",
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
