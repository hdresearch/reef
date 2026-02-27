/**
 * Seeds service — provenance tracking for germinated seeds.
 *
 * Tracks which seeds have been germinated or grafted, which services
 * they produced, and their conformance status. Serves the conformance
 * manifest for cross-fleet discovery.
 *
 *   GET    /seeds/inventory             — list all germinated seeds
 *   GET    /seeds/:hash                 — get a specific seed by content hash
 *   POST   /seeds/register              — record a germinated/grafted seed (auth required)
 *   PATCH  /seeds/:hash                 — update conformance, test results (auth required)
 *   DELETE /seeds/:hash                 — remove a seed record (auth required)
 *   GET    /seeds/conformance           — public conformance manifest (no auth)
 *   GET    /seeds/check                 — check if a seed's requirements are met (no auth)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { Hono } from "hono";
import type { ServiceModule, ServiceContext } from "../src/core/types.js";

// =============================================================================
// Types
// =============================================================================

interface SeedRecord {
  /** Seed name from TOML frontmatter */
  name: string;
  /** SHA-256 content hash — the seed's true identity */
  contentHash: string;
  /** Human-readable version label */
  versionLabel: string;
  /** How this seed arrived */
  method: "germination" | "graft";
  /** ISO timestamp */
  installed: string;
  /** Service module names this seed produced */
  services: string[];
  /** Conformance level (self-assessed) */
  conformance: "FULL" | "SUBSTANTIAL" | "PARTIAL" | "MINIMAL" | "NON_CONFORMING" | "UNTESTED";
  /** Capabilities declared as required by the seed */
  requiredCapabilities: string[];
  /** Capabilities declared as optional by the seed */
  optionalCapabilities: string[];
  /** Test vector results, if verified */
  testResults?: {
    core: { passed: number; failed: number; skipped: number };
    extended?: { passed: number; failed: number; skipped: number };
    edgeCase?: { passed: number; failed: number; skipped: number };
  };
  /** ISO timestamp of last verification run */
  lastVerified?: string;
  /** Adaptations made during grafting */
  adaptations?: string[];
  /** Source URL where the seed was fetched from */
  sourceUrl?: string;
}

interface SeedRegistry {
  seeds: SeedRecord[];
}

// =============================================================================
// Store
// =============================================================================

let registryPath: string;
let registry: SeedRegistry = { seeds: [] };

function loadRegistry(): void {
  if (existsSync(registryPath)) {
    try {
      registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    } catch {
      registry = { seeds: [] };
    }
  } else {
    registry = { seeds: [] };
  }
}

function saveRegistry(): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

function findSeed(hash: string): SeedRecord | undefined {
  // Accept full hash or prefix
  return registry.seeds.find(
    (s) => s.contentHash === hash || s.contentHash.startsWith(`sha256:${hash}`),
  );
}

// =============================================================================
// Auth helper (manual check since service is public for conformance)
// =============================================================================

function checkAuth(c: any): Response | null {
  const token = process.env.VERS_AUTH_TOKEN;
  if (!token) return null; // no auth configured, allow

  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return c.json({ error: "Unauthorized — missing Authorization header" }, 401);
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== token) {
    return c.json({ error: "Unauthorized — invalid token" }, 401);
  }

  return null; // auth passed
}

// =============================================================================
// Routes
// =============================================================================

let ctx: ServiceContext;
const routes = new Hono();

// -- Public endpoints ---------------------------------------------------------

