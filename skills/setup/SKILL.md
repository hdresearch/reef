---
name: setup
description: Set up a reef server with example services. Use when bootstrapping a new reef instance or adding fleet coordination services to an existing one.
---

# Setup Reef

Reef ships with four core infrastructure services in `services/` (agent, docs, installer, services). Fleet coordination services live in `examples/services/` and need to be copied into `services/` to activate them.

## Available Example Services

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
| **ui** | Web dashboard with magic link auth, dynamic panels, chat |
| **updater** | Auto-update reef from npm |

## Dependencies

Some services depend on others. Install dependencies first:

- **usage** depends on **feed**
- **ui** works best with **board** and **feed** (for panels)

## Install All Example Services

To install everything:

```bash
cp -r examples/services/feed services/feed
cp -r examples/services/board services/board
cp -r examples/services/log services/log
cp -r examples/services/journal services/journal
cp -r examples/services/registry services/registry
cp -r examples/services/commits services/commits
cp -r examples/services/reports services/reports
cp -r examples/services/usage services/usage
cp -r examples/services/ui services/ui
cp -r examples/services/updater services/updater
```

Then restart or reload:

```bash
curl -X POST http://localhost:3000/services/reload -H "Authorization: Bearer $TOKEN"
```

## Install a Subset

Pick what you need. A minimal coordination setup:

```bash
# Task tracking + activity feed
cp -r examples/services/feed services/feed
cp -r examples/services/board services/board

# Work log
cp -r examples/services/log services/log

# Web dashboard (optional — discovers panels from board and feed)
cp -r examples/services/ui services/ui
```

Reload:

```bash
curl -X POST http://localhost:3000/services/reload -H "Authorization: Bearer $TOKEN"
```

## Fix Import Paths

The example services import types from `../src/core/types.js` (relative to `examples/services/`). After copying to `services/`, the import path resolves to `services/src/core/types.js` which doesn't exist.

**You must fix the imports** in each copied service. Change:

```ts
// Before (in examples/services/)
import type { ServiceModule } from "../src/core/types.js";
```

```ts
// After (in services/)
import type { ServiceModule } from "../../src/core/types.js";
```

Run this to fix all imports at once after copying:

```bash
find services/ -name '*.ts' -exec sed -i '' 's|from "../src/core/|from "../../src/core/|g' {} +
find services/ -name '*.ts' -exec sed -i '' 's|from "\.\./src/core/|from "../../src/core/|g' {} +
```

On Linux (no `-i ''`):

```bash
find services/ -name '*.ts' -exec sed -i 's|from "../src/core/|from "../../src/core/|g' {} +
```

## Verify

After copying and fixing imports:

```bash
# Check the server starts
bun run start

# Or check health
curl http://localhost:3000/health
```

The health endpoint lists all loaded services. Every service you copied should appear.

## Runtime Install (Alternative)

Instead of copying, you can use the installer to symlink from examples:

```bash
curl -X POST http://localhost:3000/installer/install \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source": "./examples/services/board"}'
```

This creates a symlink — changes to the example source are reflected immediately. Good for development, but the import path issue still applies if examples use relative paths to `src/core/`.

## Checklist

- [ ] Copied the services you need from `examples/services/` to `services/`
- [ ] Installed dependencies first (feed before usage)
- [ ] Fixed import paths (`../src/core/` → `../../src/core/`)
- [ ] Server starts without errors
- [ ] All copied services appear in `GET /health`
- [ ] `GET /docs` shows routes for each new service
