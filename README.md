# reef

Self-improving fleet infrastructure. The minimum kernel agents need to build their own tools.

Reef is a plugin-based server where every capability is a service module — a folder with an `index.ts`. Modules are discovered at startup, dispatched dynamically, and can be added, updated, or removed at runtime without restarting. Even the module manager and installer are service modules. Nothing is required. Everything is replaceable.

## Quickstart

```bash
bun install

export VERS_AUTH_TOKEN=your-secret-token

bun run start
```

Out of the box, reef starts with four service modules:

```
  services:
    /agent — Run tasks using pi as the coding agent
    /docs — Auto-generated API documentation
    /installer — Install, update, and remove service modules
    /services — Service module manager

  reef running on :3000
```

These give you an agent loop, runtime management, installation, and API docs. They're not special — they're regular service modules that happen to ship in `services/`. You can remove them and replace them with whatever you want.

### Agent setup

The agent service spawns [pi](https://github.com/badlogic/pi-mono) to execute tasks. Install pi and the Vers extension so agents get fleet tools:

```bash
npm install -g @mariozechner/pi-coding-agent
pi install hdresearch/pi-vers
```

The agent service provides two modes:
- **Fire-and-forget tasks** — `POST /agent/tasks` for automation
- **Interactive chat** — `GET /agent/ui?token=YOUR_TOKEN` for a web-based chat interface

The chat UI connects to pi via RPC mode with full streaming — you see text, tool calls, and results in real-time.

### Adding the example services

Reef ships with a set of fleet coordination services in `examples/services/`. To use them, copy the ones you want:

```bash
# Copy everything
cp -r examples/services/* services/

# Or pick what you need
cp -r examples/services/board services/
cp -r examples/services/feed services/
cp -r examples/services/log services/
```

Then reload:

```bash
curl -X POST localhost:3000/services/reload \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

No restart needed.

| Example service | Description |
|-----------------|-------------|
| **board** | Shared task tracking with status workflow |
| **feed** | Activity event stream across the fleet |
| **log** | Append-only structured work log |
| **journal** | Personal narrative log per agent |
| **registry** | VM service discovery and heartbeats |
| **usage** | Cost and token tracking |
| **commits** | VM snapshot ledger |
| **reports** | Markdown report storage |
| **ui** | Web dashboard |

These are one fleet's solution to one fleet's problem. Use them as-is, modify them, or throw them away and build your own.

## How it works

The server's only job is discovery, dispatch, and lifecycle. Everything else is a plugin.

```
services/
  your-service/
    index.ts    → /your-service/*
```

Each module exports a `ServiceModule` with routes, an optional store, and optional metadata:

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

The services manager module provides an API for managing modules without restarting.

```bash
# Re-scan — picks up new, changed, and deleted modules
curl -X POST localhost:3000/services/reload \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"

# Reload a specific module
curl -X POST localhost:3000/services/reload/my-service \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"

# Unload a module
curl -X DELETE localhost:3000/services/my-service \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"

# Export a module as a tarball
curl localhost:3000/services/export/my-service \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" > my-service.tar.gz
```

## Installing services

The installer module handles git repos, local paths, and other reef instances.

```bash
# From GitHub (shorthand, HTTPS, or SSH)
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
```

Git source formats:

| Format | Example |
|--------|---------|
| GitHub shorthand | `user/repo` |
| With ref | `user/repo@v1.0` |
| HTTPS | `https://github.com/user/repo` |
| SSH | `git@github.com:user/repo` |
| Bare host | `gitlab.com/team/repo` |

```bash
# Update (git pull or re-pull from remote)
curl -X POST localhost:3000/installer/update \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "repo-name"}'

# Remove (unload + delete)
curl -X POST localhost:3000/installer/remove \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "repo-name"}'

# List externally installed packages
curl localhost:3000/installer/installed \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

## Auto-generated docs

The docs module documents every loaded service automatically. Modules can add rich descriptions via `routeDocs`.

```bash
# All services
curl localhost:3000/docs

# Specific service
curl localhost:3000/docs/board

# HTML UI (no auth required)
open http://localhost:3000/docs/ui
```

## Error handling

One bad module can't take down the server.

| Failure | What happens |
|---------|--------------|
| Import fails | Module skipped, others load normally |
| `init()` throws | Module removed from registry, others keep running |
| Route handler throws | Returns `500 { error: "internal service error" }` |
| Runtime `loadModule()` fails | Rolled back — no half-initialized state |

## pi extension

Reef is also a [pi](https://github.com/badlogic/pi-mono) package. Install it and agents get LLM tools for every service that defines them:

```bash
pi install /path/to/reef
```

Modules can contribute:
- **Tools** — LLM-callable functions (`registerTools`)
- **Behaviors** — automatic event handlers (`registerBehaviors`)
- **Widget lines** — status bar contributions (`widget`)

Modules without client-side code are automatically excluded from the extension.

## Creating a service

Reef ships with a `create-service` skill at `skills/create-service/SKILL.md` that covers the full pattern — stores, routes, tools, behaviors, route documentation, and testing. If you have reef installed as a pi package, the skill is available to agents automatically.

The short version:

```
services/your-service/
  index.ts      — Module definition (required, default-exports ServiceModule)
  store.ts      — Data layer (JSON file, JSONL, or SQLite)
  routes.ts     — HTTP routes (Hono)
  tools.ts      — LLM tools (pi extension)
  behaviors.ts  — Event handlers and timers (pi extension)
```

## Tests

```bash
bun test
```

60 tests covering discovery, dispatch, auth, error handling, service context, runtime management, installation (local, git, fleet-to-fleet), and source parsing.

## Requirements

- [Bun](https://bun.sh)
