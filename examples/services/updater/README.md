# updater

Auto-update the reef server from npm. Checks for new versions of `@versdotsh/reef`, downloads updates, and restarts the process.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/updater/status` | Current version, latest available, poll config, update history |
| `POST` | `/updater/check` | Check npm for a newer version |
| `POST` | `/updater/apply` | Apply the update and restart the server |

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `UPDATE_POLL_INTERVAL` | `0` | Check interval in minutes (0 = manual only) |
| `UPDATE_AUTO_APPLY` | `false` | Automatically apply updates when found |

## Usage

**Manual update:**
```bash
# Check for updates
curl -X POST http://localhost:3000/updater/check -H "Authorization: Bearer $TOKEN"

# Apply if available
curl -X POST http://localhost:3000/updater/apply -H "Authorization: Bearer $TOKEN"
```

**Auto-update every 30 minutes:**
```bash
UPDATE_POLL_INTERVAL=30 UPDATE_AUTO_APPLY=true bun run start
```

## How it works

1. **Check** — fetches `https://registry.npmjs.org/@versdotsh/reef/latest` and compares versions
2. **Apply** — runs `bun update @versdotsh/reef`, then spawns a new server process and exits the current one
3. **Poll** — if `UPDATE_POLL_INTERVAL` is set, checks on a timer; if `UPDATE_AUTO_APPLY` is also set, applies automatically
