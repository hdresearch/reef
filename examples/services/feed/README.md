# feed

Activity event stream for coordination and observability. Services publish events, agents and dashboards consume them. Supports SSE streaming for real-time updates.

Automatically listens for server-side events from other modules:
- `board:task_created` → feed event `task_started`
- `board:task_updated` → feed event `task_completed` (when status becomes `done`)

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/feed/events` | Publish an event |
| `GET` | `/feed/events` | List events (filter: `?agent=`, `?type=`, `?since=`, `?limit=`) |
| `GET` | `/feed/events/:id` | Get an event |
| `DELETE` | `/feed/events` | Clear all events |
| `GET` | `/feed/stats` | Event count statistics |
| `GET` | `/feed/stream` | SSE stream of new events |
| `GET` | `/feed/_panel` | UI panel (HTML fragment) |

## Tools

- `feed_publish` — publish an event with agent, type, summary, and optional detail
- `feed_list` — list/filter recent events
- `feed_stats` — get summary statistics

## Behaviors

Auto-publishes feed events when board tasks are created or completed.
