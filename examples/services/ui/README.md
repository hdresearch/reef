# ui

Web dashboard with magic link auth, dynamic panel discovery, and chat interface. Mounts at root — serves `/ui/*` and `/auth/*`.

The UI discovers panels from other services at runtime. Any service that serves `GET /_panel` gets a tab in the dashboard. The chat tab connects to the agent service via SSE for streaming conversations with pi.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/magic-link` | Generate a one-time login URL |
| `GET` | `/ui/login` | Magic link landing page (sets session cookie) |
| `GET` | `/ui/` | Dashboard shell |
| `GET` | `/ui/static/:file` | Static assets (JS, CSS) |
| `ALL` | `/ui/api/*` | Auth proxy — injects bearer token so the browser never needs it |

## How it works

1. **Auth**: `POST /auth/magic-link` with bearer token → returns a URL. Opening it sets a 24h session cookie.
2. **Panel discovery**: The dashboard polls `GET /services` every 30s, fetches `GET /<service>/_panel` for each, and injects the HTML as tabs.
3. **Chat**: Creates a pi RPC session via the agent service, streams responses via SSE, renders markdown with collapsible tool calls.
4. **API proxy**: All requests to `/ui/api/*` are forwarded with the bearer token from the session, so panel scripts and chat can call any service endpoint without exposing the token to the browser.
