import { describe, test, expect, afterAll } from "bun:test";
import { createTestHarness, type TestHarness } from "../../../src/core/testing.js";
import updater from "./index.js";

let t: TestHarness;
const setup = (async () => {
  t = await createTestHarness({ services: [updater] });
})();
afterAll(() => t?.cleanup());

describe("updater", () => {
  test("returns status", async () => {
    await setup;
    const { status, data } = await t.json<any>("/updater/status", { auth: true });
    expect(status).toBe(200);
    expect(data.package).toBe("@versdotsh/reef");
    expect(data.current).toBeDefined();
    expect(data.updateAvailable).toBe(false);
    expect(data.checking).toBe(false);
    expect(data.applying).toBe(false);
    expect(data.history).toEqual([]);
  });

  test("checks for updates from npm", async () => {
    await setup;
    const { status, data } = await t.json<any>("/updater/check", {
      method: "POST",
      auth: true,
    });
    expect(status).toBe(200);
    expect(data.current).toBeDefined();
    expect(data.latest).toBeDefined();
    expect(typeof data.updateAvailable).toBe("boolean");
  });

  test("apply when already up to date returns message", async () => {
    await setup;
    // After check, if versions match, apply should say "already up to date"
    const { data: checkData } = await t.json<any>("/updater/check", {
      method: "POST",
      auth: true,
    });

    // Only test the "already up to date" path — don't actually apply
    if (!checkData.updateAvailable) {
      const { status, data } = await t.json<any>("/updater/apply", {
        method: "POST",
        auth: true,
      });
      expect(status).toBe(200);
      expect(data.message).toContain("up to date");
    }
  });

  test("requires auth", async () => {
    await setup;
    const { status: s1 } = await t.json("/updater/status");
    expect(s1).toBe(401);
    const { status: s2 } = await t.json("/updater/check", { method: "POST" });
    expect(s2).toBe(401);
    const { status: s3 } = await t.json("/updater/apply", { method: "POST" });
    expect(s3).toBe(401);
  });
});
