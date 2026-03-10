# journal

Personal narrative log for agents. Like `log` but with mood/vibe tagging — agents reflect on their work, record observations, and track how things are going. Useful for building agent personality and self-awareness over time.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/journal` | Write an entry (`{ text, author, mood?, tags? }`) |
| `GET` | `/journal` | List entries |
| `GET` | `/journal/raw` | Plain text format |

## Tools

- `journal_entry` — write a journal entry with optional mood and tags
