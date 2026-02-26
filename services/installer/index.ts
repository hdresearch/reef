/**
 * Installer service module — install, update, and remove service modules
 * from git repos or local paths.
 *
 *   POST   /installer/install   — install a service from a source
 *   POST   /installer/update    — pull latest and reload
 *   POST   /installer/remove    — unload and delete
 *   GET    /installer/installed — list installed packages with source info
 *
 * Sources:
 *   https://github.com/user/repo          — clone via git
 *   git@github.com:user/repo              — clone via SSH
 *   /absolute/path/to/service             — symlink a local directory
 *
 * Installed services are tracked in data/installer.json so we know
 * which services came from external sources vs. built-in.
 */

import { Hono } from "hono";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import type { ServiceModule, ServiceContext } from "../src/core/types.js";

let ctx: ServiceContext;

// =============================================================================
// Registry — tracks what was installed and how
// =============================================================================

interface InstalledEntry {
  /** Directory name under services/ */
  dirName: string;
  /** Original source (git URL or local path) */
  source: string;
  /** How it was installed */
  type: "git" | "local";
  /** When it was installed */
  installedAt: string;
  /** Git ref if pinned */
  ref?: string;
}

function registryPath(): string {
  return join(ctx.servicesDir, ".installer.json");
}

function loadRegistry(): InstalledEntry[] {
  try {
    const p = registryPath();
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8")).installed ?? [];
    }
  } catch {}
  return [];
}

function saveRegistry(entries: InstalledEntry[]): void {
  writeFileSync(registryPath(), JSON.stringify({ installed: entries }, null, 2));
}

function findEntry(
  entries: InstalledEntry[],
  nameOrSource: string,
): InstalledEntry | undefined {
  return entries.find(
    (e) => e.dirName === nameOrSource || e.source === nameOrSource,
  );
}

// =============================================================================
// Source parsing
// =============================================================================

interface ParsedSource {
  type: "git" | "local";
  url: string;
  ref?: string;
  dirName: string;
}

/**
 * Parse a source string into a structured object.
 *
 * Supported formats:
 *   /absolute/path              → local
 *   ./relative/path             → local
 *   ../relative/path            → local
 *   user/repo                   → git (GitHub shorthand)
 *   user/repo@v1.0              → git (GitHub shorthand + ref)
 *   github.com/user/repo        → git (HTTPS)
 *   https://github.com/user/repo → git (HTTPS)
 *   git@github.com:user/repo    → git (SSH)
 *   https://example.com/repo.git@main → git (HTTPS + ref)
 */
