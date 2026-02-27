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

import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { ServiceModule, ServiceContext } from "../src/core/types.js";

/** Seed metadata stored alongside the installer registry */
interface SeedMeta {
  name: string;
  versionLabel: string;
  method: "germination" | "graft";
  requiredCapabilities: string[];
  optionalCapabilities: string[];
  conformance: string;
  registeredAt: string;
  sourceUrl?: string;
  testResults?: {
    core: { passed: number; failed: number; skipped: number };
    extended?: { passed: number; failed: number; skipped: number };
    edgeCase?: { passed: number; failed: number; skipped: number };
  };
  lastVerified?: string;
}

let ctx: ServiceContext;

/** Compute the full set of substrate capabilities from base + environment + services */
function getSubstrateCapabilities(): Set<string> {
  const caps = new Set([
    "hosting.web",
    "state.persist",
    "event.trigger",
  ]);

  // Environment-detected
  if (process.env.VERS_API_URL || process.env.VERS_VM_ID) {
    caps.add("state.snapshot");
    caps.add("state.snapshot.fast");
    caps.add("state.branch");
    caps.add("state.branch.fast");
  }
  if (process.env.VERS_PUBLIC_URL) {
    caps.add("hosting.web.public");
    caps.add("hosting.dns");
  }

  // Service-contributed
  for (const m of ctx.getModules()) {
    if (m.capabilities) {
      for (const cap of m.capabilities) {
        caps.add(cap);
      }
    }
  }

  return caps;
}

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

  const capabilities = getSubstrateCapabilities();

  // =========================================================================
  // Per-service entries
  // =========================================================================

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

    // Module-level features (what this service offers reef)
    const features: string[] = [];
    if (m.routes) features.push("routes");
    if (m.registerTools) features.push("tools");
    if (m.registerBehaviors) features.push("behaviors");
    if (m.widget) features.push("widget");
    if (m.routeDocs) {
      const hasPanel = Object.keys(m.routeDocs).some((k) => k.includes("/_panel"));
      if (hasPanel) features.push("panel");
    }
    entry.features = features;

    // Seed capabilities this service provides
    if (m.capabilities?.length) {
      entry.provides = m.capabilities;
    }

    return entry;
  });

  // =========================================================================
  // Flat route index
  // =========================================================================

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

  return c.json({
    // Substrate: what this reef instance can do (seed capability taxonomy)
    substrate: {
      capabilities: [...capabilities].sort(),
    },
    // Services: what's loaded and what each one offers
    services,
    routes: allRoutes,
    servicesWithTools: modules.filter((m) => m.registerTools).map((m) => m.name),
    servicesWithBehaviors: modules.filter((m) => m.registerBehaviors).map((m) => m.name),
    servicesWithPanels: modules
      .filter((m) => m.routeDocs && Object.keys(m.routeDocs).some((k) => k.includes("/_panel")))
      .map((m) => m.name),
    count: services.length,
  });
});

// Capability pre-flight check — can a seed germinate here?
routes.post("/check", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.capabilities?.length) {
    return c.json({ error: "capabilities array required" }, 400);
  }

  const required: string[] = body.capabilities;
  const substrate = getSubstrateCapabilities();
  const met = required.filter((cap) => substrate.has(cap));
  const missing = required.filter((cap) => !substrate.has(cap));

  return c.json({
    canGerminate: missing.length === 0,
    met,
    missing,
    substrate: [...substrate].sort(),
  });
});

// Conformance manifest — which seeds have been germinated and their status
routes.get("/conformance", (c) => {
  const substrate = getSubstrateCapabilities();

  // Read seed provenance from the installer registry
  const registryPath = join(ctx.servicesDir, ".installer.json");
  let installed: Array<{ dirName: string; seed?: string; installedAt: string }> = [];
  try {
    if (existsSync(registryPath)) {
      installed = JSON.parse(readFileSync(registryPath, "utf-8")).installed ?? [];
    }
  } catch {}

  // Group by seed content hash
  const seedMap = new Map<string, { services: string[]; installedAt: string }>();
  for (const entry of installed) {
    if (!entry.seed) continue;
    const existing = seedMap.get(entry.seed);
    if (existing) {
      existing.services.push(entry.dirName);
    } else {
      seedMap.set(entry.seed, {
        services: [entry.dirName],
        installedAt: entry.installedAt,
      });
    }
  }

  // Read seed metadata from .seeds-meta.json (registered via POST /services/seeds/register)
  const metaPath = join(ctx.servicesDir, ".seeds-meta.json");
  let seedMeta: Record<string, SeedMeta> = {};
  try {
    if (existsSync(metaPath)) {
      seedMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
    }
  } catch {}

  const seeds = [...seedMap.entries()].map(([hash, { services, installedAt }]) => {
    const meta = seedMeta[hash];
    return {
      name: meta?.name ?? "unknown",
      content_hash: hash,
      version_label: meta?.versionLabel ?? "unknown",
      conformanceLevel: meta?.conformance ?? "UNTESTED",
      services,
      installedAt,
      capabilities: {
        implemented: (meta?.requiredCapabilities ?? []).filter((cap: string) => substrate.has(cap)),
        missing: (meta?.requiredCapabilities ?? []).filter((cap: string) => !substrate.has(cap)),
      },
      testResults: meta?.testResults ?? null,
      lastVerified: meta?.lastVerified ?? null,
    };
  });

  return c.json({
    v: "seed-spec/0.5",
    type: "conformance.manifest",
    timestamp: new Date().toISOString(),
    seeds,
    count: seeds.length,
  });
});

