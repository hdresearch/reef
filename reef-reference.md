# Reef Reference

Loaded on orient. Not memorized. Consult when needed. This is the operations manual.

---

## Core Primitives

| Primitive | Purpose |
|-----------|---------|
| `reef_inbox` | Read messages already waiting |
| `reef_inbox_wait` | Wait briefly for message arrival inside the current turn |
| `reef_signal` | Send upward status or completion |
| `reef_command` | Control work you own |
| `reef_peer_signal` | Coordinate laterally with siblings |
| `reef_store_*` | Shared durable coordination state |
| `reef_store_wait` | Wait on shared state or barriers |
| `reef_schedule_check` | Future attention that survives after the current turn |
| `reef_swarm_wait` | Authoritative swarm completion path after `reef_swarm_task` |
| `reef_github_token` | Mint scoped GitHub auth for repo/PR work |
| `reef_log` / `reef_logs` | Structured receipts and debugging |
| `reef_checkpoint` | Save a meaningful machine state |
| `vers_vm_use` / `vers_vm_copy` | Low-level VM access and file movement |

Parent-facing tasking surface:

- `reef_lt_send` for lieutenants
- `reef_agent_task` for alive idle agent VMs
- `reef_swarm_task` for swarm workers
- `reef_command(... type: "steer")` for in-flight changes

---

## Categories

| Category | Role | Default disposition |
|----------|------|-------------------|
| `infra_vm` | Root orchestrator | Protected |
| `lieutenant` | Durable subtree coordinator | Stay idle |
| `agent_vm` | Cohesive autonomous workstream | Stop when done |
| `swarm_vm` | Short parallel leaf worker | Stop when done |
| `resource_vm` | Infrastructure (not an agent worker) | Protected |

Choose child type by work shape:

- **lieutenant** — subtree needing ongoing coordination or repeated follow-up
- **agent_vm** — bounded module that may still recurse
- **swarm_vm** — short leaf work or burst parallelism
- **resource_vm** — infrastructure only

---

## Authority Model

There are three communication modes:

- **upward** — `reef_signal`
  - child -> parent
  - completion, progress, blocked, failed, checkpoint
- **downward** — `reef_command`
  - ancestor -> descendant
  - steer, pause, resume, abort
- **lateral** — `reef_peer_signal`
  - same-parent siblings
  - coordination only, not authoritative control

Use the tree for authority, peer signals for coordination, store for synchronization, and scheduled checks for future attention.

Siblings may:
- request
- warn
- hand off artifacts
- coordinate sequencing

Siblings may not authoritatively steer, pause, resume, abort, or retask each other. If a sibling needs another sibling's work to change urgently, escalate to the common parent.

---

## Child State Model

| State | Meaning |
|-------|---------|
| `working` | Alive, executing, steerable |
| `idle` | Alive, available, reusable for new bounded task |
| `paused` | Alive but suspended; resume before assigning active work |
| `stopped` / `destroyed` | Not a live task target |

Category changes default lifecycle, not the meaning of the states.

---

## Post-Task Disposition

Resolution order:

1. **Explicit parent disposition** — `stay_idle` or `stop_when_done`
2. **Category default** — lieutenant stays idle; agent/swarm stop
3. **Final inbox/context override** — if a concrete reason to remain alive appears during final catch-up, remaining idle is valid

---

## Lifecycle Policy

**Protected:** root `infra_vm`, `resource_vm` by default.

**Normal disposable:** `lieutenant`, `agent_vm`, `swarm_vm`.

Do not destroy root casually. Do not tear down `resource_vm` without an explicit teardown decision.

---

## Recursive Self-Assembling Fleets

Reef's operating model is recursive self-assembly. Every task flows through the fleet tree. Parents plan and delegate; children implement or recurse further. No agent grinds through independent subsystems sequentially when they could be parallelized across children.

### The universal planning cycle

Every parent -- root, lieutenant, agent_vm acting as parent -- follows the cycle:

1. Orient -- understand the task, read relevant files, check existing state
2. Delegation gate -- "Who will do this work?" Must be answered before implementation begins.
3. Spawn -- create children with clean task packets (see decompose skill)
4. Supervise -- monitor signals, steer on drift, unblock on blocked
5. Integrate -- collect child outputs, wire together, resolve conflicts
6. Verify -- run parent-level checks (higher-level tests, integration tests, manual inspection)
7. Report -- signal upward with receipts

### Role-specific rules

| Role | Plans & delegates? | Implements directly? | When to recurse further |
|------|-------------------|---------------------|------------------------|
| Root | Always | Never (orchestration only) | Every implementation task gets a child |
| Lieutenant | Yes, for its subtree | May implement small coordination logic | When assigned scope has independent subsystems |
| Agent VM | Yes, when scope warrants | Yes, for coherent bounded slices | When discovering independent parts within assigned slice |
| Swarm worker | No (leaf node) | Yes, that's the job | Never -- signal blocked if scope is too large |

### Root's permitted actions

| Action | Permitted? |
|--------|-----------|
| Read repo files for orientation | yes |
| Small diagnostic probe (< 5 min) | yes, to unblock delegation decisions |
| Spawn / task / steer / abort children | yes, core job |
| Verify child output | yes, core job |
| Edit Reef control-plane code | yes, only for Reef itself |
| `vers_vm_use` + application commands | no, delegate |
| Edit application source files | no, delegate |
| Install application dependencies | no, delegate |
| Debug application failures | no, delegate |

