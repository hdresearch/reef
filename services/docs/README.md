# docs

Auto-generated API documentation. Discovers all loaded services and their `routeDocs` metadata, renders a browsable HTML UI and JSON API.

No auth required — docs are public by default.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/docs` | All services as JSON |
| `GET` | `/docs/ui` | Browsable HTML documentation |
| `GET` | `/docs/:service` | Docs for a single service |

## How it works

Services opt into docs by adding a `routeDocs` field to their module export:

```ts
export default {
  name: "my-service",
  routes,
  routeDocs: {
    "GET /items": {
      description: "List all items",
      params: { limit: { description: "Max results", default: "50" } },
      response: "{ items, count }",
    },
    "POST /items": {
      description: "Create an item",
      body: "{ name, tags? }",
      response: "{ id, name, createdAt }",
    },
  },
};
```

The docs service scans `ctx.getModules()` at render time, so new modules appear immediately after loading.
