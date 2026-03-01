/**
 * Scaffold service — generate structurally correct service module skeletons.
 *
 * Eliminates boilerplate so agents focus on logic, not wiring. The scaffold
 * guarantees correct exports, types, file structure, and conventions.
 *
 *   POST /scaffold/preview     — generate files and return them (no write)
 *   POST /scaffold/create      — generate files, write to disk, optionally load
 *
 * The generated skeleton follows every convention from the create-service skill:
 * correct ServiceModule interface, store with flush/scheduleSave, Hono routes
 * with proper error handling, TypeBox tool schemas, panel IIFE with PANEL_API,
 * and a test file using createTestHarness.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { ServiceContext, ServiceModule } from "../src/core/types.js";

let ctx: ServiceContext;

const routes = new Hono();

// =============================================================================
// Types
// =============================================================================

interface RouteSpec {
  method: string;
  path: string;
  description?: string;
  body?: Record<string, { type: string; required?: boolean; description?: string }>;
  response?: string;
}

interface ScaffoldRequest {
  name: string;
  description?: string;
  routes?: RouteSpec[];
  store?: boolean;
  tools?: boolean;
  panel?: boolean;
  behaviors?: boolean;
  dependencies?: string[];
  requiresAuth?: boolean;
  capabilities?: string[];
}

interface GeneratedFile {
  path: string;
  content: string;
}

// =============================================================================
// Code generation
// =============================================================================

function generateStore(name: string): string {
  const className = `${toPascalCase(name)}Store`;
  return `/**
 * ${className} — data persistence for the ${name} service.
 *
 * JSON file with debounced writes. Store files go in data/ (gitignored).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Item {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export class ${className} {
  private items = new Map<string, Item>();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath = "data/${name}.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
        if (Array.isArray(data.items)) {
          for (const item of data.items) this.items.set(item.id, item);
        }
      }
    } catch {
      this.items = new Map();
    }
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 100);
  }

  flush(): void {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      this.filePath,
      JSON.stringify({ items: Array.from(this.items.values()) }, null, 2),
      "utf-8",
    );
  }

  create(input: Partial<Item>): Item {
    const now = new Date().toISOString();
    const item: Item = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(item.id, item);
    this.scheduleSave();
    return item;
  }

  get(id: string): Item | undefined {
    return this.items.get(id);
  }

  list(): Item[] {
    return Array.from(this.items.values()).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    );
  }

  update(id: string, input: Partial<Item>): Item | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    Object.assign(item, input, { updatedAt: new Date().toISOString() });
    this.items.set(id, item);
    this.scheduleSave();
    return item;
  }

  delete(id: string): boolean {
    const existed = this.items.delete(id);
    if (existed) this.scheduleSave();
    return existed;
  }
}
`;
}

function generateRoutes(name: string, routeSpecs: RouteSpec[], hasStore: boolean): string {
  const className = `${toPascalCase(name)}Store`;
  const storeImport = hasStore ? `import type { ${className} } from "./store.js";` : "";
  const storeParam = hasStore ? `store: ${className}` : "";

  const handlers = routeSpecs
    .map((r) => {
      const method = r.method.toLowerCase();
      const isWrite = ["post", "put", "patch"].includes(method);
      const bodyLine = isWrite ? "\n    const body = await c.req.json();" : "";
      const asyncKw = isWrite ? "async " : "";
      const statusCode = method === "post" ? ", 201" : "";

      return `  // ${r.description || `${r.method} ${r.path}`}
  routes.${method}("${r.path}", ${asyncKw}(c) => {${bodyLine}
    // TODO: implement
    return c.json({ error: "not implemented" }${statusCode});
  });`;
    })
    .join("\n\n");

  return `import { Hono } from "hono";
${storeImport}

export function createRoutes(${storeParam}): Hono {
  const routes = new Hono();

${handlers}

  return routes;
}
`;
}

function generateTools(name: string, routeSpecs: RouteSpec[]): string {
  const toolFunctions = routeSpecs
    .map((r) => {
      const toolName = `${name}_${r.method.toLowerCase()}_${r.path.replace(/^\//, "").replace(/[/:]/g, "_") || "root"}`;
      const label = `${toPascalCase(name)}: ${r.method} ${r.path}`;
      const description = r.description || `${r.method} ${r.path}`;

      const paramFields = r.body
        ? Object.entries(r.body)
            .map(([key, spec]) => {
              const typeStr =
                spec.type === "string" ? "Type.String" : spec.type === "number" ? "Type.Number" : "Type.String";
              const wrapped =
                spec.required === false
                  ? `Type.Optional(${typeStr}({ description: "${spec.description || key}" }))`
                  : `${typeStr}({ description: "${spec.description || key}" })`;
              return `      ${key}: ${wrapped},`;
            })
            .join("\n")
        : `      // TODO: add parameters`;

      return `  pi.registerTool({
    name: "${toolName}",
    label: "${label}",
    description: "${description}",
    parameters: Type.Object({
${paramFields}
    }),
    async execute(_id, params) {
      if (!client.getBaseUrl()) return client.noUrl();
      try {
        const result = await client.api("${r.method}", "/${name}${r.path}", params);
        return client.ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });`;
    })
    .join("\n\n");

  return `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FleetClient } from "../../src/core/types.js";
import { Type } from "@sinclair/typebox";

export function registerTools(pi: ExtensionAPI, client: FleetClient) {
${toolFunctions}
}
`;
}

function generateBehaviors(_name: string): string {
  return `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FleetClient } from "../../src/core/types.js";

export function registerBehaviors(pi: ExtensionAPI, client: FleetClient) {
  // Automatic behaviors — event handlers, timers, lifecycle hooks.
  // These run without the LLM deciding to call them.

  pi.on("session_start", async () => {
    if (!client.getBaseUrl()) return;
    // TODO: implement startup behavior
  });

  pi.on("session_shutdown", async () => {
    // TODO: clean up timers, connections
  });
}
`;
}

function generatePanel(name: string): string {
  const cssClass = `panel-${name}`;
  const rootId = `${name}-panel-root`;

  return `<style>
.${cssClass} { padding: 8px; }
.${cssClass} .card {
  background: var(--bg-card, #1a1a1a);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 4px; padding: 10px; margin: 4px 0;
}
.${cssClass} .empty {
  color: var(--text-dim, #666); font-style: italic;
  padding: 20px; text-align: center;
}
</style>

<div class="${cssClass}" id="${rootId}">
  <div class="empty">Loading…</div>
</div>

<script>
(function() {
  const root = document.getElementById('${rootId}');
  const API = typeof PANEL_API !== 'undefined' ? PANEL_API : '/ui/api';

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  async function load() {
    try {
      const res = await fetch(API + '/${name}');
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      render(data);
    } catch (e) {
      root.innerHTML = '<div class="empty">Unavailable: ' + esc(e.message) + '</div>';
    }
  }

  function render(data) {
    root.innerHTML = '<div class="card">' + esc(JSON.stringify(data)) + '</div>';
  }

  load();
  setInterval(load, 10000);
})();
</script>`;
}

function generateIndex(name: string, spec: ScaffoldRequest): string {
  const className = `${toPascalCase(name)}Store`;
  const imports: string[] = [`import type { ServiceModule, ServiceContext } from "../../src/core/types.js";`];

  if (spec.store) {
    imports.push(`import { ${className} } from "./store.js";`);
  }
  if (spec.routes?.length) {
    imports.push(`import { createRoutes } from "./routes.js";`);
  }
  if (spec.tools) {
    imports.push(`import { registerTools } from "./tools.js";`);
  }
  if (spec.behaviors) {
    imports.push(`import { registerBehaviors } from "./behaviors.js";`);
  }

  const lines: string[] = [];
  lines.push(`/**`);
  lines.push(` * ${toPascalCase(name)} service module — ${spec.description || name}.`);
  lines.push(` */`);
  lines.push(``);
  lines.push(imports.join("\n"));
  lines.push(``);

  if (spec.store) {
    lines.push(`const store = new ${className}();`);
    lines.push(``);
  }

  if (spec.panel) {
    lines.push(`const panelHtml = ${JSON.stringify(generatePanel(name))};`);
    lines.push(``);
  }

  // Build routeDocs from spec
  const routeDocEntries: string[] = [];
  for (const r of spec.routes ?? []) {
    const parts: string[] = [];
    parts.push(`      summary: ${JSON.stringify(r.description || `${r.method} ${r.path}`)},`);
    if (r.body) {
      const bodyEntries = Object.entries(r.body)
        .map(
          ([k, v]) =>
            `        ${k}: { type: ${JSON.stringify(v.type || "string")}, required: ${v.required ?? true}, description: ${JSON.stringify(v.description || k)} },`,
        )
        .join("\n");
      parts.push(`      body: {\n${bodyEntries}\n      },`);
    }
    if (r.response) {
      parts.push(`      response: ${JSON.stringify(r.response)},`);
    }
    routeDocEntries.push(`    "${r.method} ${r.path}": {\n${parts.join("\n")}\n    },`);
  }

  // Build the module object
  lines.push(`const ${toCamelCase(name)}: ServiceModule = {`);
  lines.push(`  name: ${JSON.stringify(name)},`);
  if (spec.description) {
    lines.push(`  description: ${JSON.stringify(spec.description)},`);
  }
  lines.push(``);

  // Server side
  if (spec.routes?.length) {
    const routeArg = spec.store ? "store" : "";
    lines.push(`  routes: createRoutes(${routeArg}),`);
  }
  if (spec.store) {
    lines.push(`  store,`);
  }
  if (spec.requiresAuth === false) {
    lines.push(`  requiresAuth: false,`);
  }
  lines.push(``);

  // Client side
  if (spec.tools) {
    lines.push(`  registerTools,`);
  }
  if (spec.behaviors) {
    lines.push(`  registerBehaviors,`);
  }
  lines.push(``);

  // Metadata
  if (spec.dependencies?.length) {
    lines.push(`  dependencies: ${JSON.stringify(spec.dependencies)},`);
  }
  if (spec.capabilities?.length) {
    lines.push(`  capabilities: ${JSON.stringify(spec.capabilities)},`);
  }

  // routeDocs
  if (routeDocEntries.length) {
    lines.push(`  routeDocs: {`);
    for (const entry of routeDocEntries) lines.push(entry);
    lines.push(`  },`);
  }

  // Panel route injection via init
  if (spec.panel && spec.routes?.length) {
    lines.push(``);
    lines.push(`  init(ctx: ServiceContext) {`);
    lines.push(`    // Panel route — returns HTML fragment for the UI dashboard`);
    lines.push(`    const mod = this as ServiceModule;`);
    lines.push(`    if (mod.routes) {`);
    lines.push(`      mod.routes.get("/_panel", (c) => c.html(panelHtml));`);
    lines.push(`    }`);
    lines.push(`  },`);
  } else if (spec.panel) {
    // No routes defined but panel requested — create routes just for the panel
    lines.push(``);
    lines.push(`  init(ctx: ServiceContext) {`);
    lines.push(`    // TODO: wire up panel if needed`);
    lines.push(`  },`);
  }

  lines.push(`};`);
  lines.push(``);
  lines.push(`export default ${toCamelCase(name)};`);
  lines.push(``);

  return lines.join("\n");
}

