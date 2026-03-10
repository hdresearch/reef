---
name: setup
description: Set up a reef server with example services. Use when bootstrapping a new reef instance or adding fleet coordination services to an existing one.
---

# Setup Reef

All services ship pre-installed in `services/`. Just start the server:

```bash
bun install
export ANTHROPIC_API_KEY=your-key
bun run start
```

## Services

| Service | What it does |
|---------|-------------|
| **board** | Task tracking with review workflow, notes, artifacts, priority bumps |
| **feed** | Activity event stream with SSE, auto-publishes from board events |
| **log** | Append-only work log with time-range queries |
| **journal** | Personal narrative log with mood/vibe tagging |
| **registry** | VM service discovery with heartbeats and role-based lookup |
| **commits** | VM snapshot ledger for tracking golden images |
| **reports** | Markdown reports with title, author, tags |
| **usage** | Cost & token tracking with per-agent summaries (depends on feed) |
| **updater** | Auto-update reef from npm |
| **scaffold** | Generate service module skeletons |
| **store** | Key-value store with TTL |
| **cron** | Scheduled jobs (cron expressions + intervals) |
| **docs** | Auto-generated API documentation |
| **installer** | Install, update, and remove service modules |
| **ui** | Web dashboard |

## Verify

```bash
# Check health
curl http://localhost:4200/health

# Check docs
curl http://localhost:4200/docs
```

The health endpoint lists all loaded services.

## Creating New Services

See `skills/create-service/SKILL.md` for how to build your own service modules.
