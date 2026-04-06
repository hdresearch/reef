---
name: code-delivery
description: "Use when doing code work that must be integration-friendly: branches, commits, tests, PR-ready receipts, owned paths, and parent-friendly handoff."
---

# Code Delivery

Use this skill when your task changes code, tests, build files, interfaces, or deployment behavior.

## Goal

Produce work that a parent can integrate and report upward without rereading the entire codebase.

## Repo Orientation Playbook

Before proposing architecture or decomposition:
- run `ls` or `tree`
- inspect top-level files
- identify the language, package manager, and build system
- identify test entrypoints
- read the README and relevant package/build manifests
- read repo-local `AGENTS.md`, `HANDOFF.md`, and equivalent handoff/spec docs if present
- only then decide whether to implement directly or decompose

Do not start with a long self-briefing. Start with concrete repo orientation.

After orientation, decide where the work belongs:
- small, coherent slice -> do it directly
- multi-subsystem build -> decompose
- support infrastructure or a side environment -> consider whether a child or `resource_vm` is warranted

For non-trivial repo builds, make the ownership decision early:
- who owns the main implementation slice
- who owns persistent operations
- who owns support infrastructure

Root should not remain the implicit main worker while those decisions are still vague.

For repo implementation requests, assume the output should run outside Reef root unless the user explicitly asked to extend Reef itself.
Root's default role is to orient, delegate, supervise, and integrate. Do not make root the default home for the product you are building.

Before building a UI or service, choose the deployment target explicitly:
- Reef-root control-plane module
- separate VM or service as product/application infrastructure

Default to the separate VM path unless the work is clearly part of Reef's own operator UI or control plane.

If the task includes standing up and exposing a product/application service, use `skills/app-deployment/SKILL.md`.

## Branch And Commit Discipline

- for non-trivial code work, use meaningful save points
- commit before risky refactors or broad integration work
- keep commit messages descriptive enough that a parent can understand the shape of the work

Do not create chaotic local state and call it progress.

## Ownership

Work inside your assigned ownership boundary:
- owned paths
- owned module
- owned interface

If you discover that the assigned boundary is wrong:
- log it
- signal it
- do not silently sprawl into sibling-owned areas unless the parent explicitly told you to integrate there

## Test Strategy

Run the cheapest truthful verification that matches the task:
- narrow unit tests for narrow code changes
- targeted integration tests for interface changes
- wider suites when you are the parent integrating child outputs

When you cannot run the right test:
- say so
- explain why
- state what you did run instead

## What Done Must Include

When you report upward, include:
- files changed
- tests run and results
- branch or commit if relevant
- PR URL if relevant
- unresolved risks
- whether you are remaining idle or stopping

If your parent cannot continue without reopening the same files you just worked in, your receipts are too weak.

## Parent Integration Rule

Parents own integration.

Children should:
- deliver their slice
- expose receipts
- state constraints and risks

Parents should:
- collect receipts
- integrate slices
- fix cross-slice issues
- run higher-level tests
- report upward

Do not pretend that delegation alone solves integration.

## Recursive Code Work

If your assigned code slice still contains multiple independent subsystems:
- decompose further using `skills/decompose/SKILL.md`

If it is one coherent implementation slice:
- do the work yourself

Recursion is for structural separation, not for avoiding responsibility.

## Repo-Local Guidance First

If the repo contains local guidance, treat it as first-class planning input before architecture or decomposition decisions.

Typical high-value files:
- `AGENTS.md`
- `HANDOFF.md`
- `docs/working/handoffs/`
- `docs/working/subspecs/`
- repo-specific runbooks, architecture notes, or demo-scope docs

Do not infer the product from directory names alone if the repo already explains itself.
