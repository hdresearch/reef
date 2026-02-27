/**
 * Services manager module — runtime management of service modules.
 *
 * This is the service that manages all other services. It's loaded by the
 * same discovery scan as everything else, but uses the enriched ServiceContext
 * to add, update, and remove modules at runtime.
 *
 *   GET    /services               — list loaded modules
 *   POST   /services/reload        — re-scan directory, load new & update changed
 *   POST   /services/reload/:name  — reload a specific module
 *   DELETE /services/:name         — unload a module
 */

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { ServiceModule, ServiceContext } from "../src/core/types.js";

let ctx: ServiceContext;

const routes = new Hono();

// List all loaded modules
routes.get("/", (c) => {
  const modules = ctx.getModules().map((m) => ({
    name: m.name,
    description: m.description,
    hasRoutes: !!m.routes,
    hasTools: !!m.registerTools,
    hasBehaviors: !!m.registerBehaviors,
    hasWidget: !!m.widget,
    mountAtRoot: !!m.mountAtRoot,
    dependencies: m.dependencies ?? [],
  }));
  return c.json({ modules, count: modules.length });
});

// Machine-readable manifest — everything agents need to discover reef's capabilities
routes.get("/manifest", (c) => {
  const modules = ctx.getModules();

  const services = modules.map((m) => {
    const entry: Record<string, unknown> = {
      name: m.name,
      description: m.description ?? null,
      dependencies: m.dependencies ?? [],
    };

    // Routes
    if (m.routeDocs && Object.keys(m.routeDocs).length > 0) {
      entry.routes = Object.fromEntries(
        Object.entries(m.routeDocs).map(([key, doc]) => [
          key,
          {
            description: doc.summary ?? doc.detail ?? null,
            params: doc.params ?? undefined,
            query: doc.query ?? undefined,
            body: doc.body ?? undefined,
            response: doc.response ?? undefined,
          },
        ]),
      );
    }

    // Capabilities
    const capabilities: string[] = [];
    if (m.routes) capabilities.push("routes");
    if (m.registerTools) capabilities.push("tools");
    if (m.registerBehaviors) capabilities.push("behaviors");
    if (m.widget) capabilities.push("widget");
    if (m.routeDocs) {
      const hasPanel = Object.keys(m.routeDocs).some((k) => k.includes("/_panel"));
      if (hasPanel) capabilities.push("panel");
    }
    entry.capabilities = capabilities;

    return entry;
  });

  // Flatten all documented routes across services
  const allRoutes: Array<{ service: string; method: string; path: string; description: string | null }> = [];
  for (const m of modules) {
    if (!m.routeDocs) continue;
    for (const [key, doc] of Object.entries(m.routeDocs)) {
      const [method, ...pathParts] = key.split(" ");
      const path = `/${m.name}${pathParts.join(" ")}`;
      allRoutes.push({
        service: m.name,
        method,
        path,
        description: doc.summary ?? doc.detail ?? null,
      });
    }
  }

  // Collect all event names from behaviors (convention: "service:event_name")
  // We can't introspect these automatically, but we document the known pattern
  const events = modules
    .filter((m) => m.registerBehaviors)
    .map((m) => m.name);

  return c.json({
    services,
    routes: allRoutes,
    servicesWithTools: modules.filter((m) => m.registerTools).map((m) => m.name),
    servicesWithBehaviors: events,
    servicesWithPanels: modules
      .filter((m) => m.routeDocs && Object.keys(m.routeDocs).some((k) => k.includes("/_panel")))
      .map((m) => m.name),
    count: services.length,
  });
});

