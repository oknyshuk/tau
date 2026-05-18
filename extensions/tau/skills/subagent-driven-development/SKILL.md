---
name: subagent-driven-development
description: Execute backlog-tracked work by dispatching agents per task or epic with two-stage review. Backlog is the spec — agents read it, implement it, get reviewed against it. Use when work is formalized in backlog and needs systematic execution.
---

# Subagent-Driven Development

## Overview

Execute backlog-tracked work by dispatching agents. Backlog items are the spec — the orchestrator does not repeat their content in delegation messages.

**Core principle:** Backlog is the source of truth. Agents read backlog. The orchestrator coordinates and keeps delegation terse.

## When to Use

- Backlog items exist with description, design, and acceptance criteria
- Work needs systematic execution with review gates
- Multiple tasks need coordinated delivery

## Orchestrator Ownership

The orchestrator (you) exclusively owns three things. Subagents must not touch them:

| Domain | Orchestrator does | Subagent does |
|---|---|---|
| **VCS (jj)** | `jj describe`, `jj squash`, hands off to user for `jj git push` | Reports what changed |
| **Review** | Spawns and manages reviewers | Gets reviewed, never self-reviews |
| **Backlog lifecycle** | Creates items, updates status, closes | Reads spec via `backlog show`, nothing else |

Subagents that discover unrelated bugs or issues report them back to the orchestrator. They do not fix unrelated problems — the orchestrator decides whether a follow-up backlog item is needed.

These boundaries are enforced at two levels:
1. Mode agent spawns exclude `review` and `plan` — subagents cannot spawn review or plan agents
2. Worker delegation prompt (injected into every subagent) states ownership rules explicitly

## Delegation Rules

### Backlog is the spec

Every delegation message references a backlog item ID. The agent reads the task with `backlog show <id>` to get description, design, and acceptance criteria. The orchestrator does NOT paste task content into the delegation prompt.

### No code in delegation

The orchestrator does not provide code snippets to implementer agents. Agents are skilled developers — they write the code.

**Exception:** Shared contracts (interfaces, enums, type shapes) that cross task boundaries and must match exactly MAY be included when the contract is not yet in the codebase.

### Minimal delegation message

A delegation message contains:
1. The backlog task ID (or epic ID for multi-task delegation)
2. Project-level context the agent cannot discover (test commands, gate commands, key conventions)
3. Constraints not in the backlog item (e.g., "do not change VCS state", "do not touch file X")

Nothing else. No restating the spec. No step-by-step instructions.

## Agent Selection

### One task, independent
`agent spawn smart` — fast, focused, clean context.

### One task, complex or cross-cutting
`agent spawn deep` — more reasoning, handles multi-file changes well.

### Multiple sequential tasks — reuse vs. fresh

The decision to reuse an agent or spawn a fresh one is about **context relevance**:

**Reuse** (`agent send`) when the next task touches the same files or area. The agent already has those files in context — it won't need to re-read them. This saves tokens and time, and the understanding it built from prior work directly helps the next task.

**Fresh** (`agent spawn`) when the next task is in a different area of the codebase. Accumulated context from unrelated files pollutes the agent's working memory and increases the chance of confusion or hallucination. A clean agent with focused context will be faster and more accurate.

Rule of thumb: if the agent would need to read mostly the same files for the next task, reuse it. If it would need to read entirely different files, spawn fresh.

```text
# Reuse: task 2 touches same files as task 1
agent spawn deep "Implement tau-abc.1 ..." -> impl
agent wait [impl]
agent send [impl] "Now implement tau-abc.2
Read the task: backlog show tau-abc.2"
agent wait [impl]

# Fresh: tasks touch different subsystems
agent spawn smart "Implement tau-abc.3 ..." -> impl-3
agent spawn smart "Implement tau-abc.4 ..." -> impl-4
agent wait [impl-3, impl-4]
```

### Review — same reuse logic

Reviewers follow the same rule. One reviewer can cover multiple tasks across an epic when they touch related code — it accumulates understanding of the area and catches cross-task regressions. Spawn a fresh reviewer when switching to unrelated code where prior context would not help.

`agent spawn review` — always a separate agent from the implementer.

## Per-Task Workflow

### Step 0: Claim

```bash
backlog update tau-abc123 --status in_progress
```

### Step 1: Dispatch Implementer

```text
agent spawn deep "Implement tau-abc123

Read the task: backlog show tau-abc123
Follow its description, design, and acceptance criteria.

Project context:
- Run gate: npm run gate
- Do not change VCS state (no `jj describe`, `jj squash`, or `jj git push`)
- If the spec is ambiguous, stop and ask before guessing"
```

```text
agent wait [impl_id]
```

### Step 2: Two-Stage Review

