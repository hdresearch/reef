---
name: create-service
description: Create a new service module for reef. Use when adding a new capability to the server — a new store, API routes, LLM tools, behaviors, or dashboard widget.
---

# Create a Service Module

Service modules are self-contained plugins — a folder in `services/` with an `index.ts` that exports a `ServiceModule`. Modules present at startup are discovered automatically. New modules added at runtime are loaded via the services manager (`POST /services/reload`) or the installer (`POST /installer/install`). No import wiring, no registration.

## Before You Start

Read these files to understand the system:

1. `src/core/types.ts` — the `ServiceModule` interface (the plugin contract)
2. `src/core/discover.ts` — how modules are found and loaded
3. `src/core/server.ts` — dynamic dispatch, error handling, lifecycle
4. `src/core/client.ts` — the `FleetClient` injected into tools/behaviors
5. `src/core/events.ts` — the `ServiceEventBus` for inter-module communication

Look at `examples/services/log/` for a minimal example and `examples/services/board/` for a full-featured one.

## Architecture

```
services/
  your-service/
    index.ts      — Module definition (required)
    store.ts      — Data layer
    routes.ts     — HTTP API (Hono routes)
    tools.ts      — LLM-callable tools (pi extension)
    behaviors.ts  — Automatic behaviors (event handlers, timers)
```

At startup, the server scans `services/*/index.ts` and loads everything it finds. Each must **default-export** a `ServiceModule` object. At runtime, use `POST /services/reload` to pick up new or changed modules.

A module has two halves:

| Side | Runs on | Files | Purpose |
|------|---------|-------|---------|
| **Server** | Infra VM | `routes.ts`, `store.ts` | HTTP API + persistence |
| **Client** | Agent VMs | `tools.ts`, `behaviors.ts` | LLM tools + automatic behaviors |

Modules that only have server-side code (no tools, behaviors, or widget) are automatically excluded from the pi extension.

## Runtime Management

You don't need to restart the server to work with modules. The server provides runtime management via two built-in service modules:

**Services manager** (`/services`):
- `GET /services` — list loaded modules
- `POST /services/reload` — re-scan directory, add new, update changed, remove deleted
- `POST /services/reload/:name` — reload a specific module
- `DELETE /services/:name` — unload a module
- `GET /services/export/:name` — export a module as a tarball

**Installer** (`/installer`):
- `POST /installer/install` — install from git, local path, or another reef instance
- `POST /installer/update` — pull latest and reload
- `POST /installer/remove` — unload and delete
- `GET /installer/installed` — list externally installed packages

Workflow during development:
1. Write your module in `services/your-service/`
2. `POST /services/reload/your-service` to hot-load it (or reload to pick up changes)
3. Test via curl
4. Iterate without restarting

## Step-by-Step

### 1. Create the directory

```bash
mkdir -p services/your-service
```

### 2. Write the store (`store.ts`)

The store owns all data and persistence. Three patterns:

**JSON file** (simple key-value or list data):

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class YourStore {
  private items = new Map<string, Item>();
  private filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath = "data/your-service.json") {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
        if (Array.isArray(data.items)) {
          for (const item of data.items) this.items.set(item.id, item);
        }
      }
    } catch { this.items = new Map(); }
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 100);
  }

  flush(): void {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath,
      JSON.stringify({ items: Array.from(this.items.values()) }, null, 2), "utf-8");
  }

  // ... your CRUD methods, each calling this.scheduleSave() after mutations
}
```

**JSONL file** (append-only event/log data):

```ts
import { appendFileSync } from "node:fs";

// Use appendFileSync for writes — no debounce needed
appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
```

**SQLite** (relational queries, aggregations):

```ts
import { Database } from "bun:sqlite";