// Reload all — re-scan directory, add new, update changed, remove deleted
routes.post("/reload", async (c) => {
  const servicesDir = ctx.servicesDir;

  if (!existsSync(servicesDir)) {
    return c.json({ error: `Services directory not found: ${servicesDir}` }, 400);
  }

  const entries = readdirSync(servicesDir, { withFileTypes: true });
  const results: Array<{ name: string; action: string }> = [];
  const errors: Array<{ dir: string; error: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!existsSync(join(servicesDir, entry.name, "index.ts"))) continue;

    try {
      const result = await ctx.loadModule(entry.name);
      results.push(result);
      console.log(`  [reload] /${result.name} — ${result.action}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ dir: entry.name, error: msg });
      console.error(`  [reload] services/${entry.name}: ${msg}`);
    }
  }

  // Remove modules whose directories no longer exist
  const currentDirs = new Set(
    entries.filter((e) => e.isDirectory()).map((e) => e.name),
  );
  for (const mod of ctx.getModules()) {
    // Don't remove modules that still have a directory
    if (currentDirs.has(mod.name)) continue;
    // Don't let the services manager remove itself
    if (mod.name === "services") continue;

    await ctx.unloadModule(mod.name);
    results.push({ name: mod.name, action: "removed" });
    console.log(`  [reload] /${mod.name} — removed`);
  }

  return c.json({ results, errors });
});

// Reload a specific module by name
routes.post("/reload/:name", async (c) => {
  const name = c.req.param("name");

  // Check if it exists as a directory
  const dirPath = join(ctx.servicesDir, name);
  if (!existsSync(join(dirPath, "index.ts"))) {
    return c.json({ error: `No service directory "${name}" with index.ts found` }, 404);
  }

  try {
    const result = await ctx.loadModule(name);
    console.log(`  [reload] /${result.name} — ${result.action}`);
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

// Export a module as a tarball
routes.get("/export/:name", async (c) => {
  const name = c.req.param("name");
  const mod = ctx.getModule(name);

  if (!mod) {
    return c.json({ error: `Module "${name}" not found` }, 404);
  }

  const dirPath = join(ctx.servicesDir, name);
  if (!existsSync(dirPath)) {
    return c.json({ error: `Service directory "${name}" not found on disk` }, 404);
  }

  try {
    const { execSync } = await import("node:child_process");
    const tarball = execSync(`tar -czf - -C "${ctx.servicesDir}" "${name}"`, {
      maxBuffer: 50 * 1024 * 1024, // 50MB
    });

    return new Response(tarball, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${name}.tar.gz"`,
        "X-Service-Name": mod.name,
        "X-Service-Description": mod.description || "",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to export: ${msg}` }, 500);
  }
});

// Unload a module
routes.delete("/:name", async (c) => {
  const name = c.req.param("name");

  if (name === "services") {
    return c.json({ error: "Cannot unload the services manager" }, 400);
  }

  const mod = ctx.getModule(name);
  if (!mod) {
    return c.json({ error: `Module "${name}" not found` }, 404);
  }

  await ctx.unloadModule(name);
  console.log(`  [unload] /${name} — removed`);
  return c.json({ name, action: "removed" });
});

const services: ServiceModule = {
  name: "services",
  description: "Service module manager",
  routes,

  routeDocs: {
    "GET /": {
      summary: "List all loaded modules with capabilities",
      response: "{ modules: [{ name, description, hasRoutes, hasTools, ... }], count }",
    },
    "GET /manifest": {
      summary: "Machine-readable manifest of all services, routes, tools, and capabilities. Designed for agents to discover what reef can do.",
      response: "{ services, routes, servicesWithTools, servicesWithBehaviors, servicesWithPanels, count }",
    },
    "POST /reload": {
      summary: "Re-scan services directory — load new, update changed, remove deleted",
      response: "{ results: [{ name, action }], errors }",
    },
    "POST /reload/:name": {
      summary: "Reload a specific module by directory name",
      params: { name: { type: "string", required: true, description: "Service directory name" } },
      response: "{ name, action }",
    },
    "GET /export/:name": {
      summary: "Download a service as a tarball (for fleet-to-fleet install)",
      params: { name: { type: "string", required: true, description: "Service name" } },
      response: "application/gzip tarball",
    },
    "DELETE /:name": {
      summary: "Unload a module from memory (does not delete files)",
      params: { name: { type: "string", required: true, description: "Service name to unload" } },
      response: "{ name, action: 'removed' }",
    },
  },

  init(serviceCtx: ServiceContext) {
    ctx = serviceCtx;
  },
};

export default services;
