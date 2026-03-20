# reef

Reef is the root control plane for a Vers agent fleet.

It runs the root Reef server, owns the global registry/vm-tree/commits state, manages remote lieutenants, serves the `/ui`, and provides the child-safe Reef tools that golden-image child VMs use to talk back to the root.

## Current Architecture

- `vers-fleets` bootstraps only the root Reef infra VM
- `reef` owns the runtime control plane
- `pi-vers` provides the Vers extensions Reef-managed agents load into the `punkin` harness
- `punkin-pi` `w/router` is the harness used on the root and child agent VMs

After bootstrap, Reef is responsible for:

- ensuring a golden image exists
- creating lieutenants from that golden image
- tracking lineage in `vm-tree`
- tracking liveness/discovery in `registry`
- managing golden commits in `commits`
- serving the root UI and conversation system

## VM Roles

Root Reef VM:

- runs the Reef server
- owns SQLite-backed services like `registry`, `vm-tree`, and `commits`
- is the only global authority
- defaults its own task runner to `claude-opus-4-6-thinking`

Child agent VMs:

- are restored from the golden image at runtime
- do not run their own Reef server
- use `punkin` as the harness
- install `pi-vers`
- install the Reef client extension
- point back to the root Reef via `VERS_INFRA_URL`

Lieutenants are branch managers. Workers are execution nodes. Global control-plane authority stays on the root.
Lieutenants default to `claude-opus-4-6-thinking`. Swarm workers default to `claude-sonnet-4-6`.

## Child Tool Surface

Reef now scopes child tools intentionally.

All child VMs get:

- `reef_self`
- `reef_parent`

Lieutenants additionally get:

- `reef_lt_children`
- `reef_lt_subtree`
- `reef_lt_worker_capacity`

Child VMs do not expose raw global `registry`, `vm-tree`, `commits`, or lieutenant-lifecycle tools locally.

## Conversations And UI

The `/ui` is a 3-column root control-plane interface:

- left: conversation list and create-chat flow
- middle: active conversation
- right: activity feed

Conversations are persisted on disk:

- metadata lives in Reef task/tree state
- message transcripts are appended as JSONL under `REEF_DATA_DIR/conversations/<conversationId>.jsonl`

Closing a conversation archives it from the active list without deleting it.

## Important Services

Root-only control-plane services include:

- `commits`
- `registry`
- `vm-tree`
- `lieutenant`
- `services`
- `ui`
- `vers-config`
- `bootloader`

The `bootloader` now matters only for root/infra bootstrap and related recovery flows. Normal child-agent provisioning should come from Reef golden-image runtime flows, not from bootloader-generated child scripts.

## Golden Image Contract

The current golden image for child agent VMs is expected to contain:

- `punkin-pi` `w/router`
- `pi` symlinked to `punkin`
- local `pi-vers` install
- Reef client extension install
- child env pointing at the root Reef:
  - `VERS_INFRA_URL`
  - `PI_VERS_HOME`
  - `SERVICES_DIR`
- no local child Reef server
- RPC-ready runtime for lieutenants and workers
- source checkouts for inspectability:
  - `/root/punkin-pi`
  - `/root/pi-vers`
  - `/root/reef`

Golden creation also adds VM-local compatibility aliases for legacy `@mariozechner/*` Pi packages so they can still load under `punkin`.

## Development

```bash
bun install
bun test
bun run start
```

Useful env:

- `VERS_AUTH_TOKEN`
- `LLM_PROXY_KEY`
- `VERS_VM_ID`
- `VERS_INFRA_URL`
- `SERVICES_DIR`
- `REEF_DATA_DIR`

## Notes

- Root Reef is the only SQLite authority in the fleet.
- `vers-fleets` is bootstrap-only after the root comes up.
- Child lieutenants and workers should be created from Reef runtime flows, not pre-bootstrapped externally.
