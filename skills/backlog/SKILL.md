---
name: backlog
description: Use when work spans sessions, has blockers, needs durable task context, or should be formalized into tau's event-sourced backlog instead of staying session-local.
---

# Backlog

## Overview

Use tau's event-sourced backlog for durable task tracking. Backlog is the persistent planning surface for work that must survive session boundaries, coordinate dependencies, or remain visible to other agents and collaborators.

## When to Use

- Work spans multiple sessions or days
- Tasks have blockers or ordering constraints
- A feature or migration needs decomposition into multiple items
- A bug, follow-up, or side quest should be captured instead of held in conversation memory
- Context should survive conversation compaction or handoff

## When Not to Use

- The work is a short, single-session checklist with no need for durable tracking
- The user asked only for explanation or research and does not want tasks recorded
- The item is transient scratch work with no follow-up value

## Core Commands

Use the backlog tool surface directly:

```text
backlog ready
backlog show <id>
backlog children <epic-id>
backlog children <epic-id> --recursive
backlog children <epic-id> --recursive --status open
backlog list
backlog status
backlog create "Title" --type task --priority 2
backlog update <id> --status in_progress
backlog close <id> --reason "Done"
backlog dep list <id> --direction down
backlog dep list <id> --direction down --status open
backlog dep tree <id> --direction down
backlog dep add <issue-id> <depends-on-id> --type blocks
backlog comment <id> "note"
```

## Session Workflow

### Start

- Run `backlog ready` to find unblocked work
- Run `backlog show <id>` for the item you are about to work on
- If you are claiming the work, set it `in_progress`

### During Work

- Keep the task description/design/acceptance criteria as the source of truth
- Add comments for durable discoveries, partial progress, or handoff notes when they matter later
- Create follow-up items when unrelated bugs or deferred work appear
- Add dependency edges instead of encoding order only in prose

### Finish

- Verify the work
- Close the item with a concrete reason
- Re-check `backlog ready` to surface newly unblocked work

## Dependency Rules

Think in terms of requirements, not chronology.

- If X needs Y first, record: `backlog dep add X Y --type blocks`
- Use `parent-child` for epic/task structure
- Use `backlog children <epic-id>` to list direct child issues, `--recursive` for the full nested subtree, and `--status open` to keep active work visible
- Use `backlog dep list <id> --direction down` to inspect dependents, `--direction up` for dependencies/blockers/parents, and `--status open` to hide completed edges
- Use `related` for context links that do not block execution
- Use `discovered-from` when new work is found during existing work

Only `blocks` changes what is ready now. The others preserve structure and provenance.

## Planning Boundary

This skill covers backlog mechanics and durable tracking.

For refining vague work into well-formed items with grounded questions, design decisions, and acceptance criteria, use the `$backlog-planning` skill.

## Practical Patterns

### Capture discovered work

```text
backlog create "Investigate auth timeout in worker session" --type bug --priority 2
backlog dep add new-issue current-issue --type discovered-from
```

### Decompose a feature

```text
backlog create "Ship backlog import" --type epic --priority 1
backlog create "Normalize imported timestamps" --type task --priority 1
backlog create "Add import regression coverage" --type task --priority 1
backlog dep add child epic --type parent-child
backlog dep add tests implementation --type blocks
```

### Hand off durable context

```text
backlog comment <id> "Implemented cache rebuild. Remaining issue: startup path still assumes stale prompt snapshot in worker sessions."
```

## Agent Rules

- Read backlog items before implementing them; do not guess from titles alone
- Keep backlog mutations intentional; do not create or close items casually
- Subagents should usually read backlog state, while the orchestrator owns lifecycle updates
- Prefer backlog comments for durable context and final handoff notes that matter after compaction

## Pitfalls

- Do not assume backlog exists as a shell CLI in every consumer repo; use tau's backlog tool surface
- Do not encode blocking relationships only in prose when they affect execution order
- Do not keep a task `in_progress` after the work is complete
- Do not create duplicate issues when an existing one can be updated or linked

## Success Check

This skill is being used well when:

- `backlog ready` surfaces the actual next work
- `backlog show <id>` contains enough context to resume without chat history
- blockers, parent-child structure, and discoveries are represented explicitly
- closing an item makes the next real work visible immediately