export function parseSource(source: string): ParsedSource {
  // Local path — starts with / or ./ or ../
  if (source.startsWith("/") || source.startsWith("./") || source.startsWith("../")) {
    const resolved = resolve(source);
    if (!existsSync(resolved)) {
      throw new Error(`Local path not found: ${resolved}`);
    }

    // If it's a bare git repo or a .git path, treat as git clone source
    const isBareGitRepo = existsSync(join(resolved, "HEAD")) && existsSync(join(resolved, "objects"));
    if (isBareGitRepo || resolved.endsWith(".git")) {
      const repoName = basename(resolved).replace(/\.git$/, "");
      return { type: "git", url: resolved, dirName: repoName };
    }

    return {
      type: "local",
      url: resolved,
      dirName: basename(resolved),
    };
  }

  // Everything else is git. Extract optional @ref suffix first.
  let raw = source;
  let ref: string | undefined;

  // Match @ref at the end, but not the @ in git@github.com:...
  // Strategy: find the last @ that comes after a repo-name-like segment
  // SSH pattern: git@host:user/repo[@ref]
  // HTTPS pattern: https://host/user/repo[@ref]
  // Shorthand: user/repo[@ref]

  const sshMatch = raw.match(/^(git@[^:]+:.+?)(?:@([^@/]+))?$/);
  const httpsMatch = raw.match(/^(https?:\/\/.+?)(?:@([^@/]+))?$/);
  const bareHostMatch = raw.match(/^([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\/.+?)(?:@([^@/]+))?$/);
  const shorthandMatch = raw.match(/^([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)(?:@([^@/]+))?$/);

  let url: string;

  if (sshMatch) {
    // git@github.com:user/repo or git@github.com:user/repo@v1.0
    url = sshMatch[1];
    ref = sshMatch[2];
  } else if (httpsMatch) {
    // https://github.com/user/repo or https://github.com/user/repo@main
    url = httpsMatch[1];
    ref = httpsMatch[2];
  } else if (bareHostMatch) {
    // github.com/user/repo → https://github.com/user/repo
    url = `https://${bareHostMatch[1]}`;
    ref = bareHostMatch[2];
  } else if (shorthandMatch) {
    // user/repo → https://github.com/user/repo
    url = `https://github.com/${shorthandMatch[1]}`;
    ref = shorthandMatch[2];
  } else {
    throw new Error(
      `Cannot parse source: "${source}". Expected a local path, git URL, or user/repo shorthand.`,
    );
  }

  // Extract repo name: last path segment, strip .git
  const repoName = basename(url.replace(/\.git$/, "").replace(/:([^/])/, "/$1"));

  return { type: "git", url, ref, dirName: repoName };
}

// =============================================================================
// Operations
// =============================================================================

function exec(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    timeout: 120_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

async function installFromGit(
  parsed: ParsedSource,
  servicesDir: string,
): Promise<string> {
  const targetDir = join(servicesDir, parsed.dirName);

  if (existsSync(targetDir)) {
    throw new Error(
      `Directory "${parsed.dirName}" already exists. Use update to pull latest, or remove first.`,
    );
  }

  // Clone
  const refArg = parsed.ref ? `--branch ${parsed.ref} --single-branch` : "";
  exec(`git clone ${refArg} ${parsed.url} ${targetDir}`);

  // Install dependencies if package.json exists
  if (existsSync(join(targetDir, "package.json"))) {
    const hasBun = (() => {
      try { exec("bun --version"); return true; } catch { return false; }
    })();
    exec(hasBun ? "bun install" : "npm install", targetDir);
  }

  return targetDir;
}

function installFromLocal(
  parsed: ParsedSource,
  servicesDir: string,
): string {
  const targetDir = join(servicesDir, parsed.dirName);

  if (existsSync(targetDir)) {
    throw new Error(
      `Directory "${parsed.dirName}" already exists. Remove first.`,
    );
  }

  // Symlink so changes to the source are reflected immediately
  symlinkSync(parsed.url, targetDir);
  return targetDir;
}

async function updateGit(entry: InstalledEntry, servicesDir: string): Promise<void> {
  const targetDir = join(servicesDir, entry.dirName);

  if (!existsSync(targetDir)) {
    throw new Error(`Directory "${entry.dirName}" not found`);
  }

  // Check if it's a symlink (local install) — can't update those
  if (lstatSync(targetDir).isSymbolicLink()) {
    throw new Error(`"${entry.dirName}" is a local symlink, not a git clone. Nothing to update.`);
  }

  exec("git pull", targetDir);

  // Reinstall dependencies
  if (existsSync(join(targetDir, "package.json"))) {
    const hasBun = (() => {
      try { exec("bun --version"); return true; } catch { return false; }
    })();
    exec(hasBun ? "bun install" : "npm install", targetDir);
  }
}

// =============================================================================
// Routes
// =============================================================================

const routes = new Hono();

routes.post("/install", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const source = body.source as string;

  if (!source?.trim()) {
    return c.json({ error: "source is required" }, 400);
  }

  try {
    const parsed = parseSource(source.trim());
    const registry = loadRegistry();

    // Check if already installed
    if (findEntry(registry, parsed.dirName)) {
      return c.json(
        { error: `"${parsed.dirName}" is already installed. Use update or remove first.` },
        409,
      );
    }

    const servicesDir = ctx.servicesDir;

    // Install
    if (parsed.type === "git") {
      await installFromGit(parsed, servicesDir);
      console.log(`  [install] Cloned ${parsed.url} → services/${parsed.dirName}`);
    } else {
      installFromLocal(parsed, servicesDir);
      console.log(`  [install] Linked ${parsed.url} → services/${parsed.dirName}`);
    }

    // Verify it has an index.ts
    const indexPath = join(servicesDir, parsed.dirName, "index.ts");
    if (!existsSync(indexPath)) {
      // Clean up
      rmSync(join(servicesDir, parsed.dirName), { recursive: true, force: true });
      return c.json(
        { error: `No index.ts found in ${parsed.dirName}. Not a valid service module.` },
        400,
      );
    }

    // Register in our tracking file
    registry.push({
      dirName: parsed.dirName,
      source: source.trim(),
      type: parsed.type,
      installedAt: new Date().toISOString(),
      ref: parsed.ref,
    });
    saveRegistry(registry);

    // Load the module
    const result = await ctx.loadModule(parsed.dirName);
    console.log(`  [install] /${result.name} — loaded`);

    return c.json({
      name: result.name,
      dirName: parsed.dirName,
      source: source.trim(),
      type: parsed.type,
      action: "installed",
    }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

routes.post("/update", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = (body.name as string)?.trim();

  if (!name) {
    return c.json({ error: "name is required (dirName or source)" }, 400);
  }

  try {
    const registry = loadRegistry();
    const entry = findEntry(registry, name);

    if (!entry) {
      return c.json({ error: `"${name}" is not installed via the installer` }, 404);
    }

    if (entry.type !== "git") {
      return c.json({ error: `"${entry.dirName}" is a local link — updates are automatic` }, 400);
    }

    await updateGit(entry, ctx.servicesDir);
    console.log(`  [update] services/${entry.dirName} — pulled latest`);

    // Reload the module
    const result = await ctx.loadModule(entry.dirName);
    console.log(`  [update] /${result.name} — reloaded`);

    return c.json({
      name: result.name,
      dirName: entry.dirName,
      action: "updated",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

routes.post("/remove", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = (body.name as string)?.trim();

  if (!name) {
    return c.json({ error: "name is required (dirName or source)" }, 400);
  }

  try {
    const registry = loadRegistry();
    const entry = findEntry(registry, name);

    if (!entry) {
      return c.json({ error: `"${name}" is not installed via the installer` }, 404);
    }

    // Unload from the server
    const mod = ctx.getModules().find((m) => m.name === entry.dirName);
    if (mod) {
      await ctx.unloadModule(mod.name);
      console.log(`  [remove] /${mod.name} — unloaded`);
    }

    // Delete the directory (or symlink)
    const targetDir = join(ctx.servicesDir, entry.dirName);
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }

    // Remove from registry
    const updated = registry.filter((e) => e.dirName !== entry.dirName);
    saveRegistry(updated);

    console.log(`  [remove] services/${entry.dirName} — deleted`);

    return c.json({
      dirName: entry.dirName,
      action: "removed",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

routes.get("/installed", (c) => {
  const registry = loadRegistry();
  return c.json({ installed: registry, count: registry.length });
});

// =============================================================================
// Module
// =============================================================================

const installer: ServiceModule = {
  name: "installer",
  description: "Install, update, and remove service modules from git or local paths",
  routes,

  init(serviceCtx: ServiceContext) {
    ctx = serviceCtx;
  },

  routeDocs: {
    "POST /install": {
      summary: "Install a service module from a source",
      detail: "Clones git repos or symlinks local paths into the services directory, installs dependencies, and hot-loads the module.",
      body: {
        source: { type: "string", required: true, description: "Git URL (https or SSH) or local path. Append @ref to pin a version." },
      },
      response: "{ name, dirName, source, type, action: 'installed' }",
    },
    "POST /update": {
      summary: "Pull latest from git and reload",
      detail: "Only works for git-installed services. Local symlinks update automatically.",
      body: {
        name: { type: "string", required: true, description: "Directory name or original source URL" },
      },
      response: "{ name, dirName, action: 'updated' }",
    },
    "POST /remove": {
      summary: "Unload and delete an installed service",
      detail: "Unloads the module from the server, deletes the directory (or symlink), and removes from the registry.",
      body: {
        name: { type: "string", required: true, description: "Directory name or original source URL" },
      },
      response: "{ dirName, action: 'removed' }",
    },
    "GET /installed": {
      summary: "List all services installed via the installer",
      response: "{ installed: [{ dirName, source, type, installedAt, ref? }], count }",
    },
  },
};

export default installer;