function generateTest(name: string, spec: ScaffoldRequest): string {
  const _importPath = spec.store ? `./index.js` : `./index.js`;
  const testCases: string[] = [];

  for (const r of spec.routes ?? []) {
    const method = r.method.toUpperCase();
    const isWrite = ["POST", "PUT", "PATCH"].includes(method);

    testCases.push(`  test("${method} /${name}${r.path} returns a response", async () => {
    await setup;
    const { status } = await t.json("/${name}${r.path}", {
      method: "${method}",
      auth: true,${isWrite ? `\n      body: {},` : ""}
    });
    // Scaffold returns 201 or 200 with { error: "not implemented" }
    // Update this test once you implement the route
    expect(typeof status).toBe("number");
  });`);
  }

  if (spec.requiresAuth !== false) {
    testCases.push(`  test("requires auth", async () => {
    await setup;
    const { status } = await t.json("/${name}");
    expect(status).toBe(401);
  });`);
  }

  return `import { describe, test, expect, afterAll } from "bun:test";
import { createTestHarness, type TestHarness } from "../../src/core/testing.js";
import service from "./index.js";

let t: TestHarness;

const setup = (async () => {
  t = await createTestHarness({ services: [service] });
})();

afterAll(() => t?.cleanup());

describe("${name}", () => {
${testCases.join("\n\n")}
});
`;
}

