/**
 * Registry service — VM service discovery with SQLite backing.
 *
 * Upgraded from in-memory (examples/services/registry) to SQLite with:
 *   - Persistent storage across restarts
 *   - VM lineage tracking (parent-child relationships)
 *   - Reef config per VM (services + capabilities = "DNA")
 *   - Config diff between VMs
 */

import type { FleetClient, ServiceContext, ServiceModule } from "../../src/core/types.js";
import { registerBehaviors } from "./behaviors.js";
import { createRoutes } from "./routes.js";
import { RegistryStore } from "./store.js";
import { registerTools } from "./tools.js";

const store = new RegistryStore();

const registry: ServiceModule = {
  name: "registry",
  description: "VM service discovery — SQLite-backed with lineage tracking",
  routes: createRoutes(store),

  init(ctx: ServiceContext) {
    ctx.events.on("lieutenant:created", (data: any) => {
      if (!data?.vmId) return;
      store.register({
        id: data.vmId,
        name: data.name,
        role: "lieutenant",
        address: data.address || `${data.vmId}.vm.vers.sh`,
        parentVmId: data.parentVmId || undefined,
        registeredBy: "lieutenant-service",
        metadata: {
          role: data.role,
          createdAt: data.createdAt,
          commitId: data.commitId,
          registeredVia: data.reconnected ? "lieutenant:reconnected" : "lieutenant:created",
        },
      });
    });

    ctx.events.on("lieutenant:paused", (data: any) => {
      if (!data?.vmId) return;
      try {
        store.update(data.vmId, { status: "paused" });
      } catch {
        // Ignore out-of-order lifecycle events.
      }
    });

    ctx.events.on("lieutenant:resumed", (data: any) => {
      if (!data?.vmId) return;
      try {
        store.update(data.vmId, { status: "running" });
      } catch {
        // Ignore out-of-order lifecycle events.
      }
    });

    ctx.events.on("lieutenant:destroyed", (data: any) => {
      if (!data?.vmId) return;
      store.deregister(data.vmId);
    });

    ctx.events.on("swarm:agent_spawned", (data: any) => {
      if (!data?.vmId) return;
      store.register({
        id: data.vmId,
        name: data.label,
        role: "worker",
        address: `${data.vmId}.vm.vers.sh`,
        parentVmId: process.env.VERS_VM_ID || undefined,
        registeredBy: "swarm-service",
        metadata: {
          role: "worker",
          commitId: data.commitId,
          registeredVia: "swarm:agent_spawned",
        },
      });
    });

    ctx.events.on("swarm:agent_destroyed", (data: any) => {
      if (!data?.vmId) return;
      store.deregister(data.vmId);
    });
  },

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
        reefConfig: { type: "object", description: "VM DNA: { services: [...], capabilities: [...] }" },
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
      response: "{ added: { services, capabilities }, removed: { services, capabilities } }",
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
