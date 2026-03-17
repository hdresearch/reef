/**
 * Registry HTTP routes — VM registration, discovery, heartbeat, lineage.
 */

import { Hono } from "hono";
import type { RegistryStore, VMFilters, VMRole, VMStatus } from "./store.js";
import { ConflictError, NotFoundError, ValidationError } from "./store.js";

export function createRoutes(store: RegistryStore): Hono {
  const routes = new Hono();

  // POST /vms — register a VM
  routes.post("/vms", async (c) => {
    try {
      const body = await c.req.json();
      const vm = store.register(body);
      return c.json(vm, 201);
    } catch (e) {
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      if (e instanceof ConflictError) return c.json({ error: e.message }, 409);
      throw e;
    }
  });

  // GET /vms — list VMs with optional filters
  routes.get("/vms", (c) => {
    const filters: VMFilters = {};
    const role = c.req.query("role");
    const status = c.req.query("status");
    const parentVmId = c.req.query("parentVmId");
    if (role) filters.role = role as VMRole;
    if (status) filters.status = status as VMStatus;
    if (parentVmId) filters.parentVmId = parentVmId;

    const vms = store.list(filters);
    return c.json({ vms, count: vms.length });
  });

  // GET /vms/:id — get a VM by ID
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
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // DELETE /vms/:id — deregister a VM
  routes.delete("/vms/:id", (c) => {
    const deleted = store.deregister(c.req.param("id"));
    if (!deleted) return c.json({ error: "VM not found" }, 404);
    return c.json({ deleted: true });
  });

  // POST /vms/:id/heartbeat — heartbeat
  routes.post("/vms/:id/heartbeat", (c) => {
    try {
      const vm = store.heartbeat(c.req.param("id"));
      return c.json({ id: vm.id, lastSeen: vm.lastSeen });
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  // GET /discover/:role — discover VMs by role
  routes.get("/discover/:role", (c) => {
    const role = c.req.param("role") as VMRole;
    const vms = store.discover(role);
    return c.json({ vms, count: vms.length });
  });

  // =========================================================================
  // Lineage endpoints
  // =========================================================================

  // GET /vms/:id/children — direct children
  routes.get("/vms/:id/children", (c) => {
    const vm = store.get(c.req.param("id"));
    if (!vm) return c.json({ error: "VM not found" }, 404);
    const children = store.children(c.req.param("id"));
    return c.json({ children, count: children.length });
  });

  // GET /vms/:id/ancestors — path to root
  routes.get("/vms/:id/ancestors", (c) => {
    const vm = store.get(c.req.param("id"));
    if (!vm) return c.json({ error: "VM not found" }, 404);
    const ancestors = store.ancestors(c.req.param("id"));
    return c.json({ ancestors, count: ancestors.length });
  });

  // GET /vms/:id/subtree — full subtree (BFS)
  routes.get("/vms/:id/subtree", (c) => {
    const vm = store.get(c.req.param("id"));
    if (!vm) return c.json({ error: "VM not found" }, 404);
    const subtree = store.subtree(c.req.param("id"));
    return c.json({ subtree, count: subtree.length });
  });

  // GET /vms/:idA/diff/:idB — config diff between two VMs
  routes.get("/vms/:idA/diff/:idB", (c) => {
    const diff = store.configDiff(c.req.param("idA"), c.req.param("idB"));
    if (!diff) return c.json({ error: "One or both VMs not found" }, 404);
    return c.json(diff);
  });

  // =========================================================================
  // Dashboard
  // =========================================================================

  routes.get("/_panel", (c) => {
    const vms = store.list({});
    const rows = vms
      .map((vm) => {
        const statusColor = vm.status === "running" ? "#4f9" : vm.status === "paused" ? "#ff9800" : "#888";
        const lastSeen = vm.lastSeen ? new Date(vm.lastSeen).toLocaleTimeString() : "---";
        const parent = vm.parentVmId ? vm.parentVmId.slice(0, 8) : "---";
        const organs = vm.reefConfig.organs.join(", ") || "none";
        return `<tr>
          <td><span style="color:${statusColor}">&#x25CF;</span> ${vm.id.slice(0, 12)}</td>
          <td>${vm.name}</td>
          <td>${vm.role}</td>
          <td style="color:${statusColor}">${vm.status}</td>
          <td>${parent}</td>
          <td style="font-size:0.85em">${organs}</td>
          <td style="color:#888">${lastSeen}</td>
        </tr>`;
      })
      .join("\n");

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Registry Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #1a1a2e; color: #e0e0e0; }
    h1 { color: #64b5f6; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { padding: 0.5rem 0.8rem; text-align: left; border-bottom: 1px solid #333; }
    th { background: #16213e; color: #90caf9; }
    tr:hover { background: #1a1a3e; }
    .count { color: #888; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>VM Registry</h1>
  <p class="count">${vms.length} VM${vms.length !== 1 ? "s" : ""} registered</p>
  <table>
    <thead>
      <tr><th>ID</th><th>Name</th><th>Role</th><th>Status</th><th>Parent</th><th>Organs</th><th>Last Seen</th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="7"><em>No VMs registered</em></td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

    return c.html(html);
  });

  return routes;
}