function generateFiles(spec: ScaffoldRequest): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const name = spec.name;

  // Always generate index.ts
  files.push({ path: `${name}/index.ts`, content: generateIndex(name, spec) });

  // Store
  if (spec.store) {
    files.push({ path: `${name}/store.ts`, content: generateStore(name) });
  }

  // Routes
  if (spec.routes?.length) {
    files.push({ path: `${name}/routes.ts`, content: generateRoutes(name, spec.routes, !!spec.store) });
  }

  // Tools
  if (spec.tools) {
    files.push({ path: `${name}/tools.ts`, content: generateTools(name, spec.routes ?? []) });
  }

  // Behaviors
  if (spec.behaviors) {
    files.push({ path: `${name}/behaviors.ts`, content: generateBehaviors(name) });
  }

  // Test
  files.push({ path: `${name}/${name}.test.ts`, content: generateTest(name, spec) });

  return files;
}

// =============================================================================
// Validation
// =============================================================================

function validateSpec(body: unknown): { spec: ScaffoldRequest; error?: string } {
  if (!body || typeof body !== "object") {
    return { spec: null as any, error: "JSON body required" };
  }

  const b = body as Record<string, unknown>;

  if (!b.name || typeof b.name !== "string") {
    return { spec: null as any, error: "name is required (string)" };
  }

  const name = b.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  if (!name || name.length < 2) {
    return { spec: null as any, error: "name must be at least 2 characters (a-z, 0-9, hyphens)" };
  }

  // Reserved names
  const reserved = new Set(["health", "scaffold", "services", "installer", "docs", "agent"]);
  if (reserved.has(name)) {
    return { spec: null as any, error: `"${name}" is a reserved service name` };
  }

  const routeSpecs: RouteSpec[] = [];
  if (Array.isArray(b.routes)) {
    for (const r of b.routes) {
      if (!r.method || !r.path) continue;
      routeSpecs.push({
        method: String(r.method).toUpperCase(),
        path: String(r.path).startsWith("/") ? String(r.path) : `/${r.path}`,
        description: r.description ? String(r.description) : undefined,
        body: r.body as RouteSpec["body"],
        response: r.response ? String(r.response) : undefined,
      });
    }
  }

  return {
    spec: {
      name,
      description: b.description ? String(b.description) : undefined,
      routes: routeSpecs,
      store: !!b.store,
      tools: !!b.tools,
      panel: !!b.panel,
      behaviors: !!b.behaviors,
      dependencies: Array.isArray(b.dependencies) ? b.dependencies.map(String) : undefined,
      requiresAuth: b.requiresAuth === false ? false : undefined,
      capabilities: Array.isArray(b.capabilities) ? b.capabilities.map(String) : undefined,
    },
  };
}

