# agent

Run tasks and interactive sessions using [pi](https://github.com/mariozechner/pi-coding-agent). Two modes: fire-and-forget tasks for automation, and interactive sessions for chat.

## Routes

### Tasks (fire-and-forget)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agent/tasks` | Submit a task (spawns `pi -p`) |
| `GET` | `/agent/tasks` | List runs |
| `GET` | `/agent/tasks/:id` | Get run status + output (`?tail=N` for last N lines) |
| `POST` | `/agent/tasks/:id/cancel` | Cancel a running task |

### Sessions (interactive chat)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agent/sessions` | Start a session (spawns `pi --mode rpc`) |
| `GET` | `/agent/sessions` | List sessions |
| `GET` | `/agent/sessions/:id/events` | SSE stream of pi events |
| `POST` | `/agent/sessions/:id/message` | Send a message |
| `POST` | `/agent/sessions/:id/abort` | Abort current operation |
| `DELETE` | `/agent/sessions/:id` | End session |

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `PI_PATH` | `pi` | Path to pi binary |
| `PI_MODEL` | `claude-sonnet-4-20250514` | Model to use |
| `PI_PROVIDER` | `anthropic` | Provider |

## How it works

- **Tasks** spawn `pi -p` with `--append-system-prompt` injecting reef context and the create-service skill. Output is captured and queryable.
- **Sessions** spawn `pi --mode rpc` and communicate via JSON lines over stdin/stdout. Events are broadcast to SSE clients (recent 200 buffered for late joiners).
- The chat web interface lives in the UI example service (`examples/services/ui`), not here — this service is pure API.
