import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("github service", () => {
  it("fetches the requested base branch into the matching remote-tracking ref before checkout", () => {
    const source = readFileSync(new URL("../services/github/index.ts", import.meta.url), "utf8");

    const fetchIndex = source.indexOf("git fetch origin ${sh(branchFetchRefspec)}");
    const verifyIndex = source.indexOf("git rev-parse --verify ${sh(remoteTrackingRef)}");
    const checkoutIndex = source.indexOf("git checkout -B ${sh(baseBranch)} origin/${baseBranch}");

    expect(fetchIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(fetchIndex);
    expect(checkoutIndex).toBeGreaterThan(verifyIndex);
  });
});
