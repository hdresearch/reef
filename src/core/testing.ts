/**
 * Test helpers for service modules.
 *
 * Usage:
 *   import { createTestHarness } from "../src/core/testing.js";
 *
 *   const t = await createTestHarness({
 *     services: [import("../services/board/index.js")],
 *   });
 *
 *   const res = await t.fetch("/board/tasks", { auth: true });
 *   expect(res.status).toBe(200);
 *
 *   t.cleanup();
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "./server.js";
import type { ServiceModule } from "./types.js";

export interface TestHarnessOptions {
  /** Service modules to load. Can be module objects or dynamic imports. */
  services: Array<ServiceModule | Promise<{ default: ServiceModule }>>;
  /** Auth token (default: "test-token") */
  authToken?: string;
  /** Temp data dir for stores (default: auto-created, auto-cleaned) */
  dataDir?: string;
}

export interface TestHarness {
  /** The Hono app — call app.fetch() to make requests */
  app: { fetch: (req: Request) => Promise<Response> };
  /** Auth token for this test */
  authToken: string;
  /** Temp directory for data files */
  dataDir: string;

  /** Make a request with optional auth and body */
  fetch(
    path: string,
    opts?: {
      method?: string;
      body?: unknown;
      auth?: boolean | string;
      headers?: Record<string, string>;
    },
  ): Promise<Response>;

  /** Make a request and parse JSON response */
  json<T = unknown>(
    path: string,
    opts?: {
      method?: string;
      body?: unknown;
      auth?: boolean | string;
    },
  ): Promise<{ status: number; data: T }>;

  /** Clean up temp directories */
  cleanup(): void;
}

export async function createTestHarness(options: TestHarnessOptions): Promise<TestHarness> {
  const authToken = options.authToken ?? "test-token";
  const dataDir =
    options.dataDir ??
    join(import.meta.dir, "..", "..", "tests", `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  // Set up env
  const prevToken = process.env.VERS_AUTH_TOKEN;
  process.env.VERS_AUTH_TOKEN = authToken;

  // Create temp dirs
  mkdirSync(dataDir, { recursive: true });

  // Resolve modules
  const modules: ServiceModule[] = [];
  for (const mod of options.services) {
    if ("name" in mod && "routes" in mod) {
      // Already a ServiceModule
      modules.push(mod as ServiceModule);
    } else {
      // Dynamic import — resolve the promise and get default export
      const resolved = await (mod as Promise<{ default: ServiceModule }>);
      modules.push(resolved.default);
    }
  }

  // Create server with the modules directly (no services dir needed)
  const emptyDir = join(dataDir, "_empty_services");
  mkdirSync(emptyDir, { recursive: true });
  const { app } = await createServer({
    modules,
    servicesDir: emptyDir,
  });

  function makeFetch(
    path: string,
    opts: {
      method?: string;
      body?: unknown;
      auth?: boolean | string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (opts.body) headers["Content-Type"] = "application/json";
    if (opts.auth === true) {
      headers.Authorization = `Bearer ${authToken}`;
    } else if (typeof opts.auth === "string") {
      headers.Authorization = `Bearer ${opts.auth}`;
    }

    return app.fetch(
      new Request(`http://localhost${path}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      }),
    );
  }

  async function makeJson<T = unknown>(
    path: string,
    opts: {
      method?: string;
      body?: unknown;
      auth?: boolean | string;
    } = {},
  ): Promise<{ status: number; data: T }> {
    const res = await makeFetch(path, opts);
    return { status: res.status, data: (await res.json()) as T };
  }

  function cleanup() {
    rmSync(dataDir, { recursive: true, force: true });
    if (prevToken !== undefined) {
      process.env.VERS_AUTH_TOKEN = prevToken;
    } else {
      delete process.env.VERS_AUTH_TOKEN;
    }
  }

  return {
    app,
    authToken,
    dataDir,
    fetch: makeFetch,
    json: makeJson,
    cleanup,
  };
}
