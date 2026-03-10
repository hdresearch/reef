# reports

Markdown reports. Agents write structured reports — sprint summaries, investigation findings, status updates. Stored with title, author, tags, and timestamp.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/reports` | Create a report (`{ title, content, author, tags? }`) |
| `GET` | `/reports` | List reports |
| `GET` | `/reports/:id` | Get a report |
| `DELETE` | `/reports/:id` | Delete a report |
