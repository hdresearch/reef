# registry

VM service discovery for agent fleets. Agents register themselves with a role, address, and capabilities. Other agents discover peers by role. Heartbeats keep registrations alive.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/registry/vms` | Register a VM |
| `GET` | `/registry/vms` | List VMs (filter: `?role=`, `?status=`) |
| `GET` | `/registry/vms/:id` | Get a VM |
| `PATCH` | `/registry/vms/:id` | Update a VM |
| `DELETE` | `/registry/vms/:id` | Deregister a VM |
| `POST` | `/registry/vms/:id/heartbeat` | Send heartbeat |
| `GET` | `/registry/discover/:role` | Discover VMs by role |

## Tools

- `registry_list` — list VMs, optionally filter by role or status
- `registry_register` — register a VM with id, name, role, address, services
- `registry_discover` — find VMs by role (worker, lieutenant, etc.)
- `registry_heartbeat` — keep a registration alive

## Behaviors

Auto-registers and auto-heartbeats when running as part of a fleet.
