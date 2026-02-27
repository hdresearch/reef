# services

Runtime service manager. List, reload, unload, and export modules without restarting the server.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/services` | List all loaded modules |
| `GET` | `/services/manifest` | Machine-readable manifest of all capabilities |
| `POST` | `/services/reload` | Re-scan services directory and reload everything |
| `POST` | `/services/reload/:name` | Reload a single module by directory name |
| `GET` | `/services/export/:name` | Download a service as a tarball |
| `DELETE` | `/services/:name` | Unload a module |

## Manifest

`GET /services/manifest` returns everything an agent needs to discover what reef can do:

```json
{
  "services": [
    {
      "name": "board",
      "description": "Shared task tracking for agent fleets",
      "dependencies": [],
      "capabilities": ["routes", "tools", "behaviors", "panel"],
      "routes": {
        "POST /tasks": { "description": "Create a task", "body": { ... } },
        "GET /tasks": { "description": "List tasks", "query": { ... } }
      }
    }
  ],
  "routes": [
    { "service": "board", "method": "POST", "path": "/board/tasks", "description": "Create a task" }
  ],
  "servicesWithTools": ["board", "feed", "log"],
  "servicesWithBehaviors": ["feed", "registry"],
  "servicesWithPanels": ["board", "feed"],
  "count": 8
}
```

Designed for agents, not humans. Use this to discover what exists before building something new.

## How it works

- `GET /services` returns `{ modules: [...], count }` with name, description, and capabilities for each module
- `POST /services/reload` re-scans the services directory — new modules are loaded, deleted ones are removed, existing ones are refreshed
- `POST /services/reload/:name` reloads a single module (useful after editing files)
- `GET /services/export/:name` tars the module directory — used by fleet-to-fleet install
- `DELETE /services/:name` unloads a module from memory (doesn't delete files)
- You can't unload the services manager itself (`DELETE /services/services` is rejected)
