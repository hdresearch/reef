# QR Code + Persistent Mobile Sessions

## Overview

This feature adds mobile access to the reef dashboard via QR codes, with persistent sessions that survive server restarts and last up to 30 days.

## Architecture

### QR Code Generation (Client-Side)

We use a **pure JavaScript QR code generator** (`static/qrcode.js`) with zero npm dependencies. The generator:

- Supports QR versions 1–10 (up to ~200 character URLs)
- Uses Reed-Solomon error correction (level M)
- Outputs SVG for crisp rendering at any size
- Runs entirely in the browser — no server-side image generation needed

**Why client-side?** The server generates the magic link URL (which needs auth context), but QR rendering is pure computation. Keeping it client-side means:
- No image library dependencies on the server
- No binary deps (canvas, sharp, etc.)
- Instant rendering, no round-trip

### Flow

```
Dashboard (authenticated) → POST /auth/qr-link → magic link URL
                          → QR.toSVG(url) → displayed in "mobile" tab
Phone scans QR → opens magic link URL (?mobile=1)
              → server creates persistent session (30 days)
              → redirects to /ui/?mobile=1
```

### Mobile Tab

The "mobile" tab is **always present** in the header — it's part of `index.html`, not a dynamically discovered service panel. This means:

- Available immediately on page load
- Works even if service discovery fails
- No service module needed — it's core UI

The tab shows:
- QR code (auto-refreshes every 4 minutes, 1 min before the 5-min link TTL)
- Countdown timer showing link expiry
- Info about session duration and reconnection behavior

### Persistent Sessions

Sessions are now persisted to `data/sessions.json` (same pattern as the key-value store service).

**Changes from the original in-memory system:**

| Aspect | Before | After |
|--------|--------|-------|
| Storage | In-memory Map | JSON file on disk |
| Server restart | Sessions lost | Sessions survive |
| Default TTL | 24 hours | 24 hours (unchanged) |
| Mobile TTL | N/A | 30 days |
| Auto-refresh | No | Yes — TTL extends on active use |
| Write strategy | N/A | Debounced (1s), avoids write storms |

**Session refresh logic:**
- On each `validateSession()` call, if `lastSeenAt` is >1 minute old, the session TTL is extended
- This means active users never get logged out unexpectedly
- Inactive sessions still expire at their original TTL

### Mobile Reconnection

Mobile browsers aggressively kill background connections. When a phone sleeps:

1. **SSE disconnects** — the `readSSE()` reader breaks, sets `sseConnected = false`, schedules reconnect in 3s
2. **On wake** — `visibilitychange` event fires, immediately attempts SSE reconnect
3. **On network restore** — `online` event fires, reconnects after 500ms delay
4. **QR refresh** — if the mobile panel is open and the QR expired during sleep, it auto-refreshes

### Security

- QR links use the same magic link system (one-time use, 5-min TTL)
- `POST /auth/qr-link` requires an authenticated session or bearer token — you can't generate QR codes without being logged in
- Mobile sessions get `HttpOnly; SameSite=Lax` cookies, same as regular sessions
- The `?mobile=1` parameter only affects session duration, not permissions

## Files Changed

| File | Change |
|------|--------|
| `services/ui/auth.ts` | Persistent sessions, auto-refresh, mobile TTL |
| `services/ui/routes.ts` | `POST /auth/qr-link` endpoint, mobile login flow |
| `services/ui/index.ts` | `init()` hook to load persisted sessions |
| `services/ui/static/index.html` | Mobile tab, QR panel HTML |
| `services/ui/static/style.css` | Mobile panel styles |
| `services/ui/static/app.js` | QR display, auto-refresh, reconnection handlers |
| `services/ui/static/qrcode.js` | Pure JS QR code SVG generator (new) |
| `docs/qr-session-design.md` | This document |
