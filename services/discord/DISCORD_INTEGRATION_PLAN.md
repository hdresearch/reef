# Discord Integration Plan — Official Vers Bot

## Current State

- Reef has a `services/discord/` module with outbound messaging (send, list channels/guilds, status)
- Token is resolved from `DISCORD_BOT_TOKEN` env var → `vers-config` store fallback
- Works with user-provided (BYO) bot tokens today

## Goal

A single official Vers Discord bot shared across all reef instances. Users add the bot to their server via an invite link. Reef instances use the bot automatically — no token pasting.

## Token Delivery Options

### Option A: Inject at provision time (recommended)

The Vers platform already injects `VERS_API_KEY` and `LLM_PROXY_KEY` into `/opt/reef/.env` during provisioning. Add `DISCORD_BOT_TOKEN` to the same flow.

- **Where the token lives:** Vers platform backend (same place that stores the Vers API keys)
- **How it gets to reef:** `vers-fleets` `buildRuntimeEnv()` injects it into `.env` alongside other secrets
- **Rotation:** Update the token in the Vers backend, next provision picks it up. Running instances need a reprovision or manual env update.
- **Pros:** Simplest. No new API endpoints. Matches existing pattern.
- **Cons:** Running instances don't pick up token changes without restart/reprovision.

Changes needed:
- `vers-fleets/src/boot.js` — add `DISCORD_BOT_TOKEN` to `buildRuntimeEnv()`
- Vers platform backend — store the bot token, include it in provision payloads
- Reef `services/discord/` — already reads from env, no change needed

### Option B: Fetch from Vers API at startup

Reef calls `vers.sh/api/v1/integrations/discord` at boot to fetch the bot token. Token is cached in memory.

- **Where the token lives:** Vers platform backend
- **How it gets to reef:** HTTP call during reef startup or on first Discord API call
- **Rotation:** Vers updates the token, reef picks it up on next restart or cache expiry
- **Pros:** Centralized control. Can revoke/rotate without reprovisioning.
- **Cons:** New API endpoint. Startup dependency on Vers API availability. More complexity for a static token.

### Option C: Bundled in golden image (not recommended)

Bake the token into the golden commit image.

- **Cons:** Token in a snapshot that could be made public. Can't rotate without rebuilding the image. Violates the "no secrets in images" principle that reef follows for all other credentials.

## Recommendation

**Option A** for now. It's the smallest change and matches how every other secret gets to reef. If token rotation becomes a real need, upgrade to Option B later.

## User Flow

1. User goes to `vers.sh/discord` (or a link in the reef UI)
2. Clicks "Add Vers Bot to your server" — standard Discord OAuth2 invite flow
3. Selects their server, grants permissions
4. Bot joins the server
5. User provisions a reef (or already has one) — `DISCORD_BOT_TOKEN` is in `.env` automatically
6. User tells reef agent: "post to #general on my discord" — works immediately

## Bot Permissions Needed

- `Send Messages` — post to channels
- `Read Message History` — context for conversations (future)
- `View Channels` — list channels/guilds

## Open Questions

- Who owns the Discord application? (Josh's account → transfer to Vers team?)
- Should the bot token be per-org or global? (GitHub uses per-org installations, but Discord doesn't have that concept — one bot, many guilds)
- Should the invite link live on vers.sh, in the reef UI, or both?
- Should Slack follow the same pattern? (Official Vers Slack app, same inject-at-provision flow)
