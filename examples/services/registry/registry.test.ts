import { afterAll, describe, expect, test } from "bun:test";
import { createTestHarness, type TestHarness } from "../../../src/core/testing.js";
import registry from "./index.js";

let t: TestHarness;
const setup = (async () => {
  t = await createTestHarness({ services: [registry] });
})();
afterAll(() => t?.cleanup());

describe("registry", () => {
  test("registers a VM", async () => {
    await setup;
    const { status, data } = await t.json("/registry/vms", {
      method: "POST",
      auth: true,
      body: {
        id: "vm-001",
        name: "worker-1",
        role: "worker",
        address: "vm-001.vm.vers.sh",
        registeredBy: "coordinator",
      },
    });
    expect(status).toBe(201);
    expect(data.id).toBe("vm-001");
    expect(data.name).toBe("worker-1");
    expect(data.status).toBe("running");
  });

  test("lists VMs", async () => {
    await setup;
    const { status, data } = await t.json<{ vms: any[]; count: number }>("/registry/vms", {
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.vms.length).toBeGreaterThanOrEqual(1);
    expect(data.count).toBe(data.vms.length);
  });

  test("gets a VM by id", async () => {
    await setup;
    const { status, data } = await t.json("/registry/vms/vm-001", { auth: true });
    expect(status).toBe(200);
    expect(data.name).toBe("worker-1");
  });

  test("filters by role", async () => {
    await setup;
    await t.json("/registry/vms", {
      method: "POST",
      auth: true,
      body: { id: "vm-lt", name: "lt-1", role: "lieutenant", address: "lt.vm", registeredBy: "test" },
    });

    const { data } = await t.json<{ vms: any[] }>("/registry/vms?role=lieutenant", { auth: true });
    for (const vm of data.vms) {
      expect(vm.role).toBe("lieutenant");
    }
  });

  test("filters by status", async () => {
    await setup;
    const { data } = await t.json<{ vms: any[] }>("/registry/vms?status=running", { auth: true });
    for (const vm of data.vms) {
      expect(vm.status).toBe("running");
    }
  });

  test("updates a VM", async () => {
    await setup;
    const { status, data } = await t.json("/registry/vms/vm-001", {
      method: "PATCH",
      auth: true,
      body: { status: "paused", name: "worker-1-updated" },
    });
    expect(status).toBe(200);
    expect(data.status).toBe("paused");
    expect(data.name).toBe("worker-1-updated");
  });

  test("heartbeat updates lastSeen", async () => {
    await setup;
    const { status, data } = await t.json("/registry/vms/vm-001/heartbeat", {
      method: "POST",
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.lastSeen).toBeDefined();
  });

  test("discovers by role", async () => {
    await setup;
    // Reset vm-001 to running for discover
    await t.json("/registry/vms/vm-001", {
      method: "PATCH",
      auth: true,
      body: { status: "running" },
    });

    const { status, data } = await t.json<{ vms: any[] }>("/registry/discover/worker", { auth: true });
    expect(status).toBe(200);
    expect(data.vms.length).toBeGreaterThanOrEqual(1);
  });

  test("deletes a VM", async () => {
    await setup;
    await t.json("/registry/vms", {
      method: "POST",
      auth: true,
      body: { id: "vm-delete-me", name: "delete", role: "worker", address: "x", registeredBy: "test" },
    });

    const { status } = await t.json("/registry/vms/vm-delete-me", {
      method: "DELETE",
      auth: true,
    });
    expect(status).toBe(200);

    const { status: getStatus } = await t.json("/registry/vms/vm-delete-me", { auth: true });
    expect(getStatus).toBe(404);
  });

  test("returns 404 for missing VM", async () => {
    await setup;
    const { status } = await t.json("/registry/vms/nonexistent", { auth: true });
    expect(status).toBe(404);
  });

  test("requires auth", async () => {
    await setup;
    const { status } = await t.json("/registry/vms");
    expect(status).toBe(401);
  });
});
