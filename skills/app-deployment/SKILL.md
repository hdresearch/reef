---
name: app-deployment
description: Use when implementing and exposing a product/application service or UI that should run outside Reef root. Choose child/resource VM placement, stand up the app, and report how to reach it.
---

# App Deployment

Use this skill when the task is to build, run, or expose a product/application service or UI that is not clearly part of Reef's own operator control plane.

## Default Placement

For repo implementation requests, default deployment target is outside Reef root.

Typical choices:
- `agent_vm` for a cohesive implementation slice that owns its own runtime setup
- `lieutenant` for a persistent coordinator that owns an operational system
- `resource_vm` for stateful support infrastructure, raw environments, databases, or long-lived app hosting

Do not treat Reef root as the default home for the product you are building.

## Deployment Target Decision

Before you stand anything up, decide explicitly:

1. Is this a Reef control-plane feature?
   - Reef panel
   - Reef API/service module
   - operator-facing Reef UI

2. Or is it product/application infrastructure?
   - app UI
   - API server
   - dashboard
   - data pipeline runtime
   - webhook sink
   - background worker

Default to product/application infrastructure on a child VM unless the answer to (1) is clearly yes.

## Recommended Flow

1. Orient on the repo
2. Decide ownership and deployment target
3. Spawn the right child or infrastructure VM
4. Clone or prepare the repo there
5. Install only what that target needs
6. Run, validate, and expose the app there
7. Report back:
   - VM name and ID
   - repo path
   - ports or URLs
   - processes
   - how to restart or inspect it
   - whether it should persist

## Root's Role

Root should usually:
- prepare and understand the repo
- choose target placement
- delegate implementation/deployment
- supervise and integrate

Root should not usually:
- become the app host
- mutate or restart Reef services for product work
- mix control-plane changes with ordinary app deployment

## Ownership Discipline

If a child owns deployment, root should not quietly redo that deployment itself.

If the current execution path changes:
- steer the child
- replace the child
- or reclaim ownership explicitly

Then report the change so scheduled checks, receipts, and supervision state remain truthful.

## What Done Must Include

When reporting a deployed app or service, include:
- deployment target type (`agent_vm`, `lieutenant`, `resource_vm`)
- VM name and ID
- repo path
- branch or commit if relevant
- ports, URLs, and health endpoints
- start/restart commands if relevant
- tests or smoke checks run
- whether the target remains alive/idle or is stopping
