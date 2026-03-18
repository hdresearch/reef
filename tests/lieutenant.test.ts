import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../src/core/server.js";
import { ServiceEventBus } from "../src/core/events.js";
import lieutenant from "../services/lieutenant/index.js";
import { createRoutes } from "../services/lieutenant/routes.js";
import { LieutenantRuntime } from "../services/lieutenant/runtime.js";
import { LieutenantStore } from "../services/lieutenant/store.js";
import registry from "../services/registry/index.js";
import vmTree from "../services/vm-tree/index.js";

const TMP_DIR = join(import.meta.dir, ".tmp-lieutenant");
const FAKE_PI_PATH = join(TMP_DIR, "fake-pi.mjs");
const AUTH_TOKEN = "test-token-12345";

const ORIGINAL_ENV = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  PI_PATH: process.env.PI_PATH,
  VERS_AUTH_TOKEN: process.env.VERS_AUTH_TOKEN,
  VERS_INFRA_URL: process.env.VERS_INFRA_URL,
  VERS_VM_ID: process.env.VERS_VM_ID,
  VERS_AGENT_NAME: process.env.VERS_AGENT_NAME,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function writeFakePi() {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(
    FAKE_PI_PATH,
    `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

rl.on("line", (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }

  if (cmd.type === "get_state") {
    emit({ type: "response", command: "get_state", state: "idle" });
    return;
  }

  if (cmd.type === "set_model") {
    emit({ type: "response", command: "set_model", ok: true, model: cmd.modelId ?? null });
    return;
  }

  if (cmd.type === "prompt" || cmd.type === "follow_up" || cmd.type === "steer") {
    emit({ type: "agent_start" });
    setTimeout(() => {
      emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: "handled:" + (cmd.message ?? ""),
        },
      });
      emit({ type: "agent_end" });
    }, 10);
  }
});

process.stdin.resume();
`,
  );
  chmodSync(FAKE_PI_PATH, 0o755);
}

function request(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    auth?: boolean;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.auth) headers.Authorization = `Bearer ${AUTH_TOKEN}`;

  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
}

async function json(
  app: { fetch: (req: Request) => Promise<Response> },
  path: string,
  opts: Parameters<typeof request>[2] = {},
) {
  const res = await request(app, path, opts);
  return { status: res.status, data: await res.json() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for condition");
}

beforeEach(() => {
  writeFakePi();
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.PI_PATH = FAKE_PI_PATH;
  process.env.VERS_AUTH_TOKEN = AUTH_TOKEN;
  process.env.VERS_AGENT_NAME = "reef-test";
  delete process.env.VERS_INFRA_URL;
  delete process.env.VERS_VM_ID;
});

afterEach(() => {
  restoreEnv();
  rmSync(TMP_DIR, { recursive: true, force: true });
  rmSync(join(process.cwd(), "data", "lieutenants"), { recursive: true, force: true });
});

describe("lieutenant routes and runtime", () => {
  test("defaults create requests to remote mode and rejects missing commitId", async () => {
    const store = new LieutenantStore(join(TMP_DIR, "default-mode.sqlite"));
    const runtime = new LieutenantRuntime({ events: new ServiceEventBus(), store });
    const app = createRoutes(store, () => runtime);

    const { status, data } = await json(app, "/lieutenants", {
      method: "POST",
      body: {
        name: "remote-default",
        role: "audit remote default",
        anthropicApiKey: "test-anthropic-key",
      },
    });

    expect(status).toBe(400);
    expect(data.error).toContain("commitId is required");
    expect(store.list()).toEqual([]);

    await runtime.shutdown();
    store.close();
  });

  test("creates a local lieutenant, runs a task, and reads the completed output from history", async () => {
    const store = new LieutenantStore(join(TMP_DIR, "local-runtime.sqlite"));
    const runtime = new LieutenantRuntime({ events: new ServiceEventBus(), store });
    const app = createRoutes(store, () => runtime);

    const created = await json(app, "/lieutenants", {
      method: "POST",
      body: {
        name: "local-alpha",
        role: "local validation",
        local: true,
        anthropicApiKey: "test-anthropic-key",
      },
    });
    expect(created.status).toBe(201);
    expect(created.data.isLocal).toBe(true);
    expect(created.data.status).toBe("idle");

    const sent = await json(app, "/lieutenants/local-alpha/send", {
      method: "POST",
      body: { message: "hello lieutenant" },
    });
    expect(sent.status).toBe(200);
    expect(sent.data.sent).toBe(true);

    await waitFor(() => {
      const lt = store.getByName("local-alpha");
      return lt?.status === "idle" && (lt.outputHistory.length ?? 0) === 1;
    });

    const read = await json(app, "/lieutenants/local-alpha/read");
    expect(read.status).toBe(200);
    expect(read.data.status).toBe("idle");
    expect(read.data.historyCount).toBe(1);
    expect(read.data.output).toContain("handled:hello lieutenant");

    const destroyed = await json(app, "/lieutenants/local-alpha", { method: "DELETE" });
    expect(destroyed.status).toBe(200);
    expect(destroyed.data.destroyed).toBe(true);
    expect(store.getByName("local-alpha")?.status).toBe("destroyed");

    await runtime.shutdown();
    store.close();
  });
});

describe("registry and vm-tree event wiring", () => {
  test("registers remote lieutenants from server events", async () => {
    process.env.VERS_VM_ID = "parent-root-1";
    const { app, events, liveModules } = await createServer({
      modules: [registry, vmTree, lieutenant],
    });

    const vmId = `vm-test-${Date.now()}`;
    await events.emit("lieutenant:created", {
      name: "remote-bravo",
      vmId,
      role: "orchestrator",
      isLocal: false,
      address: `${vmId}.vm.vers.sh`,
      createdAt: new Date().toISOString(),
      parentVmId: "parent-root-1",
      commitId: "commit-123",
    });

    const registryList = await json(app, "/registry/vms?role=lieutenant", { auth: true });
    expect(registryList.status).toBe(200);
    expect(registryList.data.count).toBeGreaterThanOrEqual(1);
    expect(registryList.data.vms.some((vm: any) => vm.id === vmId)).toBe(true);

    const vmTreeList = await json(app, "/vm-tree/vms?category=lieutenant", { auth: true });
    expect(vmTreeList.status).toBe(200);
    expect(vmTreeList.data.vms.some((vm: any) => vm.vmId === vmId && vm.parentVmId === "parent-root-1")).toBe(true);

    await events.emit("lieutenant:paused", { vmId });
    const paused = await json(app, `/registry/vms/${vmId}`, { auth: true });
    expect(paused.status).toBe(200);
    expect(paused.data.status).toBe("paused");

    await events.emit("lieutenant:resumed", { vmId });
    const resumed = await json(app, `/registry/vms/${vmId}`, { auth: true });
    expect(resumed.status).toBe(200);
    expect(resumed.data.status).toBe("running");

    await events.emit("lieutenant:destroyed", { vmId });
    const afterDestroy = await json(app, "/registry/vms?role=lieutenant", { auth: true });
    expect(afterDestroy.status).toBe(200);
    expect(afterDestroy.data.vms.some((vm: any) => vm.id === vmId)).toBe(false);

    for (const mod of liveModules.values()) {
      if (mod.store?.close) await mod.store.close();
    }
  });
});
