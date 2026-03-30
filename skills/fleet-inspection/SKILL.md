---
name: fleet-inspection
description: Use when inspecting the live fleet, differentiating active vs historical lineage, tracing ancestry, checking subtree state, or doing post-mortem investigation.
---

# Fleet Inspection

Use this skill when you need to understand what is live now versus what happened earlier.

## Active vs history

Operational default:
- use active views for live work
- use history-explicit views only when auditing, tracing lineage, or reading old generations

Examples:
- `vm_tree_view()` -> active fleet
- `vm_tree_view({ includeHistory: true })` -> active + historical lineage
- `reef_fleet_status()` -> live operational children

## What the views mean

Active view answers:
- what is alive or operationally relevant now
- what can still act right now

History view answers:
- what happened before
- what stopped, rewound, or was superseded
- what lineage existed even if it is no longer live

## Promoted infrastructure

Running `resource_vm` instances may still appear in the active view even if the parent subtree is historical.

This is a rendering/operational behavior.
It does not mutate stored lineage.

Use history-inclusive views if you need the original parent-child structure.

## Post-mortem

For stopped descendants:
- use history-inclusive tree views
- read logs explicitly for post-mortem
- keep lineage and artifacts intact

Do not confuse:
- hidden from active view
- with deleted or unavailable for audit
