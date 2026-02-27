/**
 * Installer tests — local install, git install, fleet-to-fleet, source parsing.
 *
 * Moved from tests/server.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createServer } from "../../src/core/server.js";
import { parseSource } from "./index.js";

const TEST_DIR = join(import.meta.dir, ".tmp-services-inst");
const EXTERNAL_DIR = join(import.meta.dir, ".tmp-external");
const AUTH_TOKEN = "test-token-12345";
const originalToken = process.env.VERS_AUTH_TOKEN;

function req(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  opts: { method?: string; body?: unknown; auth?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.auth) headers["Authorization"] = `Bearer ${opts.auth}`;
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }),
  );
}

async function json(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  opts: Parameters<typeof req>[2] = {},
) {
  const res = await req(app, path, opts);
  return { status: res.status, data: await res.json() };
}

function writeExternal(name: string, response: Record<string, unknown> = { external: true }) {
  const dir = join(EXTERNAL_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.ts"),
    `
import { Hono } from "hono";
const routes = new Hono();
routes.get("/", (c) => c.json(${JSON.stringify(response)}));
export default {
  name: "${name}",
  description: "External ${name}",
  routes,
  requiresAuth: false,
};
`,
  );
}

async function createWithInstaller() {
  const installerSrc = join(import.meta.dir, "index.ts");
  const installerDst = join(TEST_DIR, "installer");
  mkdirSync(installerDst, { recursive: true });
  const indexContent = readFileSync(installerSrc, "utf-8");
  const fixed = indexContent.replace(
    '"../src/core/types.js"',
    `"${join(import.meta.dir, "..", "..", "src", "core", "types.js")}"`,
  );
  writeFileSync(join(installerDst, "index.ts"), fixed);
  return createServer({ servicesDir: TEST_DIR });
}

beforeEach(() => {
  process.env.VERS_AUTH_TOKEN = AUTH_TOKEN;
  rmSync(TEST_DIR, { recursive: true, force: true });
  rmSync(EXTERNAL_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(EXTERNAL_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  rmSync(EXTERNAL_DIR, { recursive: true, force: true });
  if (originalToken) {
    process.env.VERS_AUTH_TOKEN = originalToken;
  } else {
    delete process.env.VERS_AUTH_TOKEN;
  }
});

// =============================================================================
// Installer
// =============================================================================

describe("installer module", () => {
  test("POST /installer/install from local path", async () => {
    writeExternal("my-plugin", { plugin: true, v: 1 });
    const { app } = await createWithInstaller();

    const install = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "my-plugin") },
    });
    expect(install.status).toBe(201);
    expect(install.data.action).toBe("installed");
    expect(install.data.type).toBe("local");
    expect(install.data.name).toBe("my-plugin");

    const { status, data } = await json(app, "/my-plugin");
    expect(status).toBe(200);
    expect(data.plugin).toBe(true);
  });

  test("local install creates a symlink", async () => {
    writeExternal("symlink-test");
    const { app } = await createWithInstaller();

    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "symlink-test") },
    });

    const linkPath = join(TEST_DIR, "symlink-test");
    expect(existsSync(linkPath)).toBe(true);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  test("GET /installer/installed lists installed packages", async () => {
    writeExternal("pkg-a");
    writeExternal("pkg-b");
    const { app } = await createWithInstaller();

    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "pkg-a") },
    });
    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "pkg-b") },
    });

    const { data } = await json(app, "/installer/installed", { auth: AUTH_TOKEN });
    expect(data.count).toBe(2);
    expect(data.installed.map((e: any) => e.dirName)).toContain("pkg-a");
    expect(data.installed.map((e: any) => e.dirName)).toContain("pkg-b");
    expect(data.installed[0].type).toBe("local");
    expect(data.installed[0].installedAt).toBeDefined();
  });

  test("duplicate install is rejected", async () => {
    writeExternal("dupe-test");
    const { app } = await createWithInstaller();

    const first = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "dupe-test") },
    });
    expect(first.status).toBe(201);

    const second = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "dupe-test") },
    });
    expect(second.status).toBe(409);
    expect(second.data.error).toContain("already installed");
  });

  test("install rejects directories without index.ts", async () => {
    const emptyDir = join(EXTERNAL_DIR, "no-index");
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, "README.md"), "not a service");

    const { app } = await createWithInstaller();
    const { status, data } = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: emptyDir },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("No index.ts");
    expect(existsSync(join(TEST_DIR, "no-index"))).toBe(false);
  });

  test("install rejects nonexistent paths", async () => {
    const { app } = await createWithInstaller();
    const { status, data } = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: "/nonexistent/path/to/service" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("not found");
  });

  test("install requires source field", async () => {
    const { app } = await createWithInstaller();
    const { status, data } = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: {},
    });
    expect(status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("POST /installer/remove unloads and deletes", async () => {
    writeExternal("removable-pkg", { removable: true });
    const { app } = await createWithInstaller();

    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "removable-pkg") },
    });

    let { status } = await json(app, "/removable-pkg");
    expect(status).toBe(200);

    const remove = await json(app, "/installer/remove", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "removable-pkg" },
    });
    expect(remove.data.action).toBe("removed");

    ({ status } = await json(app, "/removable-pkg"));
    expect(status).toBe(404);
    expect(existsSync(join(TEST_DIR, "removable-pkg"))).toBe(false);

    const { data } = await json(app, "/installer/installed", { auth: AUTH_TOKEN });
    expect(data.installed.map((e: any) => e.dirName)).not.toContain("removable-pkg");
  });

  test("remove rejects unknown packages", async () => {
    const { app } = await createWithInstaller();
    const { status, data } = await json(app, "/installer/remove", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "never-installed" },
    });
    expect(status).toBe(404);
    expect(data.error).toContain("not installed");
  });

  test("installed service shows in health check", async () => {
    writeExternal("health-visible");
    const { app } = await createWithInstaller();

    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "health-visible") },
    });

    const { data } = await json(app, "/health");
    expect(data.services).toContain("health-visible");
  });

  test("install and remove round-trip leaves clean state", async () => {
    writeExternal("round-trip");
    const { app } = await createWithInstaller();

    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "round-trip") },
    });
    await json(app, "/installer/remove", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "round-trip" },
    });

    const reinstall = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "round-trip") },
    });
    expect(reinstall.status).toBe(201);
    expect(reinstall.data.action).toBe("installed");
  });

  test("install from local git repo (clone, not symlink)", async () => {
    const bareRepo = join(EXTERNAL_DIR, "my-git-service.git");
    const workTree = join(EXTERNAL_DIR, "my-git-service-work");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    };

    execSync(`git init --bare ${bareRepo}`);
    mkdirSync(workTree, { recursive: true });
    writeFileSync(
      join(workTree, "index.ts"),
      `
import { Hono } from "hono";
const routes = new Hono();
routes.get("/", (c) => c.json({ from: "git", v: 1 }));
export default { name: "my-git-service", description: "Installed from git", routes, requiresAuth: false };
`,
    );
    execSync("git init && git add -A && git commit -m 'init'", { cwd: workTree, env: gitEnv });
    execSync(`git push ${bareRepo} HEAD:master`, { cwd: workTree });

    const { app } = await createWithInstaller();
    const install = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: bareRepo },
    });
    expect(install.status).toBe(201);
    expect(install.data.type).toBe("git");
    expect(install.data.name).toBe("my-git-service");

    const clonedDir = join(TEST_DIR, "my-git-service");
    expect(existsSync(clonedDir)).toBe(true);
    expect(lstatSync(clonedDir).isSymbolicLink()).toBe(false);
    expect(existsSync(join(clonedDir, ".git"))).toBe(true);

    const { status, data } = await json(app, "/my-git-service");
    expect(status).toBe(200);
    expect(data.from).toBe("git");
  });

  test("update pulls latest from git repo", async () => {
    const bareRepo = join(EXTERNAL_DIR, "updatable-svc.git");
    const workTree = join(EXTERNAL_DIR, "updatable-svc-work");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    };

    execSync(`git init --bare ${bareRepo}`);
    mkdirSync(workTree, { recursive: true });
    writeFileSync(
      join(workTree, "index.ts"),
      `
import { Hono } from "hono";
const routes = new Hono();
routes.get("/", (c) => c.json({ version: 1 }));
export default { name: "updatable-svc", routes, requiresAuth: false };
`,
    );
    execSync("git init && git add -A && git commit -m 'v1'", { cwd: workTree, env: gitEnv });
    execSync(`git push ${bareRepo} HEAD:master`, { cwd: workTree });

    const { app } = await createWithInstaller();

    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: bareRepo },
    });
    let res = await json(app, "/updatable-svc");
    expect(res.data.version).toBe(1);

    writeFileSync(
      join(workTree, "index.ts"),
      `
import { Hono } from "hono";
const routes = new Hono();
routes.get("/", (c) => c.json({ version: 2 }));
export default { name: "updatable-svc", routes, requiresAuth: false };
`,
    );
    execSync("git add -A && git commit -m 'v2'", { cwd: workTree, env: gitEnv });
    execSync(`git push ${bareRepo} HEAD:master`, { cwd: workTree });

    const update = await json(app, "/installer/update", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "updatable-svc" },
    });
    expect(update.data.action).toBe("updated");

    res = await json(app, "/updatable-svc");
    expect(res.data.version).toBe(2);
  });

  test("update rejects local-linked services", async () => {
    writeExternal("local-only");
    const { app } = await createWithInstaller();

    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { source: join(EXTERNAL_DIR, "local-only") },
    });

    const { status, data } = await json(app, "/installer/update", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "local-only" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("local link");
  });
});

// =============================================================================
// Fleet-to-fleet install
// =============================================================================

describe("fleet-to-fleet install", () => {
  const SOURCE_DIR = join(import.meta.dir, ".tmp-source-services");
  const DEST_DIR = join(import.meta.dir, ".tmp-dest-services");
  let sourceServer: ReturnType<typeof Bun.serve> | undefined;

  function setupSourceServer() {
    mkdirSync(SOURCE_DIR, { recursive: true });

    const managerSrc = join(import.meta.dir, "..", "services", "index.ts");
    const managerDst = join(SOURCE_DIR, "services");
    mkdirSync(managerDst, { recursive: true });
    const managerContent = readFileSync(managerSrc, "utf-8")
      .replace('"../src/core/types.js"', `"${join(import.meta.dir, "..", "..", "src", "core", "types.js")}"`);
    writeFileSync(join(managerDst, "index.ts"), managerContent);

    const svcDir = join(SOURCE_DIR, "exportable");
    mkdirSync(svcDir, { recursive: true });
    writeFileSync(join(svcDir, "index.ts"), `
import { Hono } from "hono";
const routes = new Hono();
routes.get("/", (c) => c.json({ pulled: true, origin: "source" }));
export default { name: "exportable", description: "A service that can be exported", routes, requiresAuth: false };
`);
    writeFileSync(join(svcDir, "helpers.ts"), `export const VERSION = 1;`);
  }

  async function setupDestServer() {
    mkdirSync(DEST_DIR, { recursive: true });

    const installerSrc = join(import.meta.dir, "index.ts");
    const installerDst = join(DEST_DIR, "installer");
    mkdirSync(installerDst, { recursive: true });
    const installerContent = readFileSync(installerSrc, "utf-8")
      .replace('"../src/core/types.js"', `"${join(import.meta.dir, "..", "..", "src", "core", "types.js")}"`);
    writeFileSync(join(installerDst, "index.ts"), installerContent);

    return createServer({ servicesDir: DEST_DIR });
  }

  beforeEach(() => {
    rmSync(SOURCE_DIR, { recursive: true, force: true });
    rmSync(DEST_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    sourceServer?.stop();
    sourceServer = undefined;
    rmSync(SOURCE_DIR, { recursive: true, force: true });
    rmSync(DEST_DIR, { recursive: true, force: true });
  });

  test("install a service from another instance", async () => {
    setupSourceServer();
    const source = await createServer({ servicesDir: SOURCE_DIR });
    sourceServer = Bun.serve({ fetch: source.app.fetch, port: 0 });
    const sourceUrl = `http://localhost:${sourceServer.port}`;

    const exportCheck = await fetch(`${sourceUrl}/services/export/exportable`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(exportCheck.status).toBe(200);
    expect(exportCheck.headers.get("Content-Type")).toBe("application/gzip");

    const { app } = await setupDestServer();
    const install = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { from: sourceUrl, name: "exportable", token: AUTH_TOKEN },
    });
    expect(install.status).toBe(201);
    expect(install.data.type).toBe("fleet");
    expect(install.data.from).toBe(sourceUrl);
    expect(install.data.name).toBe("exportable");

    const { status, data } = await json(app, "/exportable");
    expect(status).toBe(200);
    expect(data.pulled).toBe(true);
    expect(data.origin).toBe("source");
    expect(existsSync(join(DEST_DIR, "exportable", "helpers.ts"))).toBe(true);

    const installed = await json(app, "/installer/installed", { auth: AUTH_TOKEN });
    const entry = installed.data.installed.find((e: any) => e.dirName === "exportable");
    expect(entry.type).toBe("fleet");
    expect(entry.source).toBe(`${sourceUrl}#exportable`);
  });

  test("from requires name", async () => {
    const { app } = await setupDestServer();
    const { status, data } = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { from: "http://localhost:9999" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("name");
  });

  test("fails gracefully when remote is unreachable", async () => {
    const { app } = await setupDestServer();
    const { status, data } = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { from: "http://localhost:19999", name: "nope" },
    });
    expect(status).toBe(400);
    expect(data.error).toBeDefined();
  });

  test("fails gracefully when remote service doesn't exist", async () => {
    setupSourceServer();
    const source = await createServer({ servicesDir: SOURCE_DIR });
    sourceServer = Bun.serve({ fetch: source.app.fetch, port: 0 });
    const sourceUrl = `http://localhost:${sourceServer.port}`;

    const { app } = await setupDestServer();
    const { status, data } = await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { from: sourceUrl, name: "nonexistent", token: AUTH_TOKEN },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("404");
  });

  test("update re-pulls from the same remote", async () => {
    setupSourceServer();
    const source = await createServer({ servicesDir: SOURCE_DIR });
    sourceServer = Bun.serve({ fetch: source.app.fetch, port: 0 });
    const sourceUrl = `http://localhost:${sourceServer.port}`;

    const { app } = await setupDestServer();
    await json(app, "/installer/install", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { from: sourceUrl, name: "exportable", token: AUTH_TOKEN },
    });

    const update = await json(app, "/installer/update", {
      method: "POST",
      auth: AUTH_TOKEN,
      body: { name: "exportable", token: AUTH_TOKEN },
    });
    expect(update.data.action).toBe("updated");
  });
});

// =============================================================================
// Source parsing
// =============================================================================

describe("source parsing", () => {
  test("GitHub shorthand: user/repo", () => {
    const parsed = parseSource("acme/cool-service");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/cool-service");
    expect(parsed.dirName).toBe("cool-service");
    expect(parsed.ref).toBeUndefined();
  });

  test("GitHub shorthand with ref: user/repo@v1.0", () => {
    const parsed = parseSource("acme/cool-service@v1.0");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/cool-service");
    expect(parsed.ref).toBe("v1.0");
  });

  test("HTTPS URL: https://github.com/user/repo", () => {
    const parsed = parseSource("https://github.com/acme/my-service");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/my-service");
    expect(parsed.dirName).toBe("my-service");
  });

  test("HTTPS URL with .git suffix", () => {
    const parsed = parseSource("https://github.com/acme/my-service.git");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/my-service.git");
    expect(parsed.dirName).toBe("my-service");
  });

  test("HTTPS URL with ref", () => {
    const parsed = parseSource("https://github.com/acme/my-service@main");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/my-service");
    expect(parsed.ref).toBe("main");
  });

  test("SSH URL: git@github.com:user/repo", () => {
    const parsed = parseSource("git@github.com:acme/my-service");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("git@github.com:acme/my-service");
    expect(parsed.dirName).toBe("my-service");
  });

  test("SSH URL with ref", () => {
    const parsed = parseSource("git@github.com:acme/my-service@v2.0");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("git@github.com:acme/my-service");
    expect(parsed.ref).toBe("v2.0");
  });

  test("bare host: github.com/user/repo", () => {
    const parsed = parseSource("github.com/acme/my-service");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/my-service");
  });

  test("bare host with ref", () => {
    const parsed = parseSource("github.com/acme/my-service@feat-branch");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://github.com/acme/my-service");
    expect(parsed.ref).toBe("feat-branch");
  });

  test("non-GitHub host: gitlab.com/user/repo", () => {
    const parsed = parseSource("gitlab.com/team/service");
    expect(parsed.type).toBe("git");
    expect(parsed.url).toBe("https://gitlab.com/team/service");
    expect(parsed.dirName).toBe("service");
  });

  test("rejects unparseable input", () => {
    expect(() => parseSource("just-a-word")).toThrow("Cannot parse source");
  });
});