// See services/usage/store.ts for a complete example
```

Key conventions:
- Store files go in `data/` (gitignored)
- Default file path in the constructor — no config needed
- Expose `flush()` for graceful shutdown
- Expose `close()` if using SQLite or other resources that need cleanup

### 3. Write the routes (`routes.ts`)

HTTP API using Hono. Routes are mounted at `/{name}/*` automatically.

```ts
import { Hono } from "hono";
import type { YourStore } from "./store.js";

export function createRoutes(store: YourStore): Hono {
  const routes = new Hono();

  routes.post("/", async (c) => {
    try {
      const body = await c.req.json();
      const result = store.create(body);
      return c.json(result, 201);
    } catch (e) {
      if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
      if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  routes.get("/", (c) => {
    const results = store.list();
    return c.json({ items: results, count: results.length });
  });

  routes.get("/:id", (c) => {
    const item = store.get(c.req.param("id"));
    if (!item) return c.json({ error: "not found" }, 404);
    return c.json(item);
  });

  return routes;
}
```

Routes are **bearer-auth protected by default**. If your service needs unauthenticated access (like docs), set `requiresAuth: false` in the module definition.

**Error handling**: If a route handler throws, the server catches it and returns `{ "error": "internal service error" }` with status 500. This prevents one broken module from taking down the server. But you should still handle expected errors explicitly with proper status codes.

### 4. Add route documentation (`routeDocs`)

Add `routeDocs` to your module definition so the `/docs` service can generate API documentation automatically.

```ts
routeDocs: {
  "POST /": {
    summary: "Create a new item",
    detail: "Creates an item and returns it with a generated ID.",
    body: {
      name: { type: "string", required: true, description: "Item name" },
      status: { type: "string", required: false, description: "Initial status (default: active)" },
    },
    response: "{ id, name, status, createdAt }",
  },
  "GET /": {
    summary: "List all items",
    params: {
      status: { type: "string", required: false, description: "Filter by status" },
    },
    response: "{ items: Item[], count }",
  },
  "GET /:id": {
    summary: "Get a specific item",
    response: "Item object or 404",
  },
},
```

The key format is `"METHOD /path"` (relative to the module's mount point). The `/docs` service combines this with auto-detected routes to produce both JSON (`GET /docs/your-service`) and HTML (`GET /docs/ui`) documentation.

Modules without `routeDocs` still appear in the docs — they just show method + path without descriptions.

### 5. Write the tools (`tools.ts`)

LLM-callable tools registered on the pi extension. These are the agent's interface to your service.

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FleetClient } from "../src/core/types.js";
import { Type } from "@sinclair/typebox";

export function registerTools(pi: ExtensionAPI, client: FleetClient) {
  pi.registerTool({
    name: "your_service_action",       // snake_case, prefixed with service name
    label: "Your Service: Action",      // Human-readable, shown in UI
    description:
      "What this tool does and when the LLM should use it. "
      + "Be specific — the LLM reads this to decide whether to call the tool.",
    parameters: Type.Object({
      requiredParam: Type.String({ description: "What this param is for" }),
      optionalParam: Type.Optional(Type.String({ description: "Optional context" })),
    }),
    async execute(_toolCallId, params) {
      if (!client.getBaseUrl()) return client.noUrl();

      try {
        const result = await client.api("POST", "/your-service", {
          ...params,
          agent: client.agentName,
        });
        return client.ok(JSON.stringify(result, null, 2), { result });
      } catch (e: any) {
        return client.err(e.message);
      }
    },
  });
}
```

Tool conventions:
- **Name**: `servicename_verb` — e.g. `board_create_task`, `log_append`, `feed_publish`
- **Description**: Write for the LLM. Explain *when* to use it, not just what it does
- **Parameters**: Use TypeBox schemas. Add `description` to every field
- **Execute pattern**: Check `client.getBaseUrl()` → call `client.api()` → return `client.ok()` or `client.err()`
- **Agent attribution**: Pass `client.agentName` so entries are tagged with who created them

The `FleetClient` provides:
- `client.api(method, path, body?)` — authenticated HTTP call to the reef server
- `client.agentName` — this agent's name (from `VERS_AGENT_NAME` env var)
- `client.vmId` — this agent's VM ID, if set
- `client.ok(text, details?)` — successful tool result
- `client.err(text)` — error tool result
- `client.noUrl()` — standard error when `VERS_INFRA_URL` is not set

### 6. Write behaviors (`behaviors.ts`) — optional

Behaviors are automatic event handlers that run without the LLM deciding to call them. Use for:
- Auto-publishing events on agent lifecycle (start, end, turn)
- Heartbeats and periodic tasks
- Reacting to other extensions' events

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FleetClient } from "../src/core/types.js";

export function registerBehaviors(pi: ExtensionAPI, client: FleetClient) {
  pi.on("agent_start", async () => {
    if (!client.getBaseUrl()) return;
    try {
      await client.api("POST", "/your-service/events", {
        agent: client.agentName,
        type: "started",
      });
    } catch { /* best-effort — never crash the agent */ }
  });

  // Periodic task
  let timer: ReturnType<typeof setInterval> | null = null;

  pi.on("session_start", async () => {
    timer = setInterval(async () => {
      // periodic work
    }, 60_000);
  });

  pi.on("session_shutdown", async () => {
    if (timer) { clearInterval(timer); timer = null; }
  });
}
```

Behavior conventions:
- **Always guard** with `if (!client.getBaseUrl()) return` — agents may not have infra configured
- **Always try/catch** — a behavior error should never crash the agent
- **Clean up timers** on `session_shutdown`

### 7. Write the module definition (`index.ts`)

This ties everything together.

```ts
import type { ServiceModule } from "../src/core/types.js";
import { YourStore } from "./store.js";
import { createRoutes } from "./routes.js";
import { registerTools } from "./tools.js";
import { registerBehaviors } from "./behaviors.js";

