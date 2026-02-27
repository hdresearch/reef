/**
 * Scaffold service tests.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createTestHarness, type TestHarness } from "../../../src/core/testing.js";
import scaffold from "./index.js";

// We need the services manager loaded too, since scaffold calls ctx.loadModule
import services from "../../../services/services/index.js";

let t: TestHarness;
const AUTH = "test-token";

const setup = (async () => {
  t = await createTestHarness({ services: [services, scaffold] });
})();

afterAll(() => t?.cleanup());

describe("scaffold service", () => {
  // ===========================================================================
  // Validation
  // ===========================================================================

  test("rejects missing name", async () => {
    await setup;
    const { status, data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: { description: "no name" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("name");
  });

  test("rejects reserved names", async () => {
    await setup;
    const { status, data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: { name: "scaffold" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("reserved");
  });

  test("rejects short names", async () => {
    await setup;
    const { status, data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: { name: "x" },
    });
    expect(status).toBe(400);
    expect(data.error).toContain("2 characters");
  });

  test("requires auth", async () => {
    await setup;
    const { status } = await t.json("/scaffold/preview", {
      method: "POST",
      body: { name: "test-svc" },
    });
    expect(status).toBe(401);
  });

  // ===========================================================================
  // Preview
  // ===========================================================================

  test("preview generates minimal skeleton", async () => {
    await setup;
    const { status, data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: { name: "minimal" },
    });

    expect(status).toBe(200);
    expect(data.name).toBe("minimal");
    // At minimum: index.ts + test
    expect(data.count).toBeGreaterThanOrEqual(2);

    const index = data.files.find((f: any) => f.path === "minimal/index.ts");
    expect(index).toBeDefined();
    expect(index.content).toContain("ServiceModule");
    expect(index.content).toContain('name: "minimal"');
    expect(index.content).toContain("export default");
  });

  test("preview with store generates store.ts", async () => {
    await setup;
    const { data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: { name: "with-store", store: true },
    });

    const store = data.files.find((f: any) => f.path === "with-store/store.ts");
    expect(store).toBeDefined();
    expect(store.content).toContain("class WithStoreStore");
    expect(store.content).toContain("scheduleSave");
    expect(store.content).toContain("flush()");
  });

  test("preview with routes generates routes.ts", async () => {
    await setup;
    const { data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: {
        name: "with-routes",
        routes: [
          { method: "POST", path: "/items", description: "Create an item" },
          { method: "GET", path: "/items", description: "List items" },
        ],
      },
    });

    const routesFile = data.files.find((f: any) => f.path === "with-routes/routes.ts");
    expect(routesFile).toBeDefined();
    expect(routesFile.content).toContain("routes.post");
    expect(routesFile.content).toContain("routes.get");
    expect(routesFile.content).toContain("Hono");
  });

  test("preview with tools generates tools.ts", async () => {
    await setup;
    const { data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: {
        name: "with-tools",
        tools: true,
        routes: [
          { method: "POST", path: "/record", description: "Record a metric" },
        ],
      },
    });

    const tools = data.files.find((f: any) => f.path === "with-tools/tools.ts");
    expect(tools).toBeDefined();
    expect(tools.content).toContain("registerTools");
    expect(tools.content).toContain("pi.registerTool");
    expect(tools.content).toContain("Type.Object");
    expect(tools.content).toContain("FleetClient");
  });

  test("preview with behaviors generates behaviors.ts", async () => {
    await setup;
    const { data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: { name: "with-behaviors", behaviors: true },
    });

    const beh = data.files.find((f: any) => f.path === "with-behaviors/behaviors.ts");
    expect(beh).toBeDefined();
    expect(beh.content).toContain("registerBehaviors");
    expect(beh.content).toContain("session_start");
    expect(beh.content).toContain("session_shutdown");
  });

  test("preview with panel injects panel HTML", async () => {
    await setup;
    const { data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: {
        name: "with-panel",
        panel: true,
        routes: [{ method: "GET", path: "/", description: "List items" }],
      },
    });

    const index = data.files.find((f: any) => f.path === "with-panel/index.ts");
    expect(index.content).toContain("PANEL_API");
    expect(index.content).toContain("_panel");
    expect(index.content).toContain("panel-with-panel");
  });

  test("preview generates test file", async () => {
    await setup;
    const { data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: {
        name: "with-test",
        routes: [{ method: "GET", path: "/items" }],
      },
    });

    const testFile = data.files.find((f: any) => f.path === "with-test/with-test.test.ts");
    expect(testFile).toBeDefined();
    expect(testFile.content).toContain("createTestHarness");
    expect(testFile.content).toContain("describe");
    expect(testFile.content).toContain("requires auth");
  });

  test("preview with full spec generates all files", async () => {
    await setup;
    const { data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: {
        name: "full-service",
        description: "A fully loaded service",
        store: true,
        tools: true,
        behaviors: true,
        panel: true,
        dependencies: ["board"],
        capabilities: ["reef.custom"],
        routes: [
          {
            method: "POST",
            path: "/items",
            description: "Create an item",
            body: {
              title: { type: "string", required: true, description: "Item title" },
              priority: { type: "number", required: false, description: "Priority level" },
            },
            response: "{ id, title, priority, createdAt }",
          },
          { method: "GET", path: "/items", description: "List all items" },
          { method: "GET", path: "/items/:id", description: "Get item by ID" },
        ],
      },
    });

    const paths = data.files.map((f: any) => f.path);
    expect(paths).toContain("full-service/index.ts");
    expect(paths).toContain("full-service/store.ts");
    expect(paths).toContain("full-service/routes.ts");
    expect(paths).toContain("full-service/tools.ts");
    expect(paths).toContain("full-service/behaviors.ts");
    expect(paths).toContain("full-service/full-service.test.ts");
    expect(data.count).toBe(6);

    // Check index has everything wired
    const index = data.files.find((f: any) => f.path === "full-service/index.ts");
    expect(index.content).toContain("FullServiceStore");
    expect(index.content).toContain("createRoutes");
    expect(index.content).toContain("registerTools");
    expect(index.content).toContain("registerBehaviors");
    expect(index.content).toContain('"board"');
    expect(index.content).toContain('"reef.custom"');
    expect(index.content).toContain("A fully loaded service");

    // Check routeDocs are generated
    expect(index.content).toContain("routeDocs");
    expect(index.content).toContain("Create an item");
    expect(index.content).toContain("Item title");
  });

  test("preview normalizes name to lowercase with hyphens", async () => {
    await setup;
    const { data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: { name: "My Cool Service" },
    });
    expect(data.name).toBe("my-cool-service");
  });

  // ===========================================================================
  // Create
  // ===========================================================================

  test("create writes files to services directory", async () => {
    await setup;
    const { status, data } = await t.json("/scaffold/create", {
      method: "POST",
      auth: true,
      body: {
        name: "scaff-created",
        description: "Test created service",
        store: true,
        routes: [
          { method: "GET", path: "/items", description: "List items" },
        ],
        load: false, // Don't try to hot-load in test
      },
    });

    expect(status).toBe(201);
    expect(data.name).toBe("scaff-created");
    expect(data.files).toContain("scaff-created/index.ts");
    expect(data.files).toContain("scaff-created/store.ts");
    expect(data.files).toContain("scaff-created/routes.ts");

    // Verify files exist on disk
    const indexPath = join(t.dataDir, "_empty_services", "scaff-created", "index.ts");
    expect(existsSync(indexPath)).toBe(true);

    const content = readFileSync(indexPath, "utf-8");
    expect(content).toContain('name: "scaff-created"');
    expect(content).toContain("Test created service");
  });

  test("create rejects duplicate service directory", async () => {
    await setup;
    // First create
    await t.json("/scaffold/create", {
      method: "POST",
      auth: true,
      body: { name: "scaff-dupe", load: false },
    });

    // Second create — should fail
    const { status, data } = await t.json("/scaffold/create", {
      method: "POST",
      auth: true,
      body: { name: "scaff-dupe", load: false },
    });
    expect(status).toBe(409);
    expect(data.error).toContain("already exists");
  });

  // ===========================================================================
  // Generated code quality
  // ===========================================================================

  test("generated store has correct class name", async () => {
    await setup;
    const { data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: { name: "agent-metrics", store: true },
    });

    const store = data.files.find((f: any) => f.path === "agent-metrics/store.ts");
    expect(store.content).toContain("class AgentMetricsStore");
    expect(store.content).toContain('filePath = "data/agent-metrics.json"');
  });

  test("generated routes import store when present", async () => {
    await setup;
    const { data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: {
        name: "routes-store",
        store: true,
        routes: [{ method: "GET", path: "/" }],
      },
    });

    const routesFile = data.files.find((f: any) => f.path === "routes-store/routes.ts");
    expect(routesFile.content).toContain("RoutesStoreStore");
    expect(routesFile.content).toContain("store: RoutesStoreStore");
  });

  test("generated routes skip store import when not present", async () => {
    await setup;
    const { data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: {
        name: "routes-nostore",
        routes: [{ method: "GET", path: "/" }],
      },
    });

    const routesFile = data.files.find((f: any) => f.path === "routes-nostore/routes.ts");
    expect(routesFile.content).not.toContain("import type");
    expect(routesFile.content).toContain("createRoutes()");
  });

  test("generated tools have correct tool names", async () => {
    await setup;
    const { data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: {
        name: "metrics",
        tools: true,
        routes: [
          { method: "POST", path: "/record", description: "Record a metric" },
          { method: "GET", path: "/query", description: "Query metrics" },
        ],
      },
    });

    const tools = data.files.find((f: any) => f.path === "metrics/tools.ts");
    expect(tools.content).toContain("metrics_post_record");
    expect(tools.content).toContain("metrics_get_query");
  });

  test("generated index wires requiresAuth: false", async () => {
    await setup;
    const { data } = await t.json("/scaffold/preview", {
      method: "POST",
      auth: true,
      body: { name: "public-svc", requiresAuth: false },
    });

    const index = data.files.find((f: any) => f.path === "public-svc/index.ts");
    expect(index.content).toContain("requiresAuth: false");
  });
});