### How children self-assemble

Children inherit `AGENTS.md` and apply the same planning cycle recursively:

- An `agent_vm` that needs infrastructure spawns a `resource_vm`
- An `agent_vm` that finds multiple independent subsystems decomposes into sub-agents or a swarm
- A lieutenant that coordinates a multi-part system spawns agents per subsystem and a `resource_vm` for shared infrastructure
- A swarm worker that discovers its task is too large signals blocked -- it does not silently expand scope

No agent needs permission from its parent to recurse. The planning cycle and fleet assembly patterns apply at every level of the tree. The only constraint: stay within your assigned scope.

### Task packets drive assembly

Every delegated task includes:

- objective -- what to deliver
- owned scope -- files, modules, or systems the child writes/deploys
- context -- what the parent learned during orientation (repo structure, build system, key files, gotchas)
- done criteria -- how parent will verify completion
- recursion expectation -- "you may spawn sub-agents if your slice has independent parts"

The context block is critical. Parent orientation work should be distilled into the task packet so children don't repeat it. Include: repo URL, build system, key dependencies, known issues discovered during orientation.

### Depth guidance

The fleet tree can go as deep as the task requires, but each level should add value:

| Depth | Typical role | Example |
|-------|-------------|---------|
| 0 | Root | User says "build the platform" |
| 1 | Lieutenant or `agent_vm` | "Own the data pipeline" / "Own the web frontend" |
| 2 | `agent_vm` or swarm | "Build the ETL module" / "Implement these 5 API endpoints" |
| 3 | Swarm or `agent_vm` | "Write tests for each endpoint" / "Configure each data source" |

Stop recursing when:
- The slice is one coherent piece a single agent can finish cleanly
- Further decomposition would create more coordination overhead than it saves
- The slice is pure leaf work (tests, config, single-file edits)

Keep recursing when:
- The slice has independent subsystems with separate write boundaries
- Sequential execution would take significantly longer than parallel
- The work mixes fundamentally different concerns (infra vs app code, frontend vs backend)

### Common anti-patterns

| Anti-pattern | Fix |
|-------------|-----|
| Root "just quickly" implements on a VM | Spawn `agent_vm`, include instructions in task |
| Root orients then implements without delegating | Mandatory delegation gate after orientation |
| Parent delegates but also shadows child's work | Trust child; verify output, don't redo work |
| Child does everything sequentially when parts are independent | Child should recurse and spawn sub-agents |
| Agent spawns `resource_vm` and also acts as the `resource_vm` | Keep roles clean: agent builds, resource hosts |
| Non-root parent grinds through 3 subsystems in sequence | Apply independence test, decompose into children |
| Every task spawns max-depth fleet regardless of size | Use smallest fleet shape that fits; single coherent slice -> one agent |
| Swarm worker discovers huge scope, keeps going silently | Signal blocked -- leaf nodes don't expand scope |

### Product code placement

Product/application code, services, and UIs deploy outside Reef root unless the task is explicitly extending Reef itself. Root service creation is reserved for Reef control-plane features.

For long-lived deployed systems, assign clear ownership early:
- `resource_vm` = host / stateful infrastructure
- `agent_vm` = builder / implementation / deploy preparation
- `lieutenant` = persistent operator / maintainer

---

## Target Semantics

Address logical agents by name, not raw VM ID, unless you need SSH or low-level debugging.

- Active names resolve to the current live incarnation
- History is for audit and post-mortem work
- If a logical child should exist but has no live incarnation, the owning parent recreates or replaces it

---

## Behavioral Rules

- Do not go silent. Signal `done`, `blocked`, `failed`, or meaningful progress.
- Do not poll blindly when an existing wait primitive fits.
- Do not use peer coordination as an authoritative control channel.
- Do not keep a turn open just to keep watching; externalize future attention and end the turn.
- Never push directly to `main`.
- Do not fake work, tests, or comprehension.

---

## Skills Index

| Skill | Use it for |
|-------|-----------|
| `skills/decompose/SKILL.md` | Recursive decomposition, child-type choice, ownership boundaries |
| `skills/code-delivery/SKILL.md` | Repo orientation, implementation flow, testing, integration receipts |
| `skills/app-deployment/SKILL.md` | Product/application deployment outside Reef root |
| `skills/github-ops/SKILL.md` | GitHub repo prep, branch discipline, PR flow, auth/token use |
| `skills/command-handling/SKILL.md` | Steer / pause / resume / abort playbook |
| `skills/reporting-checkpointing/SKILL.md` | Done / blocked / failed reporting and checkpointing |
| `skills/coordination-patterns/SKILL.md` | Store barriers, inbox waits, sibling coordination, swarm completion |
| `skills/root-supervision/SKILL.md` | Root supervision and fleet continuity |
| `skills/fleet-inspection/SKILL.md` | Active vs history inspection and post-mortem tracing |
| `skills/resource-ops/SKILL.md` | Resource VM lifecycle and infrastructure handling |
| `skills/scheduled-orchestration/SKILL.md` | Deferred follow-up and durable orchestration attention |
| `skills/logs-debugging/SKILL.md` | Logs browser workflow and debugging |
| `skills/create-service/SKILL.md` | Creating a new Reef service |

Reef repo root is usually:

- root image: `/opt/reef`
- child images: `/root/reef`
