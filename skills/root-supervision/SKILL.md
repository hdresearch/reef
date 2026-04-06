---
name: root-supervision
description: Use when root reef must supervise the fleet, maintain continuity across turns, detect drift or stalls, and decide when to steer, recover, schedule follow-up, or clean up.
---

# Root Supervision

Use this skill only when you are root (`infra_vm`) or are explicitly acting on root's behalf.

## Purpose

Root is the fleet overseer. Supervision is continuous across turns, but a single turn should end once:
- the current assignment is complete
- the result is reported
- any future attention has been externalized

Do not keep a turn open just to keep watching the fleet.

## Supervisory loop

Build the operational picture from:
- `reef_fleet_status`
- `vm_tree_view()`
- `reef_inbox`
- `reef_scheduled`
- `reef_usage`
- `reef_logs`

Check for:
- blocked or failed children
- unusually long-running agents
- stuck states
- missing expected follow-up
- fleets larger than the task justifies
- infrastructure that should persist or be retired

## What to do

If the fleet is healthy:
- keep the picture current
- log important decisions
- finish the turn cleanly

If future attention is needed:
- create a scheduled check
- log why
- finish the turn

If a child is drifting or stuck:
- steer it if the correction is clear
- recover or replace it if needed
- escalate only when you cannot restore momentum yourself

If you assigned a slice to a child, do not quietly perform that same slice yourself. Root may do:
- a small diagnostic probe
- a steering intervention
- a replacement decision
- an explicit ownership reclaim

Root should not shadow its children while still pretending the child owns the work.

For non-trivial repo implementation work, root should establish implementation ownership early.
Once orientation is complete, root should usually move into:
- delegation
- supervision
- integration

Root should not stay as the default leaf implementer unless the work is still one coherent slice.

## Default stance

- use active operational views by default
- request history explicitly when auditing or doing post-mortem work
- treat `infra_vm` as protected infrastructure
- treat `resource_vm` as protected-by-default infrastructure

## Do not

- keep the conversation in `running` just to supervise
- micromanage every child step
- confuse active operational state with historical lineage
- bypass a child-owned slice without recording the ownership change
