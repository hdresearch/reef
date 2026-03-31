---
name: decompose
description: Use when a task has multiple independent subsystems, needs recursive delegation, or requires a parent to split implementation and then integrate the results.
---

# Recursive Task Decomposition

Use this skill when the task is too broad for one agent to finish cleanly without turning into a muddled giant workstream.

## The Rule

If the task has more than one independent subsystem, decompose it.

If it is one coherent module or slice you can finish cleanly yourself, do it yourself.

Independent subsystems usually have:
- separate owned paths or modules
- separate test boundaries
- separate interfaces or contracts
- limited need for overlapping edits

Examples:
- parser vs planner vs execution engine
- auth vs billing vs scheduler
- backend API vs frontend integration vs test harness

Do not create one fat child that owns multiple unrelated subsystems just because it is convenient.

## When Decomposition Helps

Decompose rather than implementing locally when any of these are true:
- the task spans multiple modules or subsystems
- the task mixes infrastructure/bootstrap work with application code
- multiple languages, runtimes, or toolchains are involved
- long-running trial-and-error or test-heavy iteration is likely
- the work benefits from a durable coordinator plus separate owned slices

Root should orient first, then decide whether the smallest effective next step is:
- a bounded local probe
- direct implementation of one coherent slice
- or decomposition into children

For non-trivial repo builds, root should assign the first implementation owner early and delegate the main implementation path by default.
Do not let root remain the implicit worker just because no child has been chosen yet.

For repo implementation work, orientation should include repo-local handoff material when present:
- `AGENTS.md`
- `HANDOFF.md`
- `docs/working/handoffs/`
- `docs/working/subspecs/`

## Parent Responsibilities

Parents own:
- deciding whether to decompose
- choosing child type
- assigning clean ownership
- integrating child outputs
- resolving cross-child conflicts
- running parent-level verification
- reporting upward with receipts

Do not delegate integration and then disappear. Recursive decomposition works only if each parent remains accountable for the slice it decomposed.

## Choose The Right Child Type

- `lieutenant`
  - use for a durable subtree coordinator
  - best for a major area that may need multiple children, repeated follow-up, or ongoing integration

- `agent_vm`
  - use for a cohesive autonomous workstream
  - best for a bounded module that may still need its own children

- `swarm_vm`
  - use for short parallel leaf work
  - best for burst checks, narrow edits, grep/review fan-out, or clearly separable leaf slices

- `resource_vm`
  - use for infrastructure, not implementation labor
  - databases, services, test rigs, webhook sinks, build machines
  - use when the task clearly needs separate support infrastructure or a side environment

For ongoing operational systems, prefer durable ownership:
- use a `lieutenant` to own the operating loop
- use a `resource_vm` for persistent stateful infrastructure
- let root supervise and integrate rather than becoming the permanent operator or default builder

## How To Spawn In The Current Reef Model

Use Reef-native tools, not raw Vers APIs.

### Root spawning a major subtree
- `reef_lt_create(...)`
- `reef_lt_send(...)`

### Lieutenant or agent spawning a cohesive child workstream
- `reef_agent_spawn(...)`
- later reuse with `reef_agent_task(...)` if the child is alive and idle

### Any agent spawning parallel leaf workers
- `reef_swarm_spawn(...)`
- `reef_swarm_task(...)`
- `reef_swarm_wait(...)`

### Infrastructure support
- `reef_resource_spawn(...)`

## Child Task Packet

Every delegated task should include the same packet shape.

Required fields:
- **objective** — what this child is responsible for delivering
- **owned path/module** — the write scope
- **interfaces/contract** — what the child must expose or preserve
- **dependencies** — what siblings/parent provide or expect
- **done criteria** — how the parent will judge completion
- **test expectation** — what to run or what evidence to provide if tests are deferred
- **post-task disposition** — `stay_idle` or `stop_when_done` if you care
- **recursion expectation** — whether the child should recurse further if it finds multiple subsystems

If a child packet does not make ownership and done criteria obvious, fix the packet before spawning.

## Ownership Rules

- assign clean write scopes
- avoid overlapping edits unless the parent explicitly owns the integration boundary
- if two children must touch the same file, that is usually a sign the decomposition is wrong

Parents should decompose by interfaces and paths, not by vague themes.

## Recursion Rule

Children may recurse further if their assigned slice still contains multiple independent subsystems.

They should use the same rules:
- if one coherent slice -> do it
- if multiple independent slices -> decompose further

Root should not directly spawn every leaf. Major parents should own their subtree and recurse downward as needed.

## Ownership Discipline

Once a parent assigns a slice to a child, that slice belongs to the child until the parent changes ownership explicitly.

Do not silently bypass a live child and do the same work yourself. If the current plan is wrong:
- steer the child
- replace the child
- or reclaim the slice explicitly and log or signal why

Ownership should be assigned early enough that implementation does not start in an ambiguous state.
For repo builds, identify early:
- who owns the main implementation slice
- who owns persistent operations
- who owns support infrastructure

If execution path changes without an ownership change, scheduled checks, receipts, and supervision state become misleading.

## Do Not Decompose By Superficial Multiplicity

Do not spawn extra children just because there are multiple repos, sources, or entities involved.

Decompose by:
- write boundaries
- interfaces
- operational independence
- real concurrency opportunities

Do not force swarm-style parallelism onto workloads whose storage or integration layer is fundamentally serial.

## Waiting And Coordination

Use the current Reef primitives:
- `reef_inbox_wait` for child message arrival in the current turn
- `reef_store_wait` for barriers/readiness state
- `reef_swarm_wait` for swarm completion
- `reef_schedule_check` for attention that must outlive the current turn

Do not invent polling loops if the existing primitives already match the problem.

## Integration After Children Finish

After child work returns:
1. read the receipts from each child
2. collect changed files, branches, store keys, logs, or artifact pointers
3. wire modules together
4. resolve integration issues in the parent-owned boundary
5. run higher-level verification
6. report upward with enough receipts that your parent does not need to rediscover everything

If children produce overlapping or contradictory work, that is the parent’s integration problem.

## Reporting Expectations

Child `done` should include:
- files changed
- tests run and result
- artifact pointers
- unresolved risks
- whether the child remains alive/idle or stopped

Read `skills/reporting-checkpointing/SKILL.md` for the reporting shape.

## Escalation And Recovery

If a child fails:
- inspect its output
- decide whether to retry, steer, replace, or absorb the work yourself

If decomposition is clearly making the task worse:
- stop adding more children
- collapse the work back upward
- log the decision and continue with a simpler plan

Recursive decomposition is a tool, not a ritual.