const store = new YourStore();

const yourService: ServiceModule = {
  name: "your-service",              // URL prefix: /your-service/*
  description: "What this service does",

  // Server side
  routes: createRoutes(store),
  store,

  // Client side (omit if server-only)
  registerTools,
  registerBehaviors,

  // Route documentation for /docs
  routeDocs: {
    "POST /": {
      summary: "Create an item",
      body: {
        name: { type: "string", required: true, description: "Item name" },
      },
      response: "{ id, name, createdAt }",
    },
    "GET /": {
      summary: "List all items",
      response: "{ items: Item[], count }",
    },
  },

  // Optional: init hook for cross-module wiring
  init(ctx) {
    ctx.events.on("board:task_created", (data) => {
      // react to events from other modules
    });
  },

  // Optional
  dependencies: ["feed"],            // Load after "feed"
  requiresAuth: true,                // Default — set false for public endpoints
};

export default yourService;
```

### 8. Test it

**No restart needed** — use the services manager:

```bash
# Hot-load your new module
curl -X POST http://localhost:3000/services/reload/your-service \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"

# Check it's loaded
curl http://localhost:3000/health

# Check the auto-generated docs
curl http://localhost:3000/docs/your-service

# Test your routes
curl -X POST http://localhost:3000/your-service \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "test"}'

curl http://localhost:3000/your-service \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

After making changes, reload without restarting:

```bash
curl -X POST http://localhost:3000/services/reload/your-service \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

## Error Handling

The server is designed to be resilient to bad modules:

- **Import errors** (syntax, missing deps): Module is skipped at startup, others keep loading
- **`init()` throws**: Module is skipped and removed from the registry, others keep running
- **Route handler throws**: Returns `500 { error: "internal service error" }` — doesn't crash the server
- **`loadModule()` fails at runtime**: Rolled back — module is not left in a half-initialized state

Your module should still handle errors properly:
- Return appropriate HTTP status codes (400, 404, 409, etc.)
- Wrap behaviors in try/catch (never crash the agent)
- Check `client.getBaseUrl()` before making API calls in tools

## ServiceModule Interface Reference

```ts
interface ServiceModule {
  name: string;                    // Route prefix, must be unique
  description?: string;            // Shown in server startup log and docs

  // Server side
  routes?: Hono;                   // Mounted at /{name}/*
  mountAtRoot?: boolean;           // Mount at / instead (for UI, webhooks)
  requiresAuth?: boolean;          // Default: true
  store?: { flush?(); close?(); }; // For graceful shutdown
  init?(ctx: ServiceContext): void; // Cross-module wiring

  // Client side
  registerTools?(pi, client): void;
  registerBehaviors?(pi, client): void;
  widget?: { getLines(client): Promise<string[]> };

  // Documentation
  routeDocs?: Record<string, RouteDocs>;  // "METHOD /path" → docs

  // Metadata
  dependencies?: string[];         // Load after these modules
}

interface RouteDocs {
  summary: string;
  detail?: string;
  params?: Record<string, ParamDoc>;   // Query/path parameters
  body?: Record<string, ParamDoc>;     // Request body fields
  response?: string;                    // Response shape description
}

interface ParamDoc {
  type: string;
  required?: boolean;
  description: string;
}
```

## Common Patterns

### Emitting server-side events

Let other modules react to your changes:

```ts
// In index.ts
let events: ServiceEventBus | null = null;

const mod: ServiceModule = {
  init(ctx) { events = ctx.events; },
  routes: createRoutes(store, () => events),
};