// Conformance manifest (seed spec §9.3)
routes.get("/conformance", (c) => {
  const manifest = {
    v: "seed-spec/0.5",
    type: "conformance.manifest",
    timestamp: new Date().toISOString(),
    seeds: registry.seeds.map((s) => ({
      name: s.name,
      content_hash: s.contentHash,
      version_label: s.versionLabel,
      conformanceLevel: s.conformance,
      capabilities: {
        implemented: s.requiredCapabilities.filter((cap) => {
          // Check against current substrate capabilities
          const modules = ctx.getModules();
          const substrateCaps = new Set(["hosting.web", "state.persist", "event.trigger"]);
          if (process.env.VERS_API_URL || process.env.VERS_VM_ID) {
            substrateCaps.add("state.snapshot");
            substrateCaps.add("state.snapshot.fast");
            substrateCaps.add("state.branch");
            substrateCaps.add("state.branch.fast");
          }
          for (const m of modules) {
            if (m.capabilities) m.capabilities.forEach((c) => substrateCaps.add(c));
          }
          return substrateCaps.has(cap);
        }),
        missing: s.requiredCapabilities.filter((cap) => {
          const modules = ctx.getModules();
          const substrateCaps = new Set(["hosting.web", "state.persist", "event.trigger"]);
          if (process.env.VERS_API_URL || process.env.VERS_VM_ID) {
            substrateCaps.add("state.snapshot");
            substrateCaps.add("state.branch");
          }
          for (const m of modules) {
            if (m.capabilities) m.capabilities.forEach((c) => substrateCaps.add(c));
          }
          return !substrateCaps.has(cap);
        }),
      },
      testResults: s.testResults ?? null,
      lastVerified: s.lastVerified ?? null,
    })),
    count: registry.seeds.length,
  };

  return c.json(manifest);
});

// Check if a seed's required capabilities are met
routes.post("/check", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.capabilities?.length) {
    return c.json({ error: "capabilities array required" }, 400);
  }

  const required: string[] = body.capabilities;

  // Compute current substrate capabilities
  const substrateCaps = new Set(["hosting.web", "state.persist", "event.trigger"]);
  if (process.env.VERS_API_URL || process.env.VERS_VM_ID) {
    substrateCaps.add("state.snapshot");
    substrateCaps.add("state.snapshot.fast");
    substrateCaps.add("state.branch");
    substrateCaps.add("state.branch.fast");
  }
  if (process.env.VERS_PUBLIC_URL) {
    substrateCaps.add("hosting.web.public");
    substrateCaps.add("hosting.dns");
  }
  for (const m of ctx.getModules()) {
    if (m.capabilities) m.capabilities.forEach((c) => substrateCaps.add(c));
  }

  const met = required.filter((c) => substrateCaps.has(c));
  const missing = required.filter((c) => !substrateCaps.has(c));

  return c.json({
    canGerminate: missing.length === 0,
    met,
    missing,
    substrate: [...substrateCaps].sort(),
  });
});

// -- Authenticated endpoints --------------------------------------------------

// List all seeds
routes.get("/inventory", (c) => {
  const denied = checkAuth(c);
  if (denied) return denied;

  return c.json({
    seeds: registry.seeds,
    count: registry.seeds.length,
  });
});

// Get a specific seed by content hash
routes.get("/:hash", (c) => {
  const denied = checkAuth(c);
  if (denied) return denied;

  const hash = c.req.param("hash");
  const seed = findSeed(hash);

  if (!seed) {
    return c.json({ error: `No seed with hash "${hash}" found` }, 404);
  }

  return c.json(seed);
});

// Register a germinated/grafted seed
routes.post("/register", async (c) => {
  const denied = checkAuth(c);
  if (denied) return denied;

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const { name, contentHash, versionLabel, method, services, requiredCapabilities, optionalCapabilities } = body;

  if (!name || !contentHash) {
    return c.json({ error: "name and contentHash are required" }, 400);
  }

  // Check for duplicate
  if (findSeed(contentHash)) {
    return c.json({ error: `Seed ${contentHash} is already registered` }, 409);
  }

  // Validate content hash format
  if (!contentHash.startsWith("sha256:")) {
    return c.json({ error: "contentHash must start with 'sha256:'" }, 400);
  }

  const record: SeedRecord = {
    name,
    contentHash,
    versionLabel: versionLabel ?? "unknown",
    method: method === "graft" ? "graft" : "germination",
    installed: new Date().toISOString(),
    services: services ?? [],
    conformance: "UNTESTED",
    requiredCapabilities: requiredCapabilities ?? [],
    optionalCapabilities: optionalCapabilities ?? [],
    sourceUrl: body.sourceUrl ?? undefined,
    adaptations: body.adaptations ?? undefined,
  };

  registry.seeds.push(record);
  saveRegistry();

  return c.json({ action: "registered", seed: record }, 201);
});

