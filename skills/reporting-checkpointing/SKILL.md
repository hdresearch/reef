---
name: reporting-checkpointing
description: Use when signaling done/blocked/failed, reporting artifacts upward, or deciding whether to create a checkpoint before risky or meaningful state transitions.
---

# Reporting And Checkpointing

Use this skill when you are about to finish, fail, block, or checkpoint meaningful work.

## Reporting upward

When signaling `done`, include artifact pointers that let your parent continue without guessing:
- PR URL or branch
- commit SHA
- store keys
- file paths
- VM/service identifiers when infrastructure is involved

When signaling `blocked` or `failed`, include:
- what you tried
- what failed
- what partial work exists
- where the parent should look next

## Reporting rule

Do not optimize for a clean-looking signal.
Optimize for handoff quality.

Before you send your final `done`, do one bounded inbox catch-up. If new parent/child/peer attention arrived after you finished the main task, either handle a small in-scope follow-up immediately or mention it explicitly in your final signal.

## Checkpointing

Use `reef_checkpoint` when:
- you reached a meaningful phase boundary
- the current state is expensive to reproduce
- a risky next step could invalidate valuable progress

General guidance:
- lieutenants: checkpoint at real coordination milestones
- agent VMs: checkpoint when the work has expensive or meaningful phases
- swarm workers: usually do not checkpoint unless the task is unusually long-lived or expensive

## Coordination with parent

If a parent may need to recover or replace you later, make sure your signal and your checkpoint together are enough to reconstruct the situation.
