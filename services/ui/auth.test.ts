import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createMagicLink, consumeMagicLink, getMagicLinkTTL, createSession, validateSession, getSessionMaxAge, initAuth } from "./auth.js";
import { unlinkSync, mkdirSync } from "node:fs";

describe("magic links", () => {
  test("create and consume", () => {
    const link = createMagicLink();
    expect(link.token).toBeTruthy();
    expect(link.expiresAt).toBeTruthy();
    expect(consumeMagicLink(link.token)).toBe(true);
    // Second consume fails (one-time use)
    expect(consumeMagicLink(link.token)).toBe(false);
  });

  test("invalid token returns false", () => {
    expect(consumeMagicLink("nonexistent")).toBe(false);
  });

  test("getMagicLinkTTL returns positive for valid link", () => {
    const link = createMagicLink();
    const ttl = getMagicLinkTTL(link.token);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5 * 60 * 1000);
    // Clean up
    consumeMagicLink(link.token);
  });

  test("getMagicLinkTTL returns -1 for unknown token", () => {
    expect(getMagicLinkTTL("bogus")).toBe(-1);
  });
});

describe("sessions", () => {
  beforeEach(async () => {
    try { mkdirSync("data", { recursive: true }); } catch {}
    await initAuth();
  });

  test("create and validate normal session", () => {
    const session = createSession();
    expect(session.id).toBeTruthy();
    expect(session.persistent).toBe(false);
    expect(validateSession(session.id)).toBe(true);
  });

  test("create persistent (mobile) session", () => {
    const session = createSession({ persistent: true, userAgent: "iPhone" });
    expect(session.persistent).toBe(true);
    expect(validateSession(session.id)).toBe(true);
  });

  test("getSessionMaxAge returns correct values", () => {
    const normal = createSession();
    const persistent = createSession({ persistent: true });
    expect(getSessionMaxAge(normal.id)).toBe(86400); // 24hr
    expect(getSessionMaxAge(persistent.id)).toBe(30 * 24 * 3600); // 30 days
  });

  test("validateSession returns false for unknown session", () => {
    expect(validateSession("nonexistent")).toBe(false);
  });

  test("validateSession returns false for undefined", () => {
    expect(validateSession(undefined)).toBe(false);
  });

  test("session stores userAgent", () => {
    const session = createSession({ userAgent: "Mozilla/5.0 Test" });
    expect(session.userAgent).toBe("Mozilla/5.0 Test");
  });
});

describe("session persistence", () => {
  const SESSIONS_PATH = "data/sessions.json";

  afterEach(() => {
    try { unlinkSync(SESSIONS_PATH); } catch {}
  });

  test("sessions file is created after save", async () => {
    createSession({ persistent: true });
    // Wait for debounced save
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const file = Bun.file(SESSIONS_PATH);
    expect(await file.exists()).toBe(true);
    const data = await file.json();
    expect(Object.keys(data).length).toBeGreaterThan(0);
  });
});