// In routes.ts — emit after mutations
events?.emit("your-service:item_created", { item });
```

### Server-only module (no agent tools)

Just omit `registerTools`, `registerBehaviors`, and `widget`. The module will be auto-excluded from the pi extension:

```ts
const serverOnly: ServiceModule = {
  name: "webhooks",
  routes: createRoutes(),
  requiresAuth: false,
};
export default serverOnly;
```

### Installing from another reef instance

If another reef instance has a service you want:

```bash
curl -X POST http://localhost:3000/installer/install \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from": "http://other-reef:3000", "name": "their-service", "token": "their-token"}'
```

## UI Panels

Services can contribute a panel to the web dashboard. The UI service discovers panels dynamically — no hardcoded knowledge of which services exist.

**Convention**: Add a `GET /_panel` route that returns an HTML fragment with scoped `<style>` and `<script>` tags.

```ts
// In routes.ts
routes.get("/_panel", (c) => {
  return c.html(`
<style>
.panel-myservice { padding: 8px; }
.panel-myservice .card {
  background: var(--bg-card, #1a1a1a);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 4px; padding: 10px; margin: 4px 0;
}
.panel-myservice .empty {
  color: var(--text-dim, #666); font-style: italic;
  padding: 20px; text-align: center;
}
</style>

<div class="panel-myservice" id="myservice-root">
  <div class="empty">Loading…</div>
</div>

<script>
(function() {
  const root = document.getElementById('myservice-root');
  const API = typeof PANEL_API !== 'undefined' ? PANEL_API : '/ui/api';

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  async function load() {
    try {
      const res = await fetch(API + '/myservice/items');
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      render(data.items || []);
    } catch (e) {
      root.innerHTML = '<div class="empty">Unavailable: ' + esc(e.message) + '</div>';
    }
  }

  function render(items) {
    if (!items.length) {
      root.innerHTML = '<div class="empty">No items</div>';
      return;
    }
    root.innerHTML = items.map(item =>
      '<div class="card">' + esc(item.name) + '</div>'
    ).join('');
  }

  load();
  setInterval(load, 10000); // poll every 10s
})();
</script>
`);
});
```

**Panel rules**:
- **Scope CSS** to `.panel-<name>` — prevents conflicts with other panels
- **Wrap JS in an IIFE** — prevents global namespace pollution
- **Use `PANEL_API`** for API calls — this goes through the UI's auth proxy
- **Use CSS variables** (`var(--bg-card)`, `var(--border)`, etc.) — matches the UI theme
- **Handle errors gracefully** — show a message if the service API is down
- **Poll for updates** — panels aren't automatically refreshed

Available CSS variables from the UI theme:
- `--bg`, `--bg-panel`, `--bg-card` — backgrounds
- `--border` — borders
- `--text`, `--text-dim`, `--text-bright` — text colors
- `--accent`, `--blue`, `--purple`, `--yellow`, `--red`, `--orange` — accent colors

**How it works**: The UI service calls `GET /services` on load, then tries `GET /<service>/_panel` for each loaded module. Services that return HTML get a tab in the dashboard. Tabs appear and disappear automatically as services are loaded/unloaded.

**SSE in panels**: For live-updating panels (like a feed), use `fetch()` with a streaming reader instead of `EventSource` — this lets you go through the API proxy which injects auth:

```js
fetch(API + '/feed/stream').then(res => {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async function read() {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const event = JSON.parse(line.slice(6));
          // render the event
        }
      }
    }
  })().catch(() => setTimeout(startSSE, 5000));
});
```

## Checklist

Before considering the service done:

- [ ] `index.ts` default-exports a `ServiceModule`
- [ ] `name` is unique across all services
- [ ] Store handles missing `data/` directory (creates it)
- [ ] Routes return proper HTTP status codes (201, 400, 404)
- [ ] `routeDocs` added for all routes
- [ ] Tools are prefixed with the service name (`servicename_verb`)
- [ ] Tool descriptions explain *when* to use them
- [ ] Every tool checks `client.getBaseUrl()` before making API calls
- [ ] Behaviors are wrapped in try/catch
- [ ] Behaviors clean up timers on `session_shutdown`
- [ ] Hot-loads via `POST /services/reload/your-service`
- [ ] Routes work via curl
- [ ] Shows up in `GET /docs/your-service`
- [ ] UI panel added (`GET /_panel`) if the service has data worth showing
