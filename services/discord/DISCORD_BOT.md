# Discord Bot — Notification Heuristic

The Discord bot posts to a configured channel when reef events are worth a human's attention. Not every event is a notification — most are noise. This document defines which events warrant a Discord message and how they should be formatted.

## Principles

1. **Signal, not noise.** A human glancing at the Discord channel should see only events that require awareness or action. If they could safely ignore it, don't post it.
2. **Batch over burst.** Multiple related events (e.g., 5 swarm workers completing in quick succession) should be collapsed into one message.
3. **Outcome over process.** Post when something finishes, fails, or needs attention — not when it starts.

## Event Classification

### Post to Discord (important)

| Event | Source | Why it matters |
|-------|--------|----------------|
| `task_done` (with error) | reef | A task the user submitted failed |
| `task_done` (success, user-initiated) | reef | The user's request completed |
| `lieutenant:created` | lieutenant | A new persistent agent was spawned — costs money, user should know |
| `lieutenant:completed` | lieutenant | A lieutenant finished its work — results are ready |
| `lieutenant:destroyed` | lieutenant | A lieutenant was torn down |
| `swarm:agent_error` | swarm | A swarm worker crashed — may need investigation |
| `swarm:agent_completed` (all workers done) | swarm | The entire swarm finished — results are ready |
| `reef:event` type=`service_installed` | installer | A new service was added to the reef |
| `reef:event` type=`service_removed` | installer | A service was removed |
| Cron job failure | cron | A scheduled job failed |

### Do NOT post to Discord (noise)

| Event | Why it's noise |
|-------|---------------|
| `task_started` | User already knows — they just submitted it |
| `swarm:agent_spawned` | Intermediate step, not an outcome |
| `swarm:agent_task_sent` | Internal orchestration |
| `swarm:agent_completed` (individual worker) | Wait for all workers, then post once |
| `swarm:agent_reconnected` | Self-healing, no action needed |
| `lieutenant:paused` / `lieutenant:resumed` | Routine lifecycle |
| `reef:event` type=`agent_spawned` | Internal, not user-facing |
| Health checks | Routine |
| Tool calls / text deltas | Too granular |

### Conditional (post only if significant)

| Event | Condition |
|-------|-----------|
| `swarm:agent_destroyed` | Only if unexpected (not part of normal teardown) |
| `lieutenant:created` (reconnected) | Only on first connect, not reconnections |
| Cron job success | Only if the job was explicitly set up to notify |

## Message Format

Messages should be short, scannable, and use Discord markdown:

```
**Task completed** — "Deploy the echo service to staging"
Result: Deployed `services/echo` to VM `lt-abc123`. Health check passed.
```

```
**Swarm finished** — 4/4 workers done
3 succeeded, 1 failed (worker-3: OOM killed)
```

```
**Lieutenant destroyed** — `scout-alpha` (VM: abc-123)
Ran for 2h 15m, completed 12 tasks.
```

Error messages should include enough context to act on:

```
**Task failed** — "Run the migration script"
Error: `SQLITE_BUSY: database is locked`
VM: `a5ef1e3b` | Duration: 45s
```

## Implementation

The Discord service should subscribe to the `ServiceEventBus` via `init(ctx)` and filter events through this heuristic. A `registerBehaviors` hook is not needed — the server-side `init` hook is the right place since notifications are server-driven, not agent-driven.

```typescript
init(ctx: ServiceContext) {
  // Subscribe to reef events that matter
  ctx.events.on("reef:event", (data) => { ... });
  ctx.events.on("lieutenant:created", (data) => { ... });
  ctx.events.on("lieutenant:completed", (data) => { ... });
  ctx.events.on("lieutenant:destroyed", (data) => { ... });
  ctx.events.on("swarm:agent_error", (data) => { ... });
  ctx.events.on("swarm:agent_completed", (data) => { ... });
}
```

### Batching

Use a 5-second debounce window for related events. If multiple `swarm:agent_completed` events arrive within 5 seconds, collapse them into a single "Swarm finished — N/M workers done" message.

### Channel Configuration

The target channel is resolved from:
1. `DISCORD_NOTIFICATION_CHANNEL_ID` env var
2. `vers-config` store override
3. If unset, notifications are silently dropped (service works but doesn't post)

This is separate from the `reef_discord_send` tool, which lets the agent post to any channel on demand. The notification channel is for automated server-side events only.
