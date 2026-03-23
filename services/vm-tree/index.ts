/**
 * VM Tree service — SQLite-backed VM lineage tree.
 *
 * Tracks the hierarchy:
 *   roof reef
 *    └── lieutenants (1:many)
 *         └── swarm workers / agent VMs
 *
 * Features:
 *   - Full lineage queries (ancestors, descendants, subtrees)
 *   - Category-based filtering (lieutenant, swarm_vm, agent_vm, infra_vm)
 *   - Reef config (DNA) per VM: which services (modules) and capabilities (extensions)
 *   - Config diff between VMs
 *   - Dashboard: modules/extensions on each VM, lineage position
 *   - Hourly snapshots via cron (data/snapshots/vms-{timestamp}.sqlite, retain last 24)
 *
 * Database: data/vms.sqlite (included in starter image)
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
  const parentVmId = c.req.query("parentVmId");
  const vms = store.list({ category: category || undefined, parentVmId: parentVmId || undefined });
  return c.json({ vms, count: vms.length });
});

// POST /vms — register a VM in the tree
routes.post("/vms", async (c) => {
  try {
    const body = await c.req.json();
    const vm = store.create(body);
    return c.json(vm, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// GET /vms/:id — get a VM
routes.get("/vms/:id", (c) => {
  const vm = store.get(c.req.param("id"));
  if (!vm) return c.json({ error: "VM not found" }, 404);
  return c.json(vm);
});

// PATCH /vms/:id — update a VM
routes.patch("/vms/:id", async (c) => {
  try {
    const body = await c.req.json();
    const vm = store.update(c.req.param("id"), body);
    return c.json(vm);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// DELETE /vms/:id — remove a VM
routes.delete("/vms/:id", (c) => {
  try {
    const removed = store.remove(c.req.param("id"));
    if (!removed) return c.json({ error: "VM not found" }, 404);
    return c.json({ deleted: true });
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
  const vm = store.get(c.req.param("id"));
  if (!vm) return c.json({ error: "VM not found" }, 404);
  return c.json({ ancestors: store.ancestors(c.req.param("id")) });
});

// GET /vms/:id/descendants — all descendants (BFS)
routes.get("/vms/:id/descendants", (c) => {
  const vm = store.get(c.req.param("id"));
  if (!vm) return c.json({ error: "VM not found" }, 404);
  return c.json({ descendants: store.descendants(c.req.param("id")) });
});

// GET /vms/:id/children — direct children
routes.get("/vms/:id/children", (c) => {
  const vm = store.get(c.req.param("id"));
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

// GET /stats — summary statistics
routes.get("/stats", (c) => {
  return c.json(store.stats());
});

// POST /snapshot — create a snapshot now
routes.post("/snapshot", (c) => {
  const path = store.snapshot();
  const removed = store.pruneSnapshots();
  return c.json({ snapshot: path, prunedOldSnapshots: removed });
});

// GET /_panel — dashboard
routes.get("/_panel", (c) => {
  const stats = store.stats();
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
                : "#ccc";

        let html = `<div style="margin:2px 0">
          ${indent}${prefix}<strong>${v.vm.name}</strong>
          <span style="color:${catColor};font-size:0.85em">[${v.vm.category}]</span>
          <span style="color:#888;font-size:0.8em">${v.vm.vmId.slice(0, 12)}</span>
          <br>${indent}&nbsp;&nbsp;&nbsp;&nbsp;
          <span style="color:#666;font-size:0.8em">services: ${services} | caps: ${caps}</span>
        </div>`;

        if (v.children.length > 0) {
          html += renderTree(v.children, depth + 1);
        }
        return html;
      })
      .join("");
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>VM Tree</title>
  <style>
    body { font-family: monospace; margin: 2rem; background: #1a1a2e; color: #e0e0e0; font-size: 13px; }
    h1 { color: #64b5f6; }
    .stats { color: #888; margin-bottom: 1.5rem; }
    .tree { background: #16213e; padding: 1rem; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>VM Lineage Tree</h1>
  <div class="stats">
    ${stats.total} VM${stats.total !== 1 ? "s" : ""} |
    ${stats.roots} root${stats.roots !== 1 ? "s" : ""} |
    ${
      Object.entries(stats.byCategory)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ") || "empty"
    }
  </div>
  <div class="tree">
    ${tree.length > 0 ? renderTree(tree) : '<em style="color:#666">No VMs in tree</em>'}
  </div>
</body>
</html>`;

  return c.html(html);
});

// =============================================================================
// Module export
// =============================================================================

const vmTree: ServiceModule = {
  name: "vm-tree",
  description: "VM lineage tree — SQLite-backed hierarchy with DNA tracking",
  routes,

  init(ctx: ServiceContext) {
    const currentVmId = process.env.VERS_VM_ID;
    if (currentVmId) {
      store.upsert({
        vmId: currentVmId,
        name: process.env.VERS_AGENT_NAME || "reef",
        category: "infra_vm",
        reefConfig: currentReefConfig(ctx),
      });
    }

    ctx.events.on("lieutenant:created", (data: any) => {
      if (!data?.vmId) return;
      store.upsert({
        vmId: data.vmId,
        name: data.name,
        parentVmId: data.parentVmId || undefined,
        category: "lieutenant",
        reefConfig: {
          services: ["lieutenant"],
          capabilities: ["punkin", "vers-lieutenant", "vers-vm", "vers-vm-copy", "reef-swarm"],
        },
      });
    });

    ctx.events.on("swarm:agent_spawned", (data: any) => {
      if (!data?.vmId) return;
      store.upsert({
        vmId: data.vmId,
        name: data.label,
        parentVmId: process.env.VERS_VM_ID || undefined,
        category: "swarm_vm",
        reefConfig: {
          services: ["swarm"],
          capabilities: ["punkin", "reef-swarm"],
        },
      });
    });

    ctx.events.on("swarm:agent_destroyed", (data: any) => {
      if (!data?.vmId) return;
      store.remove(data.vmId);
    });

    if (!snapshotTimer) {
      snapshotTimer = setInterval(
        () => {
          try {
            store.snapshot();
            store.pruneSnapshots();
          } catch (err) {
            console.error(`  [vm-tree] snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
        60 * 60 * 1000,
      );
    }
  },

  store: {
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
          [Type.Literal("lieutenant"), Type.Literal("swarm_vm"), Type.Literal("agent_vm"), Type.Literal("infra_vm")],
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
        const res = await client.api<any>("GET", "/vm-tree/stats");
        if (res.total === 0) return [];
        return [`VM Tree: ${res.total} VMs, ${res.roots} roots`];
      } catch {
        return [];
      }
    },
  },

  dependencies: [],
  capabilities: ["vm.tree", "vm.lineage", "vm.config"],

  routeDocs: {
    "GET /vms": {
      summary: "List VMs with optional category/parent filter",
      query: {
        category: { type: "string", description: "lieutenant | swarm_vm | agent_vm | infra_vm" },
        parentVmId: { type: "string", description: "Filter by parent" },
      },
      response: "{ vms: [...], count }",
    },
    "POST /vms": {
      summary: "Register a VM in the lineage tree",
      body: {
        name: { type: "string", required: true, description: "VM name" },
        category: { type: "string", required: true, description: "VM category" },
        parentVmId: { type: "string", description: "Parent VM ID" },
        reefConfig: { type: "object", description: "{ services: [...], capabilities: [...] }" },
      },
      response: "The created VM node",
    },
    "GET /vms/:id": {
      summary: "Get a VM by ID",
      params: { id: { type: "string", required: true } },
    },
    "PATCH /vms/:id": {
      summary: "Update a VM",
      params: { id: { type: "string", required: true } },
    },
    "DELETE /vms/:id": {
      summary: "Remove a VM (fails if has children)",
      params: { id: { type: "string", required: true } },
    },
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
    "GET /find/organ/:name": { summary: "Backward-compatible alias for finding VMs with a specific service" },
    "GET /find/capability/:name": { summary: "Find VMs with a specific capability" },
    "GET /stats": { summary: "Summary statistics" },
    "POST /snapshot": { summary: "Create a DB snapshot and prune old ones" },
    "GET /_panel": { summary: "HTML dashboard with tree visualization", response: "text/html" },
  },
};

export default vmTree;
