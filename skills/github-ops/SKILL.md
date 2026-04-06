---
name: github-ops
description: Use when working with GitHub repos, branch setup, auth tokens, PR flow, or repo preparation inside Reef.
---

# GitHub Operations

Use this skill when the task involves cloning or preparing a repo, branching, pushing, opening PRs, or working with GitHub-scoped auth.

## Goal

Treat GitHub workflow as a procedure, not as part of the always-on constitution.

## Repo Preparation

Before proposing architecture or decomposition:
- use `reef_git_prepare` to clone or prepare the repo if Reef already has a helper for it
- then use `ls` or `tree`
- inspect top-level files
- identify language, package manager, build system, and test entrypoints
- read the README and key manifests

Do not start with a long self-briefing. Start by preparing and understanding the repo.

## Auth

Use `reef_github_token` with the narrowest profile that does the job:
- `read` for inspection
- `develop` for branches, pushes, and normal implementation work
- `ci` only when CI-scoped operations are actually needed

Do not mint broad credentials casually.

## Branch Discipline

- never push directly to `main`
- prepare a task branch before meaningful implementation work
- use clear branch names that reflect the slice of work
- keep save points before risky refactors or large integration steps

## PR Discipline

When the work is PR-shaped, provide enough for a parent or operator to continue cleanly:
- branch name
- commit(s)
- tests run and results
- unresolved risks
- PR URL if created

If a PR is not ready, say what is missing instead of implying completion.

## Relationship To Other Skills

- use `skills/code-delivery/SKILL.md` for implementation, testing, and parent-friendly receipts
- use `skills/decompose/SKILL.md` when the repo task needs recursive delegation
- use `skills/reporting-checkpointing/SKILL.md` when reporting upward after GitHub/code work