// =============================================================================
// Helpers
// =============================================================================

function toPascalCase(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function toCamelCase(s: string): string {
  const pascal = toPascalCase(s);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// =============================================================================
// Routes
// =============================================================================

// Preview — generate files but don't write them
routes.post("/preview", async (c) => {
  const body = await c.req.json().catch(() => null);
  const { spec, error } = validateSpec(body);
  if (error) return c.json({ error }, 400);

  const files = generateFiles(spec);
  return c.json({
    name: spec.name,
    files: files.map((f) => ({ path: f.path, content: f.content })),
    count: files.length,
  });
});

// Create — generate files, write to disk, optionally hot-load
routes.post("/create", async (c) => {
  const body = await c.req.json().catch(() => null);
  const { spec, error } = validateSpec(body);
  if (error) return c.json({ error }, 400);

  const targetDir = join(ctx.servicesDir, spec.name);

  // Don't overwrite existing services
  if (existsSync(targetDir)) {
    return c.json(
      {
        error: `Service directory "${spec.name}" already exists. Use preview to inspect, then write files manually to update.`,
      },
      409,
    );
  }

  const files = generateFiles(spec);

  // Write all files
  mkdirSync(targetDir, { recursive: true });
  for (const f of files) {
    const filePath = join(ctx.servicesDir, f.path);
    const dir = join(filePath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, f.content, "utf-8");
  }

  // Hot-load the new service if requested (default: true)
  const load = (body as any).load !== false;
  let loadResult: { name: string; action: string } | null = null;
  let loadError: string | null = null;

  if (load) {
    try {
      loadResult = await ctx.loadModule(spec.name);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  }

  return c.json(
    {
      name: spec.name,
      files: files.map((f) => f.path),
      count: files.length,
      directory: targetDir,
      loaded: loadResult ?? undefined,
      loadError: loadError ?? undefined,
    },
    201,
  );
});

// =============================================================================
// Module definition
// =============================================================================

const scaffold: ServiceModule = {
  name: "scaffold",
  description: "Generate service module skeletons",
  routes,

  routeDocs: {
    "POST /preview": {
      summary: "Generate a service skeleton and return the files without writing to disk",
      body: {
        name: { type: "string", required: true, description: "Service name (a-z, 0-9, hyphens)" },
        description: { type: "string", description: "Human-readable description" },
        routes: { type: "RouteSpec[]", description: "Array of { method, path, description?, body?, response? }" },
        store: { type: "boolean", description: "Generate a JSON store with CRUD (default: false)" },
        tools: { type: "boolean", description: "Generate pi extension tools (default: false)" },
        panel: { type: "boolean", description: "Generate a dashboard panel (default: false)" },
        behaviors: { type: "boolean", description: "Generate pi extension behaviors (default: false)" },
        dependencies: { type: "string[]", description: "Service dependencies for load ordering" },
        capabilities: { type: "string[]", description: "Seed capabilities this service provides" },
        requiresAuth: { type: "boolean", description: "Whether routes need auth (default: true)" },
      },
      response: "{ name, files: [{ path, content }], count }",
    },
    "POST /create": {
      summary: "Generate a service skeleton, write to disk, and optionally hot-load it",
      body: {
        name: { type: "string", required: true, description: "Service name" },
        description: { type: "string", description: "Human-readable description" },
        routes: { type: "RouteSpec[]", description: "Route specifications" },
        store: { type: "boolean", description: "Generate a store" },
        tools: { type: "boolean", description: "Generate pi tools" },
        panel: { type: "boolean", description: "Generate a dashboard panel" },
        behaviors: { type: "boolean", description: "Generate behaviors" },
        load: { type: "boolean", description: "Hot-load after creation (default: true)" },
      },
      response: "{ name, files, count, directory, loaded?, loadError? }",
    },
  },

  capabilities: [
    "reef.scaffold", // can generate service module skeletons
  ],

  init(serviceCtx: ServiceContext) {
    ctx = serviceCtx;
  },
};

export default scaffold;
