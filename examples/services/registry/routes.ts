/**
 * Registry HTTP routes — VM registration, discovery, heartbeat.
 */

import { Hono } from "hono";
import type { RegistryStore, VMFilters, VMRole, VMStatus } from "./store.js";
import { ConflictError, NotFoundError, ValidationError } from "./store.js";

export function createRoutes(store: RegistryStore): Hono {
  const routes = new Hono();

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

  routes.get("/vms", (c) => {
    const filters: VMFilters = {};
    const role = c.req.query("role");
    const status = c.req.query("status");
    if (role) filters.role = role as VMRole;
    if (status) filters.status = status as VMStatus;

    const vms = store.list(filters);
    return c.json({ vms, count: vms.length });
  });

  routes.get("/vms/:id", (c) => {
    const vm = store.get(c.req.param("id"));
    if (!vm) return c.json({ error: "VM not found" }, 404);
    return c.json(vm);
  });

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

  routes.delete("/vms/:id", (c) => {
    const deleted = store.deregister(c.req.param("id"));
    if (!deleted) return c.json({ error: "VM not found" }, 404);
    return c.json({ deleted: true });
  });

  routes.post("/vms/:id/heartbeat", (c) => {
    try {
      const vm = store.heartbeat(c.req.param("id"));
      return c.json({ id: vm.id, lastSeen: vm.lastSeen });
    } catch (e) {
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  routes.get("/discover/:role", (c) => {
    const role = c.req.param("role") as VMRole;
    const vms = store.discover(role);
    return c.json({ vms, count: vms.length });
  });

  return routes;
}
