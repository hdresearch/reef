/**
 * Magic link auth for the web UI — now with persistent sessions.
 *
 * Flow: agent generates a magic link via POST /auth/magic-link (bearer auth),
 * user opens it in browser, gets a session cookie, UI proxies API calls.
 *
 * Sessions are persisted to disk (data/sessions.json) so they survive restarts.
 * Mobile "remember me" sessions last 30 days; normal sessions last 24 hours.
 * Active sessions auto-extend their TTL on each validation.
 */

import { randomUUID } from "node:crypto";

interface MagicLink {
  token: string;
  expiresAt: string;
}

interface Session {
  id: string;
  createdAt: string;
  expiresAt: string;
  persistent: boolean; // "remember this device" — 30 day TTL
  lastSeenAt: string;
  userAgent?: string;
}

// Magic links stay in-memory (ephemeral by design, 5min TTL)
const magicLinks = new Map<string, MagicLink>();

// Sessions are disk-backed
let sessions = new Map<string, Session>();
let sessionsLoaded = false;

const LINK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PERSISTENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_REFRESH_THRESHOLD_MS = 60 * 1000; // refresh if last seen > 1 min ago

const SESSIONS_PATH = "data/sessions.json";

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

async function ensureDataDir() {
  const { mkdirSync } = await import("node:fs");
  try {
    mkdirSync("data", { recursive: true });
  } catch {}
}

async function loadSessions() {
  if (sessionsLoaded) return;
  try {
    await ensureDataDir();
    const file = Bun.file(SESSIONS_PATH);
    if (await file.exists()) {
      const data: Record<string, Session> = await file.json();
      sessions = new Map(Object.entries(data));
      // Prune expired on load
      const now = Date.now();
      for (const [id, session] of sessions) {
        if (new Date(session.expiresAt).getTime() < now) {
          sessions.delete(id);
        }
      }
    }
  } catch {
    sessions = new Map();
  }
  sessionsLoaded = true;
}

let saveQueued = false;
function scheduleSave() {
  if (saveQueued) return;
  saveQueued = true;
  // Debounce writes — at most once per second
  setTimeout(async () => {
    saveQueued = false;
    await saveSessions();
  }, 1000);
}

async function saveSessions() {
  try {
    await ensureDataDir();
    const obj: Record<string, Session> = {};
    for (const [id, session] of sessions) obj[id] = session;
    await Bun.write(SESSIONS_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("[auth] Failed to save sessions:", e);
  }
}

// ---------------------------------------------------------------------------
// Magic links (ephemeral, in-memory)
// ---------------------------------------------------------------------------

export function createMagicLink(): MagicLink {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
  const link: MagicLink = { token, expiresAt };
  magicLinks.set(token, link);
  return link;
}

/** Returns remaining TTL in ms, or -1 if not found/expired */
export function getMagicLinkTTL(token: string): number {
  const link = magicLinks.get(token);
  if (!link) return -1;
  const remaining = new Date(link.expiresAt).getTime() - Date.now();
  return remaining > 0 ? remaining : -1;
}

export function consumeMagicLink(token: string): boolean {
  const link = magicLinks.get(token);
  if (!link) return false;
  magicLinks.delete(token);
  return new Date(link.expiresAt).getTime() > Date.now();
}

// ---------------------------------------------------------------------------
// Sessions (persistent, disk-backed)
// ---------------------------------------------------------------------------

export interface CreateSessionOpts {
  persistent?: boolean;
  userAgent?: string;
}

export function createSession(opts: CreateSessionOpts = {}): Session {
  const ttl = opts.persistent ? PERSISTENT_SESSION_TTL_MS : SESSION_TTL_MS;
  const now = new Date();
  const session: Session = {
    id: randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    persistent: !!opts.persistent,
    lastSeenAt: now.toISOString(),
    userAgent: opts.userAgent,
  };
  sessions.set(session.id, session);
  scheduleSave();
  return session;
}

export function validateSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const session = sessions.get(sessionId);
  if (!session) return false;

  const now = Date.now();
  if (new Date(session.expiresAt).getTime() < now) {
    sessions.delete(sessionId);
    scheduleSave();
    return false;
  }

  // Auto-extend: refresh TTL on active use
  const lastSeen = new Date(session.lastSeenAt).getTime();
  if (now - lastSeen > SESSION_REFRESH_THRESHOLD_MS) {
    session.lastSeenAt = new Date(now).toISOString();
    const ttl = session.persistent ? PERSISTENT_SESSION_TTL_MS : SESSION_TTL_MS;
    session.expiresAt = new Date(now + ttl).toISOString();
    scheduleSave();
  }

  return true;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function getSessionMaxAge(sessionId: string): number {
  const session = sessions.get(sessionId);
  if (!session) return 86400; // default 24hr
  return session.persistent ? 30 * 24 * 3600 : 86400;
}

// ---------------------------------------------------------------------------
// Init — call on server startup to load persisted sessions
// ---------------------------------------------------------------------------

export async function initAuth() {
  await loadSessions();
}
