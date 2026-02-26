# reef

Self-improving fleet infrastructure. The minimum kernel agents need to build their own tools.

Reef is a plugin-based server where every capability is a service module — a folder with an `index.ts`. Modules are discovered at startup, dispatched dynamically, and can be added, updated, or removed at runtime without restarting. The service manager and installer are themselves service modules.

Agents use reef to coordinate, and reef uses agents to extend itself.

## Quickstart

```bash
# Install dependencies
bun install

# Set an auth token
export VERS_AUTH_TOKEN=your-secret-token

# Start the server
bun run start
```

```
  services:
    /board — Shared task tracking
    /feed — Activity event stream
    /log — Append-only work log
    /journal — Personal narrative log
    /registry — VM service discovery
    /usage — Cost & token tracking
    /commits — VM snapshot ledger
    /reports — Markdown reports
    /docs — Auto-generated API documentation
    /installer — Install, update, and remove service modules
    /services — Service module manager
    /ui — Web dashboard

  reef running on :3000
```

## How it works

The server's only job is discovery, dispatch, and lifecycle. Everything else is a plugin.

```
services/
  board/index.ts       → /board/*
  feed/index.ts        → /feed/*
  installer/index.ts   → /installer/*
  services/index.ts    → /services/*
  docs/index.ts        → /docs/*
  ...
```

Each module exports a `ServiceModule` with routes (Hono), an optional store, optional LLM tools, and optional documentation:

```ts
import { Hono } from "hono";
import type { ServiceModule } from "../src/core/types.js";

const routes = new Hono();
routes.get("/", (c) => c.json({ hello: "world" }));
routes.post("/", async (c) => {
  const body = await c.req.json();
  return c.json({ created: body }, 201);
});

const myService: ServiceModule = {
  name: "my-service",
  description: "Does something useful",
  routes,
};

export default myService;
```

Drop that in `services/my-service/index.ts`, reload, and it's live at `/my-service`.

## Runtime management

No restarts needed. The server manages itself through its own API.

```bash
# Re-scan the services directory — picks up new, changed, and deleted modules
curl -X POST localhost:3000/services/reload \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"

# Reload a specific module after editing it
curl -X POST localhost:3000/services/reload/board \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"

# Unload a module
curl -X DELETE localhost:3000/services/board \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

## Installing services

Install from git, local paths, or other reef instances.

```bash
# From GitHub
curl -X POST localhost:3000/installer/install \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source": "user/repo"}'

# From a local path (creates a symlink)
curl -X POST localhost:3000/installer/install \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source": "/path/to/my-service"}'

# From another reef instance
curl -X POST localhost:3000/installer/install \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from": "http://other-reef:3000", "name": "their-service", "token": "their-token"}'

# Update (git pull or re-pull from remote)
curl -X POST localhost:3000/installer/update \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "repo-name"}'

# Remove
curl -X POST localhost:3000/installer/remove \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "repo-name"}'
```

Source formats for git install:

| Format | Example |
|--------|---------|
| GitHub shorthand | `user/repo` |
| With ref | `user/repo@v1.0` |
| HTTPS | `https://github.com/user/repo` |
| SSH | `git@github.com:user/repo` |
| Bare host | `gitlab.com/team/repo` |

## Auto-generated docs

Every module's routes are documented automatically. Modules can add rich descriptions via `routeDocs`.

```bash
# JSON docs for all services
curl localhost:3000/docs

# JSON docs for a specific service
curl localhost:3000/docs/board

# HTML docs UI (no auth required)
open http://localhost:3000/docs/ui
```

## Error handling

Reef is designed so one bad module can't take down the server.

- **Import fails** → module skipped, others load normally
- **`init()` throws** → module removed from registry, others keep running
- **Route handler throws** → returns `500 { error: "internal service error" }`
- **Runtime `loadModule()` fails** → rolled back, no half-initialized state

## pi extension

Reef doubles as a [pi](https://github.com/badlogic/pi-mono) package. Install it and agents get LLM tools for every service that defines them:

```bash
pi install /path/to/reef
```

Modules can contribute:
- **Tools** — LLM-callable functions (`registerTools`)
- **Behaviors** — automatic event handlers (`registerBehaviors`)
- **Widget lines** — status bar contributions (`widget`)

Modules without client-side code are automatically excluded from the extension.

## Creating a service

Reef ships with a `create-service` skill that teaches agents (or humans) the full pattern. Read it at `skills/create-service/SKILL.md`, or if you have reef installed as a pi package, the skill is available automatically.

The short version:

```
services/your-service/
  index.ts      — Module definition (required, default-exports ServiceModule)
  store.ts      — Data layer (JSON file, JSONL, or SQLite)
  routes.ts     — HTTP routes (Hono)
  tools.ts      — LLM tools (pi extension)
  behaviors.ts  — Event handlers and timers (pi extension)
```

## Built-in services

| Service | Description |
|---------|-------------|
| **board** | Shared task tracking with status workflow |
| **feed** | Activity event stream across the fleet |
| **log** | Append-only structured work log |
| **journal** | Personal narrative log per agent |
| **registry** | VM service discovery and heartbeats |
| **usage** | Cost and token tracking |
| **commits** | VM snapshot ledger |
| **reports** | Markdown report storage |
| **docs** | Auto-generated API documentation |
| **installer** | Install/update/remove modules from git, local, or other instances |
| **services** | Runtime module management and export |
| **ui** | Web dashboard |

## Tests

```bash
bun test
```

60 tests covering discovery, dynamic dispatch, auth, error handling, service context, the services manager, the installer (local, git, fleet-to-fleet), and source parsing.

## Requirements

- [Bun](https://bun.sh) runtime
- That's it
