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
  test("generate emits punkin-backed harness registration for full VMs", async () => {
    const res = await t.json<{ script: string; profile: { capabilities: string[] } }>("/bootloader/generate", {
      method: "POST",
      auth: true,
      body: {
        vmId: "vm-test-1",
        name: "lt-alpha",
        type: "full",
        parentVmId: "vm-root-1",
      },
    });

    expect(res.status).toBe(201);
    expect(res.data.profile.capabilities).toContain("punkin");
    expect(res.data.script).toContain("PUNKIN_BIN=punkin");
    expect(res.data.script).toContain("PI_PATH=punkin");
    expect(res.data.script).toContain('"$PI_PATH" install /root/reef');
    expect(res.data.script).toContain('"$PI_PATH" install /root/pi-vers');
    expect(res.data.script).toContain("ln -sf /usr/local/bin/punkin /usr/local/bin/pi");
    expect(res.data.script).toContain("Child agent VM configured to use the root reef");
    expect(res.data.script).not.toContain("systemctl start reef");
  });

  test("generate emits punkin v1rc3 bootstrap for swarm VMs", async () => {
    const res = await t.json<{ script: string; profile: { capabilities: string[] } }>("/bootloader/generate", {
      method: "POST",
      auth: true,
      body: {
        vmId: "vm-test-2",
        name: "swarm-alpha",
        type: "swarm",
        parentVmId: "vm-lt-1",
      },
    });

    expect(res.status).toBe(201);
    expect(res.data.profile.capabilities).toContain("punkin");
    expect(res.data.script).toContain("git checkout v1rc3");
    expect(res.data.script).toContain("PUNKIN_BIN=punkin");
    expect(res.data.script).toContain("PI_PATH=punkin");
    expect(res.data.script).toContain('"$PI_PATH" install /root/reef');
    expect(res.data.script).toContain('"$PI_PATH" install /root/pi-vers');
    expect(res.data.script).toContain("ln -sf /usr/local/bin/punkin /usr/local/bin/pi");
    expect(res.data.script).toContain("Child agent VM configured to use the root reef");
    expect(res.data.script).not.toContain("systemctl start reef");
  });
});
