---
name: create-service
description: Create a new service module for vers-agent-services. Use when adding a new capability to the fleet coordination server — a new store, API routes, LLM tools, behaviors, or dashboard widget.
---

# Create a Service Module

This skill walks you through creating a new service module for the fleet coordination server. Service modules are self-contained plugins — drop a folder in `services/`, it gets discovered and loaded automatically.

## Before You Start

Read these files to understand the system:

1. `src/core/types.ts` — the `ServiceModule` interface (the plugin contract)
2. `src/core/discover.ts` — how modules are found and loaded
3. `src/core/client.ts` — the `FleetClient` injected into tools/behaviors
4. `src/core/events.ts` — the `ServiceEventBus` for inter-module communication

Look at `services/log/` for a minimal example and `services/board/` for a full-featured one.

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

The server discovers modules by scanning `services/*/index.ts`. Each must **default-export** a `ServiceModule` object. No registration or import wiring needed.

A module has two halves:

| Side | Runs on | Files | Purpose |
|------|---------|-------|---------|
| **Server** | Infra VM | `routes.ts`, `store.ts` | HTTP API + persistence |
| **Client** | Agent VMs | `tools.ts`, `behaviors.ts` | LLM tools + automatic behaviors |

Modules that only have server-side code (no tools, behaviors, or widget) are automatically excluded from the pi extension.

## Step-by-Step

### 1. Create the directory

```bash
mkdir -p services/your-service
```

### 2. Write the store (`store.ts`)

The store owns all data and persistence. Two patterns exist:

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
- Throw typed errors (`ValidationError`, `NotFoundError`) — routes catch these for proper HTTP status codes

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

Routes are **bearer-auth protected by default**. If your service needs unauthenticated access (like the UI), set `requiresAuth: false` in the module definition.

### 4. Write the tools (`tools.ts`)

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
      // Always check for base URL first
      if (!client.getBaseUrl()) return client.noUrl();

      try {
        const result = await client.api("POST", "/your-service", {
          ...params,
          agent: client.agentName,  // Tag data with the calling agent
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
- `client.api(method, path, body?)` — authenticated HTTP call to the fleet server
- `client.agentName` — this agent's name (from `VERS_AGENT_NAME` env var)
- `client.vmId` — this agent's VM ID, if set
- `client.ok(text, details?)` — successful tool result
- `client.err(text)` — error tool result
- `client.noUrl()` — standard error when `VERS_INFRA_URL` is not set

### 5. Write behaviors (`behaviors.ts`) — optional

Behaviors are automatic event handlers that run without the LLM deciding to call them. Use for:
- Auto-publishing events on agent lifecycle (start, end, turn)
- Heartbeats and periodic tasks
- Reacting to other extensions' events

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { FleetClient } from "../src/core/types.js";

export function registerBehaviors(pi: ExtensionAPI, client: FleetClient) {
  // React to agent lifecycle
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

  // React to events from other extensions
  pi.events.on("vers:agent_spawned", async (data) => {
    // cross-extension coordination
  });
}
```

Behavior conventions:
- **Always guard** with `if (!client.getBaseUrl()) return` — agents may not have infra configured
- **Always try/catch** — a behavior error should never crash the agent
- **Clean up timers** on `session_shutdown`
- Use `pi.on()` for agent lifecycle events, `pi.events.on()` for cross-extension events

### 6. Write the module definition (`index.ts`)

This ties everything together. It's what the discovery system loads.

```ts
import type { ServiceModule } from "../src/core/types.js";
import { YourStore } from "./store.js";
import { createRoutes } from "./routes.js";
import { registerTools } from "./tools.js";
import { registerBehaviors } from "./behaviors.js";  // optional

const store = new YourStore();

const yourService: ServiceModule = {
  name: "your-service",              // URL prefix: /your-service/*
  description: "What this service does",

  // Server side
  routes: createRoutes(store),
  store,                              // Exposed for graceful shutdown (flush/close)

  // Client side (omit if server-only)
  registerTools,
  registerBehaviors,                  // optional

  // Optional: init hook for cross-module wiring
  init(ctx) {
    // Subscribe to events from other modules
    ctx.events.on("board:task_created", (data) => {
      // react to board changes
    });

    // Access another module's store directly (server-side only)
    const feedStore = ctx.getStore("feed");
  },

  // Optional: dependency ordering
  dependencies: ["feed"],            // This module loads after "feed"

  // Optional: widget contribution (shown in agent status bar)
  widget: {
    async getLines(client) {
      try {
        const res = await client.api("GET", "/your-service/stats");
        return [`YourService: ${res.count} items`];
      } catch { return []; }
    },
  },
};

export default yourService;
```

### 7. Test it

Start the server — your module should appear automatically:

```bash
bun run src/main.ts
```

Check the health endpoint:

```bash
curl http://localhost:3000/health
# Your service should be in the services list
```

Test your routes directly:

```bash
# Create
curl -X POST http://localhost:3000/your-service \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"field": "value"}'

# List
curl http://localhost:3000/your-service \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

## ServiceModule Interface Reference

```ts
interface ServiceModule {
  name: string;                    // Route prefix, must be unique
  description?: string;            // Shown in server startup log

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

  // Metadata
  dependencies?: string[];         // Load after these modules
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

### Using enums in tool parameters

```ts
import { StringEnum } from "@mariozechner/pi-ai";

const STATUS = StringEnum(
  ["active", "paused", "archived"] as const,
  { description: "Item status" },
);

// In tool parameters:
parameters: Type.Object({
  status: Type.Optional(STATUS),
})
```

## Checklist

Before considering the service done:

- [ ] `index.ts` default-exports a `ServiceModule`
- [ ] `name` is unique across all services
- [ ] Store handles missing `data/` directory (creates it)
- [ ] Routes return proper HTTP status codes (201 for create, 400 for validation, 404 for not found)
- [ ] Tools are prefixed with the service name (`servicename_verb`)
- [ ] Tool descriptions explain *when* to use them
- [ ] Every tool checks `client.getBaseUrl()` before making API calls
- [ ] Behaviors are wrapped in try/catch
- [ ] Behaviors clean up timers on `session_shutdown`
- [ ] Server starts and shows the new service in `/health`
- [ ] Routes work via curl