// Register seed metadata (name, capabilities, etc.) for conformance tracking
routes.post("/seeds/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const { contentHash, name, versionLabel, requiredCapabilities, optionalCapabilities, method, sourceUrl } = body;
  if (!contentHash || !name) {
    return c.json({ error: "contentHash and name are required" }, 400);
  }
  if (!contentHash.startsWith("sha256:")) {
    return c.json({ error: "contentHash must start with 'sha256:'" }, 400);
  }

  const metaPath = join(ctx.servicesDir, ".seeds-meta.json");
  let seedMeta: Record<string, SeedMeta> = {};
  try {
    if (existsSync(metaPath)) {
      seedMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
    }
  } catch {}

  if (seedMeta[contentHash]) {
    return c.json({ error: `Seed ${contentHash} is already registered` }, 409);
  }

  seedMeta[contentHash] = {
    name,
    versionLabel: versionLabel ?? "unknown",
    method: method === "graft" ? "graft" : "germination",
    requiredCapabilities: requiredCapabilities ?? [],
    optionalCapabilities: optionalCapabilities ?? [],
    conformance: "UNTESTED",
    registeredAt: new Date().toISOString(),
    sourceUrl,
  };

  writeFileSync(metaPath, JSON.stringify(seedMeta, null, 2));
  return c.json({ action: "registered", seed: seedMeta[contentHash] }, 201);
});

// Update seed metadata (conformance, test results)
routes.patch("/seeds/:hash", async (c) => {
  const hash = decodeURIComponent(c.req.param("hash"));

  const metaPath = join(ctx.servicesDir, ".seeds-meta.json");
  let seedMeta: Record<string, SeedMeta> = {};
  try {
    if (existsSync(metaPath)) {
      seedMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
    }
  } catch {}

  const meta = seedMeta[hash];
  if (!meta) {
    return c.json({ error: `No seed metadata for "${hash}"` }, 404);
  }

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  if (body.conformance) meta.conformance = body.conformance;
  if (body.testResults) meta.testResults = body.testResults;
  if (body.lastVerified) meta.lastVerified = body.lastVerified;

  writeFileSync(metaPath, JSON.stringify(seedMeta, null, 2));
  return c.json({ action: "updated", seed: meta });
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
      summary: "Machine-readable manifest of all services, routes, tools, and substrate capabilities. Designed for agents to discover what reef can do and whether a seed can germinate here.",
      response: "{ substrate: { capabilities }, services: [{ name, description, features, provides?, routes? }], routes, servicesWithTools, servicesWithBehaviors, servicesWithPanels, count }",
    },
    "POST /check": {
      summary: "Check if a seed's required capabilities can be met by this substrate",
      body: {
        capabilities: { type: "string[]", required: true, description: "Required capability identifiers to check" },
      },
      response: "{ canGerminate, met, missing, substrate }",
    },
    "GET /conformance": {
      summary: "Conformance manifest — which seeds have been germinated and their status (seed spec §9.3)",
      response: "{ v, type, timestamp, seeds: [{ name, content_hash, conformanceLevel, capabilities, testResults }], count }",
    },
    "POST /seeds/register": {
      summary: "Register seed metadata for conformance tracking",
      body: {
        contentHash: { type: "string", required: true, description: "SHA-256 content hash (sha256:...)" },
        name: { type: "string", required: true, description: "Seed name from TOML frontmatter" },
        versionLabel: { type: "string", description: "Human-readable version label" },
        method: { type: "string", description: "'germination' or 'graft'" },
        requiredCapabilities: { type: "string[]", description: "Capabilities the seed requires" },
        optionalCapabilities: { type: "string[]", description: "Capabilities the seed optionally uses" },
        sourceUrl: { type: "string", description: "URL where the seed was fetched from" },
      },
      response: "{ action: 'registered', seed }",
    },
    "PATCH /seeds/:hash": {
      summary: "Update seed conformance level and test results",
      params: { hash: { type: "string", required: true, description: "SHA-256 content hash" } },
      body: {
        conformance: { type: "string", description: "FULL | SUBSTANTIAL | PARTIAL | MINIMAL | NON_CONFORMING | UNTESTED" },
        testResults: { type: "object", description: "{ core: { passed, failed, skipped }, extended?, edgeCase? }" },
        lastVerified: { type: "string", description: "ISO timestamp" },
      },
      response: "{ action: 'updated', seed }",
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

  // Reef-specific substrate capabilities
  capabilities: [
    "reef.reload",              // hot-reload services without restart
    "reef.unload",              // remove services at runtime
    "reef.export",              // tarball services for fleet-to-fleet distribution
    "reef.manifest",            // machine-readable capability discovery
    "reef.seeds.conformance",   // serves conformance manifests
    "reef.seeds.check",         // capability pre-flight checks
  ],

  init(serviceCtx: ServiceContext) {
    ctx = serviceCtx;
  },
};

export default services;