Spawn ONE reviewer per area of code. It handles spec compliance first, then code quality. If subsequent tasks touch the same area, reuse this reviewer via `send` — it already knows the code and catches cross-task regressions. Spawn a fresh reviewer when moving to unrelated code.

**Phase 1 — Spec compliance:**

```text
agent spawn review "Review tau-abc123 for spec compliance

Read the spec: backlog show tau-abc123
Check every acceptance criterion is met.

OUTPUT: PASS or list of specific gaps"
```

```text
agent wait [reviewer_id]
```

If gaps found → fix with implementer → `agent send` reviewer to re-check.

**Phase 2 — Code quality:**

```text
agent send [reviewer_id] "Spec is PASS. Review code quality for the same implementation.

CHECK: conventions, error handling, naming, test coverage, security, no scope creep.
OUTPUT: APPROVED or REQUEST_CHANGES with specifics"
```

```text
agent wait [reviewer_id]
```

If issues found → fix → `agent send` reviewer to re-check (both quality AND spec still holds).

Close reviewer after APPROVED:

```text
agent close [reviewer_id]
```

### Step 3: Mark Complete

```bash
backlog close tau-abc123 --reason "Implemented and reviewed"
```

## Multi-Task Sequential Example (related tasks, same area)

When tasks touch the same files/area — reuse both implementer and reviewer:

```text
[backlog update tau-abc.1 --status in_progress]

agent spawn deep "Implement tau-abc.1
Read the task: backlog show tau-abc.1
Project context: npm run gate, do not change VCS state" -> impl

agent wait [impl]

agent spawn review "Review tau-abc.1 for spec compliance
Read the spec: backlog show tau-abc.1 ..." -> rev

[Review tau-abc.1 — spec then quality as above]

[backlog close tau-abc.1 --reason "Implemented and reviewed"]
[backlog update tau-abc.2 --status in_progress]

# Reuse implementer — it already knows the code
agent send [impl] "Now implement tau-abc.2
Read the task: backlog show tau-abc.2"

agent wait [impl]

# Reuse reviewer — it already knows the area
agent send [rev] "Review tau-abc.2 for spec compliance
Read the spec: backlog show tau-abc.2 ..."

[Review tau-abc.2 — spec then quality]

[backlog close tau-abc.2 --reason "Implemented and reviewed"]
```

## Multi-Task Parallel Example (unrelated tasks, disjoint files)

When tasks touch different areas — fresh agents, no context pollution:

```text
[backlog update tau-abc.1 --status in_progress]
[backlog update tau-abc.2 --status in_progress]

agent spawn smart "Implement tau-abc.1 ..." -> impl-1
agent spawn smart "Implement tau-abc.2 ..." -> impl-2

agent wait [impl-1, impl-2]

[Review each independently]
```

## Final Integration Review

After ALL tasks in an epic are complete:

```text
agent spawn review "Integration review for epic tau-abc

All tasks complete. Check:
- Components work together
- No contract drift between layers
- Tests pass at correct scope
- Ready for merge"
```

## Verify and Describe

The orchestrator session owns VCS actions. In this jj-first repo, that means describing the change — the user pushes.

```bash
npm run gate
jj diff           # or: jj show
jj describe -m "feat: complete auth feature"
backlog close tau-abc --reason "All tasks implemented and reviewed"
```

If review feedback produced fix-up sub-changes, `jj squash` them into the parent before handoff so the remote sees one clean change with interdiffs. Do not run `jj git push` — announce ready-to-push and let the user run `jj git push -c @`.

## Red Flags

- Pasting full task specs into delegation messages (use backlog IDs)
- Providing code snippets to implementers (let them write code)
- Skipping reviews
- Starting quality review before spec compliance PASS
- Spawning new reviewer for re-review (use `agent send`)
- Letting implementer self-review
- Closing a backlog item before both review stages pass
- Telling agents to change VCS state (`jj describe`, `jj squash`, `jj git push`)
- Letting subagents create or close backlog items or spawn reviewers
- Letting subagents fix unrelated bugs (they report, orchestrator files follow-up)
- Spawning fresh agents for sequential dependent work in the same area (reuse with `send`)
- Reusing agents across unrelated areas (accumulated context pollutes, spawn fresh)

## Integration

### With plan mode

Plan mode creates the backlog tasks. SDD executes them:
1. Plan mode → `<proposed_plan>` → user accepts → backlog epics and tasks created
2. SDD → reads backlog → dispatches agents → delivers working code

### With review

Two-phase review per task (spec then quality). Reuse reviewer across related tasks in the same area via `send`. Fresh reviewer for unrelated code.

### With test-driven development

Include "follow TDD" in delegation messages. Agents write failing tests first, then implement.
