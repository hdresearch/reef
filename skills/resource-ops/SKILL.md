---
name: resource-ops
description: Use when spawning, configuring, auditing, or retiring resource VMs that host infrastructure such as databases, services, test environments, or webhook-facing systems.
---

# Resource Operations

Use this skill when the task needs infrastructure rather than another disposable worker.

## What a resource VM is

A `resource_vm` is passive infrastructure:
- database
- service
- build host
- test environment
- webhook sink
- other support system

It is not a token/cost usage entity.

## Lifecycle default

`resource_vm` is protected-by-default.

Do not tear it down just because:
- the creating agent finished
- the parent subtree went historical
- the immediate task is done

Teardown should be:
- explicit user direction
- explicit owner policy
- or explicit root policy

## Recommended flow

1. spawn the resource VM
2. SSH into it with `vers_vm_use`
3. configure and verify the service
4. leave clear markers:
   - ports
   - processes
   - file paths
   - access instructions
5. signal upward with enough detail for reuse or cleanup

## What to report

When done setting up infrastructure, report:
- VM name
- VM ID
- what is running
- how to connect to it
- whether it should persist after this task

If you intentionally tear it down, say that it was explicit teardown, not incidental lifecycle cleanup.
