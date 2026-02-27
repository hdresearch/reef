/**
 * Extension tests — client, discover (filterClientModules, topoSort), and extension composer.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFleetClient } from "../src/core/client.js";
import { createExtension } from "../src/core/extension.js";
import {
  discoverServiceModules,
  filterClientModules,
} from "../src/core/discover.js";
import type { ServiceModule } from "../src/core/types.js";

// =============================================================================
// FleetClient
// =============================================================================

describe("FleetClient", () => {
  const origUrl = process.env.VERS_INFRA_URL;
  const origToken = process.env.VERS_AUTH_TOKEN;
  const origName = process.env.VERS_AGENT_NAME;
  const origVm = process.env.VERS_VM_ID;
  const origRole = process.env.VERS_AGENT_ROLE;

  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    };
    restore("VERS_INFRA_URL", origUrl);
    restore("VERS_AUTH_TOKEN", origToken);
    restore("VERS_AGENT_NAME", origName);
    restore("VERS_VM_ID", origVm);
    restore("VERS_AGENT_ROLE", origRole);
  });

  test("getBaseUrl returns VERS_INFRA_URL", () => {
    process.env.VERS_INFRA_URL = "http://localhost:3000";
    const client = createFleetClient();
    expect(client.getBaseUrl()).toBe("http://localhost:3000");
  });

  test("getBaseUrl returns null when not set", () => {
    delete process.env.VERS_INFRA_URL;
    const client = createFleetClient();
    expect(client.getBaseUrl()).toBeNull();
  });

  test("agentName falls back to process pid", () => {
    delete process.env.VERS_AGENT_NAME;
    const client = createFleetClient();
    expect(client.agentName).toBe(`agent-${process.pid}`);
  });

  test("agentName uses VERS_AGENT_NAME", () => {
    process.env.VERS_AGENT_NAME = "test-agent";
    const client = createFleetClient();
    expect(client.agentName).toBe("test-agent");
  });

  test("vmId uses VERS_VM_ID", () => {
    process.env.VERS_VM_ID = "vm-123";
    const client = createFleetClient();
    expect(client.vmId).toBe("vm-123");
  });

  test("vmId is undefined when not set", () => {
    delete process.env.VERS_VM_ID;
    const client = createFleetClient();
    expect(client.vmId).toBeUndefined();
  });

  test("agentRole defaults to worker", () => {
    delete process.env.VERS_AGENT_ROLE;
    const client = createFleetClient();
    expect(client.agentRole).toBe("worker");
  });

  test("agentRole uses VERS_AGENT_ROLE", () => {
    process.env.VERS_AGENT_ROLE = "orchestrator";
    const client = createFleetClient();
    expect(client.agentRole).toBe("orchestrator");
  });

  test("ok() builds a success result", () => {
    const client = createFleetClient();
    const result = client.ok("task created", { id: "123" });
    expect(result.content[0].text).toBe("task created");
    expect(result.details).toEqual({ id: "123" });
    expect(result.isError).toBeUndefined();
  });

  test("err() builds an error result", () => {
    const client = createFleetClient();
    const result = client.err("something broke");
    expect(result.content[0].text).toBe("Error: something broke");
    expect(result.isError).toBe(true);
  });

  test("noUrl() builds a descriptive error", () => {
    const client = createFleetClient();
    const result = client.noUrl();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("VERS_INFRA_URL");
  });

  test("api() throws when VERS_INFRA_URL not set", async () => {
    delete process.env.VERS_INFRA_URL;
    const client = createFleetClient();
    await expect(client.api("GET", "/health")).rejects.toThrow("VERS_INFRA_URL not set");
  });
});

// =============================================================================
// filterClientModules
// =============================================================================

describe("filterClientModules", () => {
  test("includes modules with registerTools", () => {
    const modules: ServiceModule[] = [
      { name: "with-tools", registerTools: () => {} },
      { name: "no-client" },
    ];
    const filtered = filterClientModules(modules);
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("with-tools");
  });

  test("includes modules with registerBehaviors", () => {
    const modules: ServiceModule[] = [
      { name: "with-behaviors", registerBehaviors: () => {} },
    ];
    expect(filterClientModules(modules).length).toBe(1);
  });

  test("includes modules with widget", () => {
    const modules: ServiceModule[] = [
      { name: "with-widget", widget: { getLines: async () => [] } },
    ];
    expect(filterClientModules(modules).length).toBe(1);
  });

  test("excludes server-only modules", () => {
    const modules: ServiceModule[] = [
      { name: "server-only", description: "no client code" },
    ];
    expect(filterClientModules(modules)).toEqual([]);
  });

  test("handles empty array", () => {
    expect(filterClientModules([])).toEqual([]);
  });
});

// =============================================================================
// discoverServiceModules
// =============================================================================

const DISCOVER_DIR = join(import.meta.dir, ".tmp-discover");

describe("discoverServiceModules", () => {
  beforeEach(() => {
    rmSync(DISCOVER_DIR, { recursive: true, force: true });
    mkdirSync(DISCOVER_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(DISCOVER_DIR, { recursive: true, force: true });
  });

  test("discovers modules from directory", async () => {
    const dir = join(DISCOVER_DIR, "disco-svc");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "index.ts"),
      `export default { name: "disco-svc", description: "test" };`,
    );

    const modules = await discoverServiceModules(DISCOVER_DIR);
    expect(modules.length).toBe(1);
    expect(modules[0].name).toBe("disco-svc");
  });

  test("skips directories without index.ts", async () => {
    mkdirSync(join(DISCOVER_DIR, "no-index"));
    writeFileSync(join(DISCOVER_DIR, "no-index", "README.md"), "nothing");

    const dir = join(DISCOVER_DIR, "has-index");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "index.ts"),
      `export default { name: "has-index" };`,
    );

    const modules = await discoverServiceModules(DISCOVER_DIR);
    expect(modules.length).toBe(1);
    expect(modules[0].name).toBe("has-index");
  });

  test("skips files (non-directories)", async () => {
    writeFileSync(join(DISCOVER_DIR, "not-a-dir.ts"), "export default {}");

    const modules = await discoverServiceModules(DISCOVER_DIR);
    expect(modules.length).toBe(0);
  });

  test("topologically sorts by dependencies", async () => {
    const base = join(DISCOVER_DIR, "topo-base");
    mkdirSync(base);
    writeFileSync(
      join(base, "index.ts"),
      `export default { name: "topo-base" };`,
    );

    const dep = join(DISCOVER_DIR, "topo-dep");
    mkdirSync(dep);
    writeFileSync(
      join(dep, "index.ts"),
      `export default { name: "topo-dep", dependencies: ["topo-base"] };`,
    );

    const modules = await discoverServiceModules(DISCOVER_DIR);
    const names = modules.map((m) => m.name);
    expect(names.indexOf("topo-base")).toBeLessThan(names.indexOf("topo-dep"));
  });

  test("handles empty directory", async () => {
    const modules = await discoverServiceModules(DISCOVER_DIR);
    expect(modules).toEqual([]);
  });

  test("throws for nonexistent directory", async () => {
    await expect(
      discoverServiceModules("/nonexistent/path"),
    ).rejects.toThrow("not found");
  });

  test("survives bad modules", async () => {
    const good = join(DISCOVER_DIR, "surv-good");
    mkdirSync(good);
    writeFileSync(
      join(good, "index.ts"),
      `export default { name: "surv-good" };`,
    );

    const bad = join(DISCOVER_DIR, "surv-bad");
    mkdirSync(bad);
    writeFileSync(
      join(bad, "index.ts"),
      `throw new Error("boom");`,
    );

    const modules = await discoverServiceModules(DISCOVER_DIR);
    expect(modules.length).toBe(1);
    expect(modules[0].name).toBe("surv-good");
  });
});

// =============================================================================
// createExtension
// =============================================================================

describe("createExtension", () => {
  test("calls registerTools on each module", () => {
    const calls: string[] = [];
    const modules: ServiceModule[] = [
      {
        name: "ext-a",
        registerTools: (pi, client) => { calls.push(`a:${client.agentRole}`); },
      },
      {
        name: "ext-b",
        registerTools: (pi, client) => { calls.push(`b:${client.agentRole}`); },
      },
    ];

    const ext = createExtension(modules);
    const fakePi = mockPi();
    ext(fakePi);

    expect(calls).toContain("a:worker");
    expect(calls).toContain("b:worker");
  });

  test("calls registerBehaviors on each module", () => {
    const calls: string[] = [];
    const modules: ServiceModule[] = [
      {
        name: "ext-beh",
        registerBehaviors: () => { calls.push("behaviors"); },
      },
    ];

    const ext = createExtension(modules);
    ext(mockPi());

    expect(calls).toEqual(["behaviors"]);
  });

  test("registers session_start and session_shutdown handlers", () => {
    const events: string[] = [];
    const modules: ServiceModule[] = [];

    const ext = createExtension(modules);
    const fakePi = mockPi();
    fakePi._onCalls = (event: string) => events.push(event);
    ext(fakePi);

    expect(events).toContain("session_start");
    expect(events).toContain("session_shutdown");
  });

  test("handles modules with no client code", () => {
    const modules: ServiceModule[] = [
      { name: "server-only" },
    ];

    const ext = createExtension(modules);
    // Should not throw
    ext(mockPi());
  });
});

// =============================================================================
// Mock pi extension API
// =============================================================================

function mockPi(): any {
  const handlers: Record<string, Function> = {};
  return {
    _onCalls: (_event: string) => {},
    on(event: string, handler: Function) {
      handlers[event] = handler;
      (this as any)._onCalls(event);
    },
    registerTool() {},
    events: { on() {}, emit() {} },
    ui: { setWidget() {} },
  };
}
