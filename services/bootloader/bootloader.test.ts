import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestHarness, type TestHarness } from "../../src/core/testing.js";
import bootloader from "./index.js";

let t: TestHarness;

beforeEach(async () => {
  t = await createTestHarness({ services: [bootloader] });
});

afterEach(() => {
  t.cleanup();
});

describe("bootloader", () => {
  test("generate emits reef-only bootstrap for infra VMs", async () => {
    const res = await t.json<{ script: string; profile: { capabilities: string[]; services: string[] } }>(
      "/bootloader/generate",
      {
        method: "POST",
        auth: true,
        body: {
          vmId: "vm-test-1",
          name: "infra-alpha",
          type: "infra",
          extraServices: ["ui"],
        },
      },
    );

    expect(res.status).toBe(201);
    expect(res.data.profile.services).toContain("ui");
    expect(res.data.profile.capabilities).toEqual([]);
    expect(res.data.script).toContain("bun install");
    expect(res.data.script).toContain("nohup bun run src/main.ts");
    expect(res.data.script).toContain('category": "infra_vm"');
    expect(res.data.script).toContain('role": "infra"');
    expect(res.data.script).not.toContain("git clone https://github.com/hdresearch/pi-vers.git");
    expect(res.data.script).not.toContain("git clone https://github.com/hdresearch/punkin-pi.git");
    expect(res.data.script).not.toContain("install /root/pi-vers");
    expect(res.data.script).not.toContain("install /root/reef");
    expect(res.data.script).not.toContain("REEF_CHILD_AGENT=true");
  });
});
