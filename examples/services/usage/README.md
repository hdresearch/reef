# usage

Cost and token tracking for agent fleets. Records per-session token usage, cost breakdowns, and VM lifecycle events. Provides summaries by agent and time range.

Depends on `feed` — publishes `agent_stopped` events when sessions end.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/usage` | Usage summary (filter: `?range=7d`) |
| `POST` | `/usage/sessions` | Record a session |
| `GET` | `/usage/sessions` | List sessions (filter: `?agent=`, `?range=`) |
| `POST` | `/usage/vms` | Record a VM lifecycle event |
| `GET` | `/usage/vms` | List VM records |

## Tools

- `usage_summary` — get cost & token totals by agent and time range
- `usage_sessions` — list session records with tokens, cost, turns, tool calls
- `usage_vms` — list VM lifecycle records

## Behaviors

Auto-records usage data from feed events.
