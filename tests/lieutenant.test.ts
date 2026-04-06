import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../src/core/server.js";
import { ServiceEventBus } from "../src/core/events.js";
import lieutenant from "../services/lieutenant/index.js";
import { createRoutes } from "../services/lieutenant/routes.js";
import { buildPersistKeysScript, buildPersistVmIdScript, buildRemoteEnv } from "../services/lieutenant/rpc.js";
import { LieutenantRuntime } from "../services/lieutenant/runtime.js";
import { LieutenantStore, ValidationError } from "../services/lieutenant/store.js";
import vmTree from "../services/vm-tree/index.js";
import { VMTreeStore } from "../services/vm-tree/store.js";

const TMP_DIR = join(import.meta.dir, ".tmp-lieutenant");
const AUTH_TOKEN = "test-token-12345";

const ORIGINAL_ENV = {
  LLM_PROXY_KEY: process.env.LLM_PROXY_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  REEF_MODEL_PROVIDER: process.env.REEF_MODEL_PROVIDER,
  VERS_API_KEY: process.env.VERS_API_KEY,
  VERS_AUTH_TOKEN: process.env.VERS_AUTH_TOKEN,
  VERS_GOLDEN_COMMIT_ID: process.env.VERS_GOLDEN_COMMIT_ID,
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

function createFakeRemoteHandle() {
  const handlers = new Set<(event: any) => void>();
  let alive = true;

  return {
    handle: {
      send(cmd: any) {
        if (!alive) return;

        if (cmd.type === "get_state") {
          for (const handler of handlers) {
            handler({ type: "response", command: "get_state", state: "idle" });
          }
          return;
        }

        if (cmd.type === "set_model") {
          for (const handler of handlers) {
            handler({ type: "response", command: "set_model", ok: true, model: cmd.modelId ?? null });
          }
          return;
        }

        if (cmd.type === "prompt" || cmd.type === "follow_up" || cmd.type === "steer") {
          for (const handler of handlers) {
            handler({ type: "agent_start" });
          }
          setTimeout(() => {
            for (const handler of handlers) {
              handler({
                type: "message_update",
                assistantMessageEvent: {
                  type: "text_delta",
                  delta: `remote:${cmd.message ?? ""}`,
                },
              });
              handler({ type: "agent_end" });
            }
          }, 10);
        }
      },
      onEvent(handler: (event: any) => void) {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
      async kill() {
        alive = false;
      },
      vmId: "vm-remote-1",
      isAlive() {
        return alive;
      },
      reconnectTail() {},
      suspendTail() {},
    },
  };
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
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  process.env.LLM_PROXY_KEY = "sk-vers-test-key";
  process.env.VERS_AUTH_TOKEN = AUTH_TOKEN;
  process.env.VERS_AGENT_NAME = "reef-test";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.REEF_MODEL_PROVIDER;
  delete process.env.VERS_INFRA_URL;
  delete process.env.VERS_VM_ID;
});

afterEach(() => {
  restoreEnv();
  rmSync(TMP_DIR, { recursive: true, force: true });
  rmSync(join(process.cwd(), "data", "lieutenants"), { recursive: true, force: true });
});

describe("lieutenant routes and runtime", () => {
  test("remote lieutenant env exports VERS_VM_ID for child reef tools", () => {
    process.env.VERS_INFRA_URL = "https://root.example:3000";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.REEF_MODEL_PROVIDER = "anthropic";
    const env = buildRemoteEnv("vm-child-123", {
      llmProxyKey: "sk-vers-test-key",
      model: "claude-test",
    });

    expect(env).toContain("export VERS_VM_ID='vm-child-123'");
    expect(env).toContain("export VERS_INFRA_URL='https://root.example:3000'");
    expect(env).toContain("export REEF_CATEGORY='lieutenant'");
    expect(env).not.toContain("ANTHROPIC_API_KEY");
    expect(env).not.toContain("REEF_MODEL_PROVIDER");
  });

  test("post-restore VM identity script persists VERS_VM_ID into reef-agent.sh", () => {
    const script = buildPersistVmIdScript("vm-child-123");
    expect(script).toContain("touch /etc/profile.d/reef-agent.sh");
    expect(script).toContain("export VERS_VM_ID='vm-child-123'");
    expect(script).toContain("grep -q '^export VERS_VM_ID='");
    expect(script).toContain("sed -i");
  });

  test("buildPersistKeysScript persists all runtime config into reef-agent.sh", () => {
    process.env.VERS_API_KEY = "vers-key-abc";
    process.env.VERS_INFRA_URL = "https://root.example:3000";
    process.env.VERS_GOLDEN_COMMIT_ID = "golden-xyz";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.REEF_MODEL_PROVIDER = "anthropic";
    const script = buildPersistKeysScript({ llmProxyKey: "sk-vers-test", model: "claude-test" });
    expect(script).toContain("touch /etc/profile.d/reef-agent.sh");
    expect(script).toContain("grep -q '^export LLM_PROXY_KEY='");
    expect(script).toContain("export LLM_PROXY_KEY='sk-vers-test'");
    expect(script).toContain("grep -q '^export VERS_API_KEY='");
    expect(script).toContain("export VERS_API_KEY='vers-key-abc'");
    expect(script).toContain("grep -q '^export VERS_INFRA_URL='");
    expect(script).toContain("export VERS_INFRA_URL='https://root.example:3000'");
    expect(script).toContain("grep -q '^export VERS_GOLDEN_COMMIT_ID='");
    expect(script).toContain("export VERS_GOLDEN_COMMIT_ID='golden-xyz'");
    expect(script).not.toContain("ANTHROPIC_API_KEY");
    expect(script).not.toContain("REEF_MODEL_PROVIDER");
  });

  test("buildPersistKeysScript omits LLM_PROXY_KEY when not provided", () => {
    delete process.env.VERS_API_KEY;
    delete process.env.LLM_PROXY_KEY;
    const script = buildPersistKeysScript({ model: "claude-test" });
    expect(script).not.toContain("LLM_PROXY_KEY");
  });

  test("defaults create requests to remote mode and fails when no golden commit can be resolved", async () => {
    const store = new LieutenantStore(join(TMP_DIR, "default-mode.sqlite"));
    const runtime = new LieutenantRuntime({
      events: new ServiceEventBus(),
      store,
      resolveCommitId: async () => {
        throw new ValidationError("No golden commit available");
      },
    });
    const app = createRoutes(store, () => runtime);

    const { status, data } = await json(app, "/lieutenants", {
      method: "POST",
      body: {
        name: "remote-default",
        role: "audit remote default",
        llmProxyKey: "sk-vers-test-key",
      },
    });

    expect(status).toBe(400);
    expect(data.error).toContain("No golden commit available");
    expect(store.list()).toEqual([]);

    await runtime.shutdown();
    store.close();
  });

  test("registers a remote agent VM and syncs status/output over RPC", async () => {
    const store = new LieutenantStore(join(TMP_DIR, "remote-runtime.sqlite"));
    const remote = createFakeRemoteHandle();

    const runtime = new LieutenantRuntime({
      events: new ServiceEventBus(),
      store,
      getVmState: async () => "running",
      reconnectRemoteHandle: async () => remote.handle as any,
      waitForRemoteSession: async () => {},
    });
    const app = createRoutes(store, () => runtime);

    const registered = await json(app, "/lieutenants/register", {
      method: "POST",
      body: {
        name: "remote-rpc",
        role: "remote agent lieutenant",
        vmId: "vm-remote-1",
      },
    });
    expect(registered.status).toBe(201);
    expect(registered.data.vmId).toBe("vm-remote-1");
    expect(registered.data.status).toBe("idle");

    const listBeforeSend = await json(app, "/lieutenants", {});
    expect(listBeforeSend.status).toBe(200);
    expect(listBeforeSend.data.count).toBe(1);

    const sent = await json(app, "/lieutenants/remote-rpc/send", {
      method: "POST",
      body: { message: "hello remote" },
    });
    expect(sent.status).toBe(200);
    expect(sent.data.sent).toBe(true);
    expect(store.getByName("remote-rpc")?.status).toBe("working");

    await waitFor(() => {
      const lt = store.getByName("remote-rpc");
      return lt?.status === "idle" && (lt.outputHistory.length ?? 0) === 1;
    });

    const read = await json(app, "/lieutenants/remote-rpc/read");
    expect(read.status).toBe(200);
    expect(read.data.status).toBe("idle");
    expect(read.data.output).toContain("remote:hello remote");
    expect(store.getByName("remote-rpc")?.outputHistory.at(-1)).toBe("remote:hello remote");

    await runtime.shutdown();
    store.close();
  });
});

describe("vm-tree lieutenant event wiring", () => {
  test("registers and updates remote lieutenants from server events", async () => {
    process.env.VERS_VM_ID = "parent-root-1";
    const { app, events, liveModules } = await createServer({
      modules: [vmTree, lieutenant],
    });

    const vmId = `vm-test-${Date.now()}`;
    await events.emit("lieutenant:created", {
      name: "remote-bravo",
      vmId,
      role: "orchestrator",
      address: `${vmId}.vm.vers.sh`,
      createdAt: new Date().toISOString(),
      parentVmId: "parent-root-1",
      commitId: "commit-123",
    });

    const vmTreeList = await json(app, "/vm-tree/vms?category=lieutenant", { auth: true });
    expect(vmTreeList.status).toBe(200);
    expect(
      vmTreeList.data.vms.some(
        (vm: any) => vm.vmId === vmId && vm.parentId === "parent-root-1" && vm.status === "running",
      ),
    ).toBe(true);

    await events.emit("lieutenant:paused", { vmId });
    const paused = await json(app, `/vm-tree/vms/${vmId}`, { auth: true });
    expect(paused.status).toBe(200);
    expect(paused.data.status).toBe("paused");

    await events.emit("lieutenant:resumed", { vmId });
    const resumed = await json(app, `/vm-tree/vms/${vmId}`, { auth: true });
    expect(resumed.status).toBe(200);
    expect(resumed.data.status).toBe("running");

    await events.emit("lieutenant:destroyed", { vmId });
    const afterDestroy = await json(app, `/vm-tree/vms/${vmId}`, { auth: true });
    expect(afterDestroy.status).toBe(200);
    expect(afterDestroy.data.status).toBe("destroyed");

    for (const mod of liveModules.values()) {
      if (mod.name === "vm-tree") continue;
      if (mod.store?.close) await mod.store.close();
    }
  });
});

describe("lieutenant live-target gating", () => {
  test("rejects sends to stopped lieutenants", async () => {
    const store = new LieutenantStore(join(TMP_DIR, "stopped-send.sqlite"));
    const remote = createFakeRemoteHandle();
    const runtime = new LieutenantRuntime({
      events: new ServiceEventBus(),
      store,
      getVmState: async () => "running",
      reconnectRemoteHandle: async () => remote.handle as any,
      waitForRemoteSession: async () => {},
    });
    const app = createRoutes(store, () => runtime);

    const registered = await json(app, "/lieutenants/register", {
      method: "POST",
      body: {
        name: "stopped-lt",
        role: "stopped lieutenant",
        vmId: "vm-stopped-1",
      },
    });
    expect(registered.status).toBe(201);

    store.update("stopped-lt", { status: "stopped" });

    const sent = await json(app, "/lieutenants/stopped-lt/send", {
      method: "POST",
      body: { message: "should not deliver" },
    });

    expect(sent.status).toBe(400);
    expect(sent.data.error).toContain("is stopped and is not a live task target");

    await runtime.shutdown();
    store.close();
  });

  test("rejects sends when vm-tree already marked the lieutenant stopped", async () => {
    const store = new LieutenantStore(join(TMP_DIR, "vm-tree-stopped-send.sqlite"));
    const vmTreeStore = new VMTreeStore(join(TMP_DIR, "vm-tree-stopped-send-fleet.sqlite"));
    const remote = createFakeRemoteHandle();
    const runtime = new LieutenantRuntime({
      events: new ServiceEventBus(),
      store,
      vmTreeStore,
      getVmState: async () => "running",
      reconnectRemoteHandle: async () => remote.handle as any,
      waitForRemoteSession: async () => {},
    });
    const app = createRoutes(store, () => runtime);

    vmTreeStore.createVM({
      vmId: "vm-stopped-tree-1",
      name: "tree-stopped-lt",
      category: "lieutenant",
      status: "stopped",
      parentId: "vm-root-1",
      rpcStatus: "disconnected",
    });

    const registered = await json(app, "/lieutenants/register", {
      method: "POST",
      body: {
        name: "tree-stopped-lt",
        role: "stopped in vm-tree",
        vmId: "vm-stopped-tree-1",
      },
    });
    expect(registered.status).toBe(201);

    // Simulate the race seen live: lieutenant store has not yet converged away from idle.
    store.update("tree-stopped-lt", { status: "idle" });

    const sent = await json(app, "/lieutenants/tree-stopped-lt/send", {
      method: "POST",
      body: { message: "should not deliver" },
    });

    expect(sent.status).toBe(400);
    expect(sent.data.error).toContain("is stopped and is not a live task target");
    expect(store.getByName("tree-stopped-lt")?.status).toBe("stopped");

    await runtime.shutdown();
    store.close();
    vmTreeStore.close();
  });
});

describe("vm-tree lieutenant discovery", () => {
  test("discovers lieutenants from vm-tree without registry", async () => {
    const store = new LieutenantStore(join(TMP_DIR, "discover-vm-tree.sqlite"));
    const vmTreeStore = new VMTreeStore(join(TMP_DIR, "fleet.sqlite"));
    vmTreeStore.createVM({
      vmId: "vm-lt-1",
      name: "lineage-lt",
      category: "lieutenant",
      status: "running",
      parentId: "vm-root-1",
      discovery: {
        registeredVia: "lieutenant:create",
        agentLabel: "lineage-lt",
        reconnectKind: "lieutenant",
        roleHint: "usage orchestrator",
      },
    });

    const remote = createFakeRemoteHandle();
    const runtime = new LieutenantRuntime({
      events: new ServiceEventBus(),
      store,
      vmTreeStore,
      getVmState: async () => "running",
      reconnectRemoteHandle: async () => remote.handle as any,
      waitForRemoteSession: async () => {},
    });

    const results = await runtime.discover();

    expect(results.some((line) => line.includes("lineage-lt: available"))).toBe(true);
    expect(store.getByName("lineage-lt")?.vmId).toBe("vm-lt-1");
    expect(store.getByName("lineage-lt")?.role).toBe("usage orchestrator");

    await runtime.shutdown();
    store.close();
    vmTreeStore.close();
  });
});
