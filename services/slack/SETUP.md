# Slack Integration Setup

## For users (target state — official Vers bot)

1. Click "Add to Slack" link provided by the reef agent (or visit `vers.sh/slack`)
2. Authorize the Vers bot for your workspace
3. Tell the reef agent which channel to use for notifications
4. Done — the bot responds to @mentions and DMs, posts event notifications

## For users (current state — BYO bot)

### Create a Slack Application

1. Go to [api.slack.com/apps](https://api.slack.com/apps) — click **Create New App** > **From Scratch**
2. Name it and select your workspace

### Add bot scopes

Go to **OAuth & Permissions** > **Bot Token Scopes** and add:

| Scope | Purpose |
|-------|---------|
| `chat:write` | Send messages |
| `chat:write.public` | Post to public channels without being invited |
| `channels:read` | List channels |
| `channels:history` | Read channel messages |
| `im:history` | Read DM messages |
| `im:read` | View DM channels |
| `im:write` | Send DMs |
| `app_mentions:read` | Receive @mention events |
| `reactions:read` | Read reactions |
| `reactions:write` | Add/remove reactions (for 👀→✅/❌ acknowledgment) |
| `users:read` | Resolve user display names |

### Enable Socket Mode

1. Go to **Settings > Socket Mode** — toggle **ON**
2. Go to **Basic Information > App-Level Tokens** — click **Generate Token**
3. Give it `connections:write` scope — copy the `xapp-...` token

### Subscribe to events

1. Go to **Event Subscriptions** — toggle **ON**
2. Under **Subscribe to bot events**, add:
   - `app_mention` — @mentions in channels
   - `message.im` — direct messages

### Enable messaging

1. Go to **App Home > Show Tabs**
2. Toggle **Chat Tab** ON
3. Check **"Allow users to send Slash commands and messages from the chat tab"**

### Install to workspace

Click **Install to Workspace** and authorize. Copy the **Bot User OAuth Token** (`xoxb-...`).

### Configure reef

Tell the reef agent: *"configure slack with token [your-xoxb-token]"*

Or set environment variables before provisioning:
```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot User OAuth Token (`xoxb-...`). For sending messages and API calls |
| `SLACK_APP_TOKEN` | Yes (for receiving messages) | App-Level Token with `connections:write` (`xapp-...`). Required for Socket Mode |
| `SLACK_NOTIFICATION_CHANNEL` | No | Channel ID for proactive event notifications |

## How it works

### Receiving messages (Socket Mode)

The service connects to Slack's Socket Mode WebSocket on startup. When someone @mentions the bot or sends a DM:

1. Bot reacts with 👀 (acknowledged)
2. Message is submitted to reef as a task
3. Messages in the same channel continue the same reef conversation
4. Bot polls for the result
5. Reply is posted in-thread, internal tags stripped, split if >3900 chars
6. Reaction swapped to ✅ (success) or ❌ (error)

### Sending messages (API)

The agent can proactively send messages using the `reef_slack_send` tool.

### Proactive notifications

When a notification channel is configured, the notifications service pushes reef events to the channel automatically (same events as Discord — task completions >30s, errors, lieutenant lifecycle, swarm results).

## Agent tools

| Tool | Description |
|------|-------------|
| `reef_slack_send` | Send a message to a channel or thread |
| `reef_slack_channels` | List channels the bot can see |
| `reef_slack_configure` | Set a BYO bot token |

## Creating the official Vers Slack bot

For the Vers team — to create the official bot:

1. Create a Slack app under a Vers workspace
2. Add all scopes listed above
3. Enable distribution (**Manage Distribution** > activate)
4. Set up an OAuth callback endpoint on vers.sh (e.g., `vers.sh/api/slack/oauth/callback`)
   - Receives auth code after user clicks "Add to Slack"
   - Exchanges code for a workspace-specific bot token
   - Stores token per-org in the Vers backend
5. Reef instances fetch their org's token via `vers.sh/api/slack/bot-token` using `VERS_API_KEY`
6. The "Add to Slack" URL: `https://slack.com/oauth/v2/authorize?client_id={CLIENT_ID}&scope=chat:write,chat:write.public,channels:read,channels:history,im:history,im:read,im:write,app_mentions:read,reactions:read,reactions:write,users:read`

**Key difference from Discord**: Slack issues per-workspace tokens (not one global token). The Vers backend needs to store and serve these per-org.
