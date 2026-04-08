# Notifications Service

## Overview

Centralized event filtering and push for reef. Subscribes to reef's `ServiceEventBus`, decides what's worth notifying, and emits `notification:push` events that transport services (Discord, Slack) forward to users.

This service does not know about Discord, Slack, or any specific platform — it emits channel-agnostic notification objects.

## What gets notified

| Event | Level | Condition |
|-------|-------|-----------|
| Task completed | success | Duration >30s OR files changed |
| Task failed | error | Always |
| Lieutenant spawned | info | Not reconnections |
| Lieutenant completed | success | Always |
| Lieutenant destroyed | warning | Always |
| Swarm finished | success/warning | All workers done (warning if any failed) |
| Swarm worker error | error | Always |
| Service installed | info | Always |
| Service removed | warning | Always |

## What does NOT get notified

- Tasks under 30 seconds (casual Q&A)
- Tasks submitted from Discord or Slack (user already saw the reply)
- Task started events
- Individual swarm worker completions (waits for all workers)
- Lieutenant paused/resumed
- Health checks, tool calls, text deltas

## Configuration

| Variable | Description |
|----------|-------------|
| `NOTIFICATION_MUTE` | `"true"` to mute all notifications globally |
| `NOTIFICATION_MIN_DURATION_MS` | Minimum task duration to notify (default: 30000) |

Set via `PUT /vers-config/NOTIFICATION_MUTE` or the agent tools.

## How transport services subscribe

Discord and Slack services listen for `notification:push` on the `ServiceEventBus`:

```typescript
ctx.events.on("notification:push", (data) => {
  const notifications = data.notifications; // array of Notification objects
  // Format for your platform and send
});
```

## Notification object shape

```typescript
{
  id: string;
  level: "info" | "success" | "warning" | "error";
  title: string;
  body: string;
  source: string;       // "reef", "lieutenant", "swarm", "installer"
  timestamp: number;
  metadata?: {
    taskId?: string;
    vmId?: string;
    durationMs?: number;
    // ...
  };
}
```

## Batching

Events are collected for 5 seconds before being flushed. If 5 swarm workers complete in quick succession, subscribers get one `notification:push` with all 5, not five separate pushes.

## Routes

| Route | Description |
|-------|-------------|
| `GET /notifications/config` | Current settings (muted, minDurationMs) |
| `PUT /notifications/config` | Update settings |
| `GET /notifications/history` | Last 50 notifications |
| `POST /notifications/test` | Send a test notification to all subscribers |

## Agent tools

| Tool | Description |
|------|-------------|
| `reef_notify_test` | Send a test notification |
| `reef_notify_mute` | Mute all notifications |
| `reef_notify_unmute` | Unmute all notifications |
| `reef_notify_history` | View recent notification history |

## Adding a new transport

To add email, SMS, or another channel:

1. Create a new service (e.g., `services/email/index.ts`)
2. In `init(ctx)`, subscribe to `notification:push`
3. Format the notification for your platform
4. Send it

No changes needed to the notifications service — it doesn't know or care who's listening.
