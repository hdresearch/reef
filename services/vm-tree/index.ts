/**
 * VM Tree service — unified fleet state backed by SQLite.
 *
 * v2: single database (data/fleet.sqlite) owns all fleet state:
 *   - vm_tree: every VM in the fleet
 *   - signals: bidirectional signal/command delivery
 *   - agent_events: lifecycle audit trail
 *   - logs: operational trace
 *   - store: key-value persistence
 *   - store_history: versioned write history
 *
 * Other services (registry, store, signals, logs) access the shared
 * database through this service's store handle via ctx.getStore("vm-tree").
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Hono } from "hono";
import type { FleetClient, ServiceContext, ServiceModule } from "../../src/core/types.js";
import type { VMCategory } from "./store.js";
import { VMTreeStore } from "./store.js";

const store = new VMTreeStore();
let snapshotTimer: ReturnType<typeof setInterval> | null = null;

function currentReefConfig(ctx: ServiceContext) {
  const modules = ctx.getModules();
  return {
    services: modules.map((mod) => mod.name).sort(),
    capabilities: Array.from(new Set(modules.flatMap((mod) => mod.capabilities || []))).sort(),
  };
}

// =============================================================================
// Routes
// =============================================================================

const routes = new Hono();

// GET /vms — list all VMs
routes.get("/vms", (c) => {
  const category = c.req.query("category") as VMCategory | undefined;
  const parentId = c.req.query("parentId") || c.req.query("parentVmId");
  const status = c.req.query("status") as any;
  const vms = store.listVMs({
    category: category || undefined,
    parentId: parentId || undefined,
    status: status || undefined,
  });
  return c.json({ vms, count: vms.length });
});

// POST /vms — register a VM in the tree
routes.post("/vms", async (c) => {
  try {
    const body = await c.req.json();
    // Handle legacy field names
    if (body.parentVmId && !body.parentId) body.parentId = body.parentVmId;
    if (body.vmId && !body.id) body.id = body.vmId;
    const vm = store.upsertVM({ ...body, vmId: body.id || body.vmId });
    return c.json(vm, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// GET /vms/:id — get a VM
routes.get("/vms/:id", (c) => {
  const vm = store.getVM(c.req.param("id"));
  if (!vm) return c.json({ error: "VM not found" }, 404);
  return c.json(vm);
});

// PATCH /vms/:id — update a VM
routes.patch("/vms/:id", async (c) => {
  try {
    const body = await c.req.json();
    if (body.parentVmId !== undefined && body.parentId === undefined) body.parentId = body.parentVmId;
    const vm = store.updateVM(c.req.param("id"), body);
    return c.json(vm);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// DELETE /vms/:id — mark a VM as destroyed
routes.delete("/vms/:id", (c) => {
  try {
    const vm = store.getVM(c.req.param("id"));
    if (!vm) return c.json({ error: "VM not found" }, 404);
    store.updateVM(c.req.param("id"), { status: "destroyed" });
    return c.json({ deleted: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// POST /vms/:id/heartbeat — update heartbeat
routes.post("/vms/:id/heartbeat", (c) => {
  try {
    const vm = store.getVM(c.req.param("id"));
    if (!vm) return c.json({ error: "VM not found" }, 404);
    store.updateVM(c.req.param("id"), { lastHeartbeat: Date.now(), status: "running" });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// GET /tree — full tree view (all roots or from a specific VM)
routes.get("/tree", (c) => {
  const rootId = c.req.query("root");
  const tree = store.tree(rootId || undefined);
  return c.json({ tree, count: store.count() });
});

// GET /vms/:id/ancestors — path to root
routes.get("/vms/:id/ancestors", (c) => {
  const vm = store.getVM(c.req.param("id"));
  if (!vm) return c.json({ error: "VM not found" }, 404);
  return c.json({ ancestors: store.ancestors(c.req.param("id")) });
});

// GET /vms/:id/descendants — all descendants (BFS)
routes.get("/vms/:id/descendants", (c) => {
  const vm = store.getVM(c.req.param("id"));
  if (!vm) return c.json({ error: "VM not found" }, 404);
  return c.json({ descendants: store.descendants(c.req.param("id")) });
});

// GET /vms/:id/children — direct children
routes.get("/vms/:id/children", (c) => {
  const vm = store.getVM(c.req.param("id"));
  if (!vm) return c.json({ error: "VM not found" }, 404);
  return c.json({ children: store.children(c.req.param("id")) });
});

// GET /vms/:a/diff/:b — config diff
routes.get("/vms/:a/diff/:b", (c) => {
  const diff = store.configDiff(c.req.param("a"), c.req.param("b"));
  if (!diff) return c.json({ error: "One or both VMs not found" }, 404);
  return c.json(diff);
});

// GET /find/service/:name — find VMs with a specific service
routes.get("/find/service/:name", (c) => {
  const vms = store.findByService(c.req.param("name"));
  return c.json({ vms, count: vms.length });
});

// Backward-compatible alias
routes.get("/find/organ/:name", (c) => {
  const vms = store.findByService(c.req.param("name"));
  return c.json({ vms, count: vms.length });
});

// GET /find/capability/:name — find VMs with a specific capability
routes.get("/find/capability/:name", (c) => {
  const vms = store.findByCapability(c.req.param("name"));
  return c.json({ vms, count: vms.length });
});

// GET /fleet/status — live fleet metrics
routes.get("/fleet/status", (c) => {
  return c.json(store.fleetStatus());
});

// POST /snapshot — create a snapshot now
routes.post("/snapshot", (c) => {
  const path = store.snapshot();
  return c.json({ snapshot: path });
});

// GET /_panel — dashboard
routes.get("/_panel", (c) => {
  const status = store.fleetStatus();
  const tree = store.tree();

  function renderTree(views: { vm: any; children: any[] }[], depth = 0): string {
    return views
      .map((v) => {
        const indent = "&nbsp;".repeat(depth * 4);
        const prefix = depth > 0 ? "&#x2514;&#x2500; " : "";
        const services = v.vm.reefConfig.services.join(", ") || "none";
        const caps = v.vm.reefConfig.capabilities.join(", ") || "none";
        const catColor =
          v.vm.category === "lieutenant"
            ? "#ff9800"
            : v.vm.category === "infra_vm"
              ? "#4f9"
              : v.vm.category === "swarm_vm"
                ? "#64b5f6"
                : v.vm.category === "agent_vm"
                  ? "#ce93d8"
                  : v.vm.category === "resource_vm"
                    ? "#888"
                    : "#ccc";
        const statusColor = v.vm.status === "running" ? "#4f9" : v.vm.status === "error" ? "#f44" : "#888";

        let html = `<div style="margin:2px 0">
					${indent}${prefix}<strong>${esc(v.vm.name)}</strong>
					<span style="color:${catColor};font-size:0.85em">[${v.vm.category}]</span>
					<span style="color:${statusColor};font-size:0.85em">${v.vm.status}</span>
					<span style="color:#888;font-size:0.8em">${v.vm.vmId.slice(0, 12)}</span>
					<br>${indent}&nbsp;&nbsp;&nbsp;&nbsp;
					<span style="color:#666;font-size:0.8em">services: ${esc(services)} | caps: ${esc(caps)}</span>
				</div>`;

        if (v.children.length > 0) {
          html += renderTree(v.children, depth + 1);
        }
        return html;
      })
      .join("");
  }

  function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  return c.html(`
		<div style="font-family:monospace;font-size:13px;color:#ccc">
			<div style="margin-bottom:8px;color:#888">
				Fleet: ${status.alive} alive |
				${
          Object.entries(status.byCategory)
            .map(([k, v]) => `${v} ${k}`)
            .join(", ") || "empty"
        } |
				${status.totalSpawned} total spawned
			</div>
			<div style="background:#16213e;padding:12px;border-radius:6px">
				${tree.length > 0 ? renderTree(tree) : '<em style="color:#666">No VMs in tree</em>'}
			</div>
		</div>
	`);
});

// =============================================================================
// Module export
// =============================================================================

const vmTree: ServiceModule = {
  name: "vm-tree",
  description: "VM lineage tree — unified fleet state with signals, logs, and store",
  routes,

  init(ctx: ServiceContext) {
    const currentVmId = process.env.VERS_VM_ID;
    if (currentVmId) {
      store.upsertVM({
        vmId: currentVmId,
        name: process.env.VERS_AGENT_NAME || "reef",
        category: "infra_vm",
        reefConfig: currentReefConfig(ctx),
      });
    }

    ctx.events.on("lieutenant:created", (data: any) => {
      if (!data?.vmId) return;
      store.upsertVM({
        vmId: data.vmId,
        name: data.name,
        parentId: data.parentVmId || undefined,
        category: "lieutenant",
        reefConfig: {
          services: ["lieutenant"],
          capabilities: ["punkin", "vers-lieutenant", "vers-vm", "vers-vm-copy", "reef-swarm"],
        },
      });
    });

    ctx.events.on("swarm:agent_spawned", (data: any) => {
      if (!data?.vmId) return;
      store.upsertVM({
        vmId: data.vmId,
        name: data.label,
        parentId: process.env.VERS_VM_ID || undefined,
        category: "swarm_vm",
        reefConfig: {
          services: ["swarm"],
          capabilities: ["punkin", "reef-swarm"],
        },
      });
    });

    ctx.events.on("swarm:agent_destroyed", (data: any) => {
      if (!data?.vmId) return;
      try {
        store.updateVM(data.vmId, { status: "destroyed" });
      } catch {
        /* best effort */
      }
    });

    if (!snapshotTimer) {
      snapshotTimer = setInterval(
        () => {
          try {
            store.snapshot();
          } catch (err) {
            console.error(`  [vm-tree] snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
        60 * 60 * 1000,
      );
    }
  },

  // Expose the full VMTreeStore so other services can access it via ctx.getStore("vm-tree")
  store: {
    // Proxy flush/close for the ServiceModule interface
    flush() {
      store.flush();
    },
    async close() {
      if (snapshotTimer) {
        clearInterval(snapshotTimer);
        snapshotTimer = null;
      }
      store.close();
    },
    // Expose the VMTreeStore instance for other services
    get vmTreeStore() {
      return store;
    },
  },

  registerTools(pi: ExtensionAPI, client: FleetClient) {
    pi.registerTool({
      name: "vm_tree_view",
      label: "VM Tree: View",
      description:
        "View the VM lineage tree. Shows which services and extensions are on each VM and where it sits in the hierarchy.",
      parameters: Type.Object({
        vmId: Type.Optional(Type.String({ description: "Root VM ID to view subtree from (default: all roots)" })),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const qs = params.vmId ? `?root=${encodeURIComponent(params.vmId)}` : "";
          const result = await client.api<any>("GET", `/vm-tree/tree${qs}`);
          return client.ok(JSON.stringify(result, null, 2), { tree: result });
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });

    pi.registerTool({
      name: "vm_tree_register",
      label: "VM Tree: Register",
      description: "Register a VM in the lineage tree with its category and DNA (services + capabilities).",
      parameters: Type.Object({
        name: Type.String({ description: "VM name" }),
        category: Type.Union(
          [
            Type.Literal("lieutenant"),
            Type.Literal("swarm_vm"),
            Type.Literal("agent_vm"),
            Type.Literal("infra_vm"),
            Type.Literal("resource_vm"),
          ],
          { description: "VM category" },
        ),
        parentVmId: Type.Optional(Type.String({ description: "Parent VM ID in the lineage tree" })),
        vmId: Type.Optional(Type.String({ description: "VM ID (auto-generated if not provided)" })),
        reefConfig: Type.Optional(
          Type.Object(
            {
              services: Type.Array(Type.String(), { description: "Services loaded on this VM" }),
              capabilities: Type.Array(Type.String(), { description: "Extension capabilities" }),
            },
            { description: "VM DNA" },
          ),
        ),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const result = await client.api<any>("POST", "/vm-tree/vms", params);
          return client.ok(`Registered "${result.name}" (${result.category}) in tree. ID: ${result.vmId}`, {
            vm: result,
          });
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });

    pi.registerTool({
      name: "vm_tree_find",
      label: "VM Tree: Find",
      description: "Find VMs by service or capability. Useful for answering 'which VMs have X loaded?'",
      parameters: Type.Object({
        type: Type.Union([Type.Literal("service"), Type.Literal("capability"), Type.Literal("organ")], {
          description: "Search type",
        }),
        name: Type.String({ description: "Service or capability name to search for" }),
      }),
      async execute(_id, params) {
        if (!client.getBaseUrl()) return client.noUrl();
        try {
          const type = params.type === "organ" ? "service" : params.type;
          const result = await client.api<any>("GET", `/vm-tree/find/${type}/${encodeURIComponent(params.name)}`);
          if (result.count === 0) {
            return client.ok(`No VMs found with ${type} "${params.name}".`);
          }
          return client.ok(
            `${result.count} VM(s) with ${type} "${params.name}":\n${JSON.stringify(result.vms, null, 2)}`,
            { result },
          );
        } catch (e: any) {
          return client.err(e.message);
        }
      },
    });
  },

  widget: {
    async getLines(client: FleetClient) {
      try {
        const res = await client.api<any>("GET", "/vm-tree/fleet/status");
        if (res.alive === 0) return [];
        return [
          `VM Tree: ${res.alive} VMs, ${Object.entries(res.byCategory)
            .map(([k, v]) => `${v} ${k}`)
            .join(", ")}`,
        ];
      } catch {
        return [];
      }
    },
  },

  dependencies: [],
  capabilities: ["vm.tree", "vm.lineage", "vm.config"],

  routeDocs: {
    "GET /vms": {
      summary: "List VMs with optional category/parent/status filter",
      query: {
        category: { type: "string", description: "infra_vm | lieutenant | agent_vm | swarm_vm | resource_vm" },
        parentId: { type: "string", description: "Filter by parent" },
        status: { type: "string", description: "creating | running | paused | stopped | error | destroyed | rewound" },
      },
      response: "{ vms: [...], count }",
    },
    "POST /vms": {
      summary: "Register a VM in the lineage tree",
      body: {
        name: { type: "string", required: true, description: "VM name (must be unique among active VMs)" },
        category: { type: "string", required: true, description: "VM category" },
        parentId: { type: "string", description: "Parent VM ID" },
        reefConfig: { type: "object", description: "{ services: [...], capabilities: [...] }" },
      },
      response: "The created VM node",
    },
    "GET /vms/:id": { summary: "Get a VM by ID", params: { id: { type: "string", required: true } } },
    "PATCH /vms/:id": { summary: "Update a VM", params: { id: { type: "string", required: true } } },
    "DELETE /vms/:id": { summary: "Mark a VM as destroyed", params: { id: { type: "string", required: true } } },
    "POST /vms/:id/heartbeat": { summary: "Update VM heartbeat", params: { id: { type: "string", required: true } } },
    "GET /tree": {
      summary: "Full tree view — all roots or subtree from ?root=vmId",
      query: { root: { type: "string", description: "Root VM ID" } },
      response: "{ tree: [...], count }",
    },
    "GET /vms/:id/ancestors": { summary: "Ancestor chain to root" },
    "GET /vms/:id/descendants": { summary: "All descendants (BFS)" },
    "GET /vms/:id/children": { summary: "Direct children" },
    "GET /vms/:a/diff/:b": { summary: "Config diff between two VMs" },
    "GET /find/service/:name": { summary: "Find VMs with a specific service" },
    "GET /find/capability/:name": { summary: "Find VMs with a specific capability" },
    "GET /fleet/status": {
      summary: "Live fleet metrics (alive VMs by category, total spawned)",
      response: "{ alive, byCategory, byStatus, totalSpawned }",
    },
    "POST /snapshot": { summary: "Create a DB snapshot" },
    "GET /_panel": { summary: "HTML dashboard with tree visualization", response: "text/html" },
  },
};

export default vmTree;
