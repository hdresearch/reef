/**
 * Magic link auth for the web UI.
 *
 * Flow: agent generates a magic link via POST /auth/magic-link (bearer auth),
 * user opens it in browser, gets a session cookie, UI proxies API calls.
 *
 * Sessions persist to data/sessions.json so they survive restarts.
 * Sessions are valid for 30 days.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

interface MagicLink {
  token: string;
  expiresAt: string;
}

interface Session {
  id: string;
  createdAt: string;
  expiresAt: string;
}

const magicLinks = new Map<string, MagicLink>();
const sessions = new Map<string, Session>();

const LINK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const SESSIONS_PATH = "data/sessions.json";

function loadSessions(): void {
  try {
    if (existsSync(SESSIONS_PATH)) {
      const data = JSON.parse(readFileSync(SESSIONS_PATH, "utf-8"));
      const now = Date.now();
      for (const session of data.sessions || []) {
        if (new Date(session.expiresAt).getTime() > now) {
          sessions.set(session.id, session);
        }
      }
    }
  } catch {}
}

function saveSessions(): void {
  try {
    if (!existsSync("data")) mkdirSync("data", { recursive: true });
    const list = [...sessions.values()].filter((s) => new Date(s.expiresAt).getTime() > Date.now());
    writeFileSync(SESSIONS_PATH, JSON.stringify({ sessions: list }, null, 2));
  } catch {}
}

// Load persisted sessions on module init
loadSessions();

export function createMagicLink(): MagicLink {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
  const link: MagicLink = { token, expiresAt };
  magicLinks.set(token, link);
  return link;
}

export function consumeMagicLink(token: string): boolean {
  const link = magicLinks.get(token);
  if (!link) return false;
  magicLinks.delete(token);
  return new Date(link.expiresAt).getTime() > Date.now();
}

export function createSession(): Session {
  const session: Session = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  sessions.set(session.id, session);
  saveSessions();
  return session;
}

export function validateSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    sessions.delete(sessionId);
    saveSessions();
    return false;
  }
  return true;
}

export function createQrLink(): MagicLink {
  return createMagicLink();
}

export function getSessionInfo(sessionId: string | undefined): { expiresAt: string; daysLeft: number } | null {
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  const msLeft = new Date(session.expiresAt).getTime() - Date.now();
  if (msLeft <= 0) return null;
  return {
    expiresAt: session.expiresAt,
    daysLeft: Math.ceil(msLeft / (24 * 60 * 60 * 1000)),
  };
}
