/**
 * Service module discovery — scan a directory, dynamic import, topo-sort.
 *
 * Follows the pi-mono pattern: each service is a self-contained directory
 * with an index.ts that default-exports a ServiceModule. Drop a folder in,
 * it gets picked up. Delete one, it's gone. No import wiring.
 *
 * Discovery rules:
 *   services/foo/index.ts  → import default → ServiceModule
 *
 * Modules are topologically sorted by `dependencies` before being returned,
 * so init() hooks can safely reference stores from upstream modules.
 */

import { readdirSync, existsSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import type { ServiceModule, ServiceContext } from "./types.js";

// =============================================================================
// Initial discovery
// =============================================================================

/**
 * Discover and load all service modules from a directory.
 *
 * @param servicesDir - Path to the services directory (e.g. "./services")
 * @returns Topologically sorted array of ServiceModules
 */
export async function discoverServiceModules(
  servicesDir: string,
): Promise<ServiceModule[]> {
  const resolved = resolve(servicesDir);

  if (!existsSync(resolved)) {
    throw new Error(`Services directory not found: ${resolved}`);
  }

  const entries = readdirSync(resolved, { withFileTypes: true });
  const modules: ServiceModule[] = [];
  const errors: Array<{ dir: string; error: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const indexPath = join(resolved, entry.name, "index.ts");
    if (!existsSync(indexPath)) continue;

    try {
      const mod = await import(indexPath);
      const serviceModule: ServiceModule = mod.default;

      if (!serviceModule?.name) {
        errors.push({
          dir: entry.name,
          error: "No default export or missing 'name' property",
        });
        continue;
      }

      modules.push(serviceModule);
    } catch (err) {
      errors.push({
        dir: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (errors.length > 0) {
    for (const { dir, error } of errors) {
      console.error(`  [discover] Failed to load services/${dir}: ${error}`);
    }
  }

  return topoSort(modules);
}

/**
 * Filter modules that have client-side code (tools, behaviors, or widgets).
 * Used by the extension loader to skip server-only modules.
 */
export function filterClientModules(modules: ServiceModule[]): ServiceModule[] {
  return modules.filter(
    (m) => m.registerTools || m.registerBehaviors || m.widget,
  );
}

// =============================================================================
// Single-module loading (used by watcher and reload endpoints)
// =============================================================================

/**
 * Load a single service module from a directory.
 * Uses cache-busting so re-imports pick up changes.
 */
export async function loadServiceModule(
  dirPath: string,
): Promise<ServiceModule> {
  const indexPath = join(dirPath, "index.ts");

  if (!existsSync(indexPath)) {
    throw new Error(`No index.ts found in ${dirPath}`);
  }

  // Cache-bust so Bun re-imports the module on reload
  const mod = await import(`${indexPath}?t=${Date.now()}`);
  const serviceModule: ServiceModule = mod.default;

  if (!serviceModule?.name) {
    throw new Error(`No valid default export in ${indexPath}`);
  }

  return serviceModule;
}

// =============================================================================
// Watcher — auto-detect new service directories (adds only)
// =============================================================================

export interface WatcherOptions {
  servicesDir: string;
  liveModules: Map<string, ServiceModule>;
  onNewDir: (dirName: string) => void;
}

/**
 * Watch the services directory for new subdirectories.
 * Only handles additions — updates and removes are explicit via /services endpoints.
 * Calls onNewDir when a directory appears that isn't already loaded.
 *
 * Returns a function to stop watching.
 */
export function watchForNewServices(options: WatcherOptions): () => void {
  const { servicesDir, liveModules, onNewDir } = options;
  const resolved = resolve(servicesDir);

  // Track known directories so we only fire for genuinely new ones
  const knownDirs = new Set<string>();
  if (existsSync(resolved)) {
    for (const entry of readdirSync(resolved, { withFileTypes: true })) {
      if (entry.isDirectory()) knownDirs.add(entry.name);
    }
  }

  let debounce: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(resolved, { persistent: false }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => scan(), 500);
  });

  function scan() {
    if (!existsSync(resolved)) return;

    for (const entry of readdirSync(resolved, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (knownDirs.has(entry.name)) continue;

      const indexPath = join(resolved, entry.name, "index.ts");
      if (!existsSync(indexPath)) continue;

      knownDirs.add(entry.name);
      onNewDir(entry.name);
    }
  }

  return () => {
    watcher.close();
    if (debounce) clearTimeout(debounce);
  };
}

// =============================================================================
// Topological sort by dependencies
// =============================================================================

function topoSort(modules: ServiceModule[]): ServiceModule[] {
  const byName = new Map<string, ServiceModule>();
  for (const m of modules) byName.set(m.name, m);

  const visited = new Set<string>();
  const sorted: ServiceModule[] = [];

  function visit(name: string, stack: Set<string>) {
    if (visited.has(name)) return;
    if (stack.has(name)) {
      throw new Error(
        `Circular dependency detected: ${[...stack, name].join(" → ")}`,
      );
    }

    const mod = byName.get(name);
    if (!mod) return; // dependency not present — skip silently

    stack.add(name);
    for (const dep of mod.dependencies ?? []) {
      visit(dep, stack);
    }
    stack.delete(name);

    visited.add(name);
    sorted.push(mod);
  }

  for (const mod of modules) {
    visit(mod.name, new Set());
  }

  return sorted;
}
