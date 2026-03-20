import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestHarness, type TestHarness } from "../../src/core/testing.js";
import { createCommitsService } from "./index.js";

let t: TestHarness;

beforeEach(async () => {
  t = await createTestHarness({
    services: [
      createCommitsService({
        ensureGolden: async () => ({
          commitId: "golden-commit-123",
          vmId: "vm-golden-1",
          label: "reef-child-golden",
          created: true,
          source: "created",
        }),
      }),
    ],
  });
});

afterEach(() => {
  delete process.env.VERS_GOLDEN_COMMIT_ID;
  delete process.env.VERS_COMMIT_ID;
  t.cleanup();
});

describe("commits", () => {
  test("returns current golden from env when present", async () => {
    process.env.VERS_GOLDEN_COMMIT_ID = "env-golden-1";
    const res = await t.json<{ commitId: string; source: string }>("/commits/current/golden", { auth: true });

    expect(res.status).toBe(200);
    expect(res.data.commitId).toBe("env-golden-1");
    expect(res.data.source).toBe("env");
  });

  test("ensure-golden returns the ensured golden record", async () => {
    const res = await t.json<{ commitId: string; created: boolean; source: string }>("/commits/ensure-golden", {
      method: "POST",
      auth: true,
      body: {},
    });

    expect(res.status).toBe(201);
    expect(res.data.commitId).toBe("golden-commit-123");
    expect(res.data.created).toBe(true);
    expect(res.data.source).toBe("created");
  });
});
