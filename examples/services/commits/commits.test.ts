import { describe, test, expect, afterAll } from "bun:test";
import { createTestHarness, type TestHarness } from "../../../src/core/testing.js";
import commits from "./index.js";

let t: TestHarness;
const setup = (async () => {
  t = await createTestHarness({ services: [commits] });
})();
afterAll(() => t?.cleanup());

describe("commits", () => {
  test("records a commit", async () => {
    await setup;
    const { status, data } = await t.json("/commits", {
      method: "POST",
      auth: true,
      body: {
        commitId: "commit-abc",
        vmId: "vm-001",
        label: "golden-v1",
        agent: "coordinator",
      },
    });
    expect(status).toBe(201);
    expect(data.commitId).toBe("commit-abc");
    expect(data.vmId).toBe("vm-001");
  });

  test("lists commits", async () => {
    await setup;
    const { status, data } = await t.json<{ commits: any[]; count: number }>("/commits", {
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.commits.length).toBeGreaterThanOrEqual(1);
  });

  test("gets a commit by commitId", async () => {
    await setup;
    await t.json("/commits", {
      method: "POST",
      auth: true,
      body: { commitId: "commit-get", vmId: "vm-002", agent: "test" },
    });

    const { status, data } = await t.json("/commits/commit-get", { auth: true });
    expect(status).toBe(200);
    expect(data.commitId).toBe("commit-get");
  });

  test("deletes a commit by commitId", async () => {
    await setup;
    await t.json("/commits", {
      method: "POST",
      auth: true,
      body: { commitId: "commit-del", vmId: "vm-003", agent: "test" },
    });

    const { status } = await t.json("/commits/commit-del", {
      method: "DELETE",
      auth: true,
    });
    expect(status).toBe(200);

    const { status: getStatus } = await t.json("/commits/commit-del", { auth: true });
    expect(getStatus).toBe(404);
  });

  test("requires auth", async () => {
    await setup;
    const { status } = await t.json("/commits");
    expect(status).toBe(401);
  });
});
