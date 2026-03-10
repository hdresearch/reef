# reef

An agent with a server. The minimum kernel agents need to build their own tools.

Reef is a plugin-based system where every capability is a service module — a folder with an `index.ts`. Everything that happens is an event in a causal tree: user prompts, tool calls, tool results, assistant responses, cron jobs, service deploys. The tree is the agent's memory.

## Quickstart

```bash
bun install
export ANTHROPIC_API_KEY=your-key
bun run start              # default port 4200
PORT=8080 bun run start    # custom port
```

Reef starts with all services loaded:

```
  🐚 reef

  services:
    /board — Shared task tracking
    /feed — Activity event stream
    /log — Append-only work log
    /store — Key-value store with TTL
    /cron — Scheduled jobs
    /docs — Auto-generated API documentation
    ...
    /reef — Event tree, task submission, SSE stream

  Dashboard  http://localhost:4200/ui
  API docs   http://localhost:4200/docs
  Health     http://localhost:4200/health

  reef running on :4200
```

Submit a task:

```bash
curl -X POST localhost:4200/reef/submit \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task": "List the services and tell me what each does."}'
```

Each task spawns a fresh [pi](https://github.com/badlogic/pi-mono) process with all reef tools available. Concurrent tasks run as concurrent processes.

### Agent setup

Install pi so reef can spawn agent processes:

```bash
npm install -g @mariozechner/pi-coding-agent
```

## Event tree

Every event is a node with a `parentId`. The tree structure emerges naturally:

```
[system] You are a reef agent
├─ [user] What is 2+2?
│  ├─ [tool] bash(echo $((2+2)))
│  │  └─ [result] 4
│  └─ [assistant] 2+2 = 4
│     └─ [user] Multiply by 10          ← conversation continuation
│        └─ [assistant] 40
├─ [cron] heartbeat (exec)
│  └─ [done] alive 03:02:00
└─ [event] service deployed: ping
```

- **Refs** point to leaf nodes like git branches (`main` → system root, `task-1` → latest response)
- **`contextFor(nodeId)`** walks ancestors to build conversation history for each task
- **Persists** to `data/tree.json`, loads on restart

### Tree API

```bash
# Full tree
curl localhost:4200/reef/tree -H "Authorization: Bearer $TOKEN"

# Single node + children
curl localhost:4200/reef/tree/:id -H "Authorization: Bearer $TOKEN"

# Ancestor path
curl localhost:4200/reef/tree/:id/path -H "Authorization: Bearer $TOKEN"

# All tasks (filterable by status)
curl localhost:4200/reef/tasks?status=done -H "Authorization: Bearer $TOKEN"

# SSE event stream (includes nodeId + parentId on every event)
curl localhost:4200/reef/events -H "Authorization: Bearer $TOKEN"
```

### Conversation continuation

Reply to any node by passing `parentId`:

```bash
curl -X POST localhost:4200/reef/submit \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task": "Now multiply by 10", "taskId": "math", "parentId": "<assistant-node-id>"}'
```

The server walks ancestors from that node to build the full conversation context.

## How it works

The server's only job is discovery, dispatch, and lifecycle. Everything else is a plugin.

```
services/
  your-service/
    index.ts    → /your-service/*
```

Each module exports a `ServiceModule`:

```ts
import { Hono } from "hono";
import type { ServiceModule } from "../../src/core/types.js";

const routes = new Hono();
routes.get("/", (c) => c.json({ hello: "world" }));

const myService: ServiceModule = {
  name: "my-service",
  description: "Does something useful",
  routes,
};

export default myService;
```

Drop that in `services/my-service/index.ts`, reload, and it's live at `/my-service`.

### Events

Any service can emit events that become nodes in the tree:

```ts
ctx.events.fire("reef:event", {
  type: "my_event",
  source: "my-service",
  content: "something happened",
});
```

## Runtime management

```bash
# Reload all (picks up new, changed, deleted modules)
curl -X POST localhost:4200/services/reload \
  -H "Authorization: Bearer $TOKEN"

# Reload one
curl -X POST localhost:4200/services/reload/my-service \
  -H "Authorization: Bearer $TOKEN"

# Unload
curl -X DELETE localhost:4200/services/my-service \
  -H "Authorization: Bearer $TOKEN"

# Deploy (validate + test + load in one step)
curl -X POST localhost:4200/services/deploy \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-service"}'

# Export as tarball
curl localhost:4200/services/export/my-service \
  -H "Authorization: Bearer $TOKEN" > my-service.tar.gz

# Manifest (all services + capabilities)
curl localhost:4200/services/manifest \
  -H "Authorization: Bearer $TOKEN"
```

## Installing services

The installer handles git repos, local paths, and fleet-to-fleet transfer.

```bash
# From GitHub
curl -X POST localhost:4200/installer/install \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source": "user/repo"}'

# From local path (symlink)
curl -X POST localhost:4200/installer/install \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source": "/path/to/my-service"}'

# From another reef instance
curl -X POST localhost:4200/installer/install \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from": "http://other-reef:3000", "name": "their-service", "token": "their-token"}'
```

Git source formats: `user/repo`, `user/repo@v1.0`, `https://github.com/user/repo`, `git@github.com:user/repo`, `gitlab.com/team/repo`

## Services

All services ship in `services/` and load automatically on startup:

| Service | Description |
|---------|-------------|
| **ui** | Web dashboard — split-pane feed + branch conversations |
| **board** | Shared task tracking with status workflow |
| **feed** | Activity event stream |
| **log** | Append-only structured work log |
| **journal** | Personal narrative log per agent |
| **registry** | VM service discovery and heartbeats |
| **usage** | Cost and token tracking |
| **commits** | VM snapshot ledger |
| **reports** | Markdown report storage |
| **scaffold** | Generate service module skeletons |
| **updater** | Auto-update from npm |
| **store** | Key-value store with TTL |
| **cron** | Scheduled jobs (cron expressions + intervals) |
| **docs** | Auto-generated API documentation |
| **installer** | Install, update, and remove service modules |

## Agent tools

Reef is also a [pi](https://github.com/badlogic/pi-mono) package. When a task runs, the agent automatically gets tools from all loaded services:

- **reef_manifest** — discover available services and capabilities
- **reef_deploy** — validate, test, and load a service in one step
- **reef_task_list** / **reef_task_read** — inspect completed tasks
- **reef_store_get** / **reef_store_put** / **reef_store_list** — key-value storage
- Plus any tools registered by your own service modules

With [Vers](https://vers.sh) configured (`VERS_API_KEY`), VM orchestration tools are also available:
- **vers_vm_create** / **vers_vm_branch** / **vers_vm_commit** — VM management

## Development

```bash
bun run dev       # watch mode
bun test          # 265 tests
bun run lint      # biome check
bun run lint:fix  # auto-fix
```

Pre-commit hook runs biome on staged `.ts` files. Activates automatically on `bun install` via the `prepare` script.

## Error handling

One bad module can't take down the server.

| Failure | What happens |
|---------|-------------|
| Import fails | Module skipped, others load normally |
| `init()` throws | Module rolled back, others keep running |
| Route handler throws | Returns `500 { error }`, server continues |
| Runtime load fails | Rolled back — no half-initialized state |

## Requirements

- [Bun](https://bun.sh) >= 1.2
- [pi](https://github.com/badlogic/pi-mono) (for agent tasks)