// Update a seed record (conformance, test results, etc.)
routes.patch("/:hash", async (c) => {
  const denied = checkAuth(c);
  if (denied) return denied;

  const hash = c.req.param("hash");
  const seed = findSeed(hash);

  if (!seed) {
    return c.json({ error: `No seed with hash "${hash}" found` }, 404);
  }

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  // Only allow updating specific fields
  if (body.conformance) seed.conformance = body.conformance;
  if (body.testResults) seed.testResults = body.testResults;
  if (body.lastVerified) seed.lastVerified = body.lastVerified;
  if (body.services) seed.services = body.services;
  if (body.adaptations) seed.adaptations = body.adaptations;

  saveRegistry();

  return c.json({ action: "updated", seed });
});

// Remove a seed record
routes.delete("/:hash", async (c) => {
  const denied = checkAuth(c);
  if (denied) return denied;

  const hash = c.req.param("hash");
  const idx = registry.seeds.findIndex(
    (s) => s.contentHash === hash || s.contentHash.startsWith(`sha256:${hash}`),
  );

  if (idx === -1) {
    return c.json({ error: `No seed with hash "${hash}" found` }, 404);
  }

  const removed = registry.seeds.splice(idx, 1)[0];
  saveRegistry();

  return c.json({ action: "removed", seed: removed });
});

// =============================================================================
// Module
// =============================================================================

const seeds: ServiceModule = {
  name: "seeds",
  description: "Seed provenance tracking and conformance manifests",
  routes,
  requiresAuth: false, // conformance + check are public; write endpoints check auth manually

  routeDocs: {
    "GET /conformance": {
      summary: "Public conformance manifest (seed spec §9.3). No auth required.",
      response: "{ v, type, timestamp, seeds: [{ name, content_hash, conformanceLevel, capabilities, testResults }], count }",
    },
    "POST /check": {
      summary: "Check if a seed's required capabilities can be met by this substrate. No auth required.",
      body: {
        capabilities: { type: "string[]", required: true, description: "Required capability identifiers to check" },
      },
      response: "{ canGerminate, met, missing, substrate }",
    },
    "GET /inventory": {
      summary: "List all germinated/grafted seeds",
      response: "{ seeds: [SeedRecord], count }",
    },
    "GET /:hash": {
      summary: "Get a seed record by content hash",
      params: { hash: { type: "string", required: true, description: "SHA-256 content hash (full or prefix)" } },
    },
    "POST /register": {
      summary: "Record a germinated or grafted seed",
      body: {
        name: { type: "string", required: true, description: "Seed name from TOML frontmatter" },
        contentHash: { type: "string", required: true, description: "SHA-256 content hash (sha256:...)" },
        versionLabel: { type: "string", description: "Human-readable version label" },
        method: { type: "string", description: "'germination' or 'graft'" },
        services: { type: "string[]", description: "Service names this seed produced" },
        requiredCapabilities: { type: "string[]", description: "Required capabilities from the seed" },
        optionalCapabilities: { type: "string[]", description: "Optional capabilities from the seed" },
        sourceUrl: { type: "string", description: "URL where the seed was fetched from" },
        adaptations: { type: "string[]", description: "Adaptations made during grafting" },
      },
      response: "{ action: 'registered', seed: SeedRecord }",
    },
    "PATCH /:hash": {
      summary: "Update a seed record (conformance, test results, etc.)",
      params: { hash: { type: "string", required: true, description: "SHA-256 content hash" } },
      body: {
        conformance: { type: "string", description: "FULL | SUBSTANTIAL | PARTIAL | MINIMAL | NON_CONFORMING | UNTESTED" },
        testResults: { type: "object", description: "{ core: { passed, failed, skipped }, extended?, edgeCase? }" },
        lastVerified: { type: "string", description: "ISO timestamp of verification" },
        services: { type: "string[]", description: "Updated list of services" },
        adaptations: { type: "string[]", description: "Updated list of adaptations" },
      },
    },
    "DELETE /:hash": {
      summary: "Remove a seed record",
      params: { hash: { type: "string", required: true, description: "SHA-256 content hash" } },
      response: "{ action: 'removed', seed: SeedRecord }",
    },
  },

  capabilities: [
    "reef.seeds",              // seed provenance tracking
    "reef.seeds.conformance",  // serves conformance manifests
    "reef.seeds.check",        // capability pre-flight checks
  ],

  store: {
    flush() { saveRegistry(); },
  },

  init(serviceCtx: ServiceContext) {
    ctx = serviceCtx;
    registryPath = join(serviceCtx.servicesDir, ".seeds.json");
    loadRegistry();
  },
};

export default seeds;
