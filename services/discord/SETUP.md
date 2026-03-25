# Discord Integration Setup

## For users (target state — official Vers bot)

1. Click the invite link provided by the reef agent (or visit `vers.sh/discord`)
2. Select your Discord server and authorize
3. Tell the reef agent which channel to use for notifications
4. Done — the bot responds to @mentions and posts event notifications

## For users (current state — BYO bot)

### Create a Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** — name it whatever you like
3. Go to **Bot** tab — click **Reset Token** — copy the token
4. Under **Privileged Gateway Intents**, enable **MESSAGE CONTENT INTENT**

### Add the bot to your server

1. Go to **OAuth2 > URL Generator**
2. Select scope: `bot`
3. Select permissions: `Send Messages`, `Read Message History`
4. Copy the generated URL, open it, select your server

### Configure reef

Tell the reef agent: *"configure discord with token [your-token]"*

Or set the environment variable before provisioning:
```bash
export DISCORD_BOT_TOKEN="your-token-here"
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Bot token. Set at provision time or via `reef_discord_configure` |
| `DISCORD_APP_ID` | No | Application ID for invite link generation. Placeholder until official bot |
| `DISCORD_NOTIFICATION_CHANNEL_ID` | No | Channel for proactive event notifications |

## How it works

### Receiving messages (Gateway)

The service opens a WebSocket connection to Discord's Gateway on startup. When someone @mentions the bot or sends a DM:

1. Bot reacts with 👀 (acknowledged)
2. Message is submitted to reef as a task
3. Messages in the same channel continue the same reef conversation
4. Bot polls for the result
5. Reply is posted back, internal tags stripped, split if >2000 chars
6. Reaction swapped to ✅ (success) or ❌ (error)

### Sending messages (API)

The agent can proactively send messages using the `reef_discord_send` tool.

### Proactive notifications

When a notification channel is configured, the notifications service pushes reef events (task completions >30s, errors, lieutenant lifecycle, swarm results) to the channel automatically.

## Agent tools

| Tool | Description |
|------|-------------|
| `reef_discord_setup` | Returns the invite link for the official Vers bot |
| `reef_discord_send` | Send a message to a channel |
| `reef_discord_channels` | List channels in a guild |
| `reef_discord_configure` | Set a BYO bot token (fallback) |
| `reef_discord_notify` | Set the notification channel |

## Creating the official Vers Discord bot

For the Vers team — to create the official bot that all users share:

1. Create a Discord application under the Vers team account
2. Enable **MESSAGE CONTENT INTENT**
3. Set the application ID as `DISCORD_APP_ID` (replaces `YOUR_APP_ID_HERE`)
4. The bot token gets stored in the Vers platform backend
5. Injected into reef instances at provision time via `DISCORD_BOT_TOKEN` in `buildRuntimeEnv()`
6. Users just click the invite link — no token handling needed

See `DISCORD_INTEGRATION_PLAN.md` for the full migration plan.
