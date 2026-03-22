import { describe, expect, test } from "bun:test";
import {
  consumeMagicLink,
  createMagicLink,
  createQrLink,
  createSession,
  getSessionInfo,
  validateSession,
} from "./auth.js";

describe("auth", () => {
  describe("magic links", () => {
    test("createMagicLink returns token and expiresAt", () => {
      const link = createMagicLink();
      expect(link.token).toBeTruthy();
      expect(link.expiresAt).toBeTruthy();
      expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    test("consumeMagicLink returns true for valid token", () => {
      const link = createMagicLink();
      expect(consumeMagicLink(link.token)).toBe(true);
    });

    test("consumeMagicLink returns false for reused token", () => {
      const link = createMagicLink();
      consumeMagicLink(link.token);
      expect(consumeMagicLink(link.token)).toBe(false);
    });

    test("consumeMagicLink returns false for unknown token", () => {
      expect(consumeMagicLink("nonexistent-token")).toBe(false);
    });
  });

  describe("QR link", () => {
    test("createQrLink returns a valid magic link", () => {
      const link = createQrLink();
      expect(link.token).toBeTruthy();
      expect(link.expiresAt).toBeTruthy();
      expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    test("QR link token is consumable as a magic link", () => {
      const link = createQrLink();
      expect(consumeMagicLink(link.token)).toBe(true);
    });

    test("QR link token can only be used once", () => {
      const link = createQrLink();
      consumeMagicLink(link.token);
      expect(consumeMagicLink(link.token)).toBe(false);
    });
  });

  describe("sessions", () => {
    test("createSession returns valid session", () => {
      const session = createSession();
      expect(session.id).toBeTruthy();
      expect(session.createdAt).toBeTruthy();
      expect(session.expiresAt).toBeTruthy();
    });

    test("validateSession returns true for valid session", () => {
      const session = createSession();
      expect(validateSession(session.id)).toBe(true);
    });

    test("validateSession returns false for unknown session", () => {
      expect(validateSession("nonexistent")).toBe(false);
    });

    test("validateSession returns false for undefined", () => {
      expect(validateSession(undefined)).toBe(false);
    });

    test("getSessionInfo returns info for valid session", () => {
      const session = createSession();
      const info = getSessionInfo(session.id);
      expect(info).not.toBeNull();
      expect(info!.expiresAt).toBe(session.expiresAt);
      expect(info!.daysLeft).toBeGreaterThan(0);
    });

    test("getSessionInfo returns null for unknown session", () => {
      expect(getSessionInfo("nonexistent")).toBeNull();
    });
  });

  describe("full QR flow", () => {
    test("QR link → consume → session → validate", () => {
      // 1. Generate QR link (same as magic link)
      const link = createQrLink();
      expect(link.token).toBeTruthy();

      // 2. Consume the link (simulates user scanning QR and hitting /ui/login)
      const valid = consumeMagicLink(link.token);
      expect(valid).toBe(true);

      // 3. Create session (what happens after successful login)
      const session = createSession();
      expect(session.id).toBeTruthy();

      // 4. Validate the session (what happens on subsequent requests)
      expect(validateSession(session.id)).toBe(true);

      // 5. Session info should show 30-day expiry
      const info = getSessionInfo(session.id);
      expect(info).not.toBeNull();
      expect(info!.daysLeft).toBe(30);
    });
  });
});
