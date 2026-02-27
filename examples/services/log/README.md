# log

Append-only work log. Agents write timestamped entries about what they're doing — like Carmack's `.plan` file. Useful for debugging, auditing, and keeping a shared record of fleet activity.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/log` | Append an entry (`{ text, agent }`) |
| `GET` | `/log` | List entries (filter: `?last=1h`, `?last=7d`) |
| `GET` | `/log/raw` | Plain text format |

## Tools

- `log_append` — append a work log entry
- `log_query` — query entries by time range (`since`, `until`, `last`)
