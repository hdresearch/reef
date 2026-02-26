/**
 * Magic link auth for the web UI.
 *
 * Flow: agent generates a magic link via POST /auth/magic-link (bearer auth),
 * user opens it in browser, gets a session cookie, UI proxies API calls.
 */

import { ulid } from "ulid";

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
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function createMagicLink(): MagicLink {
  const token = ulid();
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
    id: ulid(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  sessions.set(session.id, session);
  return session;
}

export function validateSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}
