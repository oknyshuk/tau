---
name: backlog-planning
description: Plan and refine work into well-formed backlog items through grounded dialogue. Use when a request needs clarification, scope decisions, design direction, or a concrete definition of done before implementation.
---

# Planning with Backlog

## The Deal

Planning is implementation contract creation.

The backlog item is the source of truth for implementation. A ready epic or task must let an experienced AI agent implement the agreed work without chat history, hidden assumptions, or another clarification round.

Planning turns vague intent into executable work:

- Understand the problem
- Ground it in the codebase
- Ask focused questions when decisions are still open
- Decide the approach
- Define observable success
- Encode the agreement into backlog so implementation can proceed without guesswork

The goal is simple: by the time work is marked ready, the backlog item is the implementation contract.

## Core Contract

Every planned `epic`, `feature`, `bug`, and `task` needs:

- a clear problem statement
- the chosen approach and boundaries
- mandatory acceptance criteria
- actionable tasks with concrete implementation slices
- explicit parent-child and blocker relationships when structure or ordering matters

Acceptance criteria are mandatory. If you cannot write them precisely, planning is not finished.

## Separation of Concerns

- This skill is about planning and refinement
- The `$backlog` skill is about backlog mechanics, lifecycle, and durable task tracking

Use this skill to shape the work. Use `$backlog` to operate the system cleanly.

## Work Lifecycle

```text
idea → refinement → ready → work → done
```

### Idea

The user has intent but not a settled approach or definition of done yet.

Create an epic or task with the problem statement when it should be captured durably, even if details are still incomplete.

```text
backlog create "Auth system overhaul" --type epic --priority 2 --description "Current auth model is inconsistent and needs redesign."
```

### Refinement

Turn vague work into actionable backlog items:

- clarify the problem
- inspect the codebase
- decide scope and constraints
- choose the approach
- define acceptance criteria
- decompose into tasks if needed

### Ready

A ready item has enough context for implementation:

- description explains the problem and why it matters
- design captures the chosen approach and key tradeoffs
- acceptance criteria define what must be true when complete
- dependencies and parent-child structure are explicit

Ready means an experienced AI agent can start from `backlog show <id>` and implement the item without asking what was agreed.

### Done

The implementation meets the acceptance criteria and the backlog item can be closed with a concrete reason.

## Planning Steps

### 1. Understand the Problem

Start with the user problem, not the solution.

Figure out:

- what is broken, missing, or desired
- who or what is affected
- why it matters now
- what constraints already exist

Do not jump straight into implementation details.

### 2. Ground in the Codebase

Before asking the user, do the work you can do yourself:

- search for the relevant area
- read the existing implementation and adjacent patterns
- inspect current APIs, schemas, commands, or docs
- run the relevant command or test when behavior needs confirmation

Questions should come after investigation, not instead of it.

### 3. Ask Grounded Questions

When you need clarification, make it specific and informed.

Use `request_user_input` for decisions that materially affect scope, behavior, UX, architecture, or acceptance criteria. Ask after investigation, and present the real options you found.

Use it when:

- acceptance criteria cannot be written without a decision
- scope could reasonably include or exclude a subsystem
- two implementation approaches imply different contracts
- user preference determines workflow or UI behavior
- the plan would otherwise encode a guess

Ask 1-3 focused questions. Provide 2-4 mutually exclusive choices. Put the recommended choice first and explain the tradeoff briefly.

Bad:

- "Where is the auth code?"
- "How should this work?"

Good:

- "I found auth flow in `src/auth/` and current API middleware in `src/http/auth.ts`. Should the new endpoint reuse that middleware or deliberately split browser and API validation?"
- "Current backlog items treat worker sandboxing as a security issue. Should this slice stay focused on enforcement only, or also include UI surfacing for denied tool calls?"

Pattern:

"I found X. Should we do Y or Z?"

For structured choices, use `request_user_input` instead of free-form chat.

### 4. Decide the Approach

Planning must choose how the work will be solved.

Capture:

- architecture or pattern to follow
- boundaries of the slice
- tradeoffs accepted for this iteration
- what is explicitly out of scope

This becomes the backlog item's `design`.

### 5. Define Done

Define success as observable outcomes, not implementation steps.

This becomes the backlog item's acceptance criteria.

Good acceptance criteria answer:

- what behavior exists when the work is complete
- what a reviewer or implementer can verify
- what users or downstream systems will observe

Bad acceptance criteria are really design notes in disguise.

Do not mark an item ready until acceptance criteria exist.

For epics, acceptance criteria describe the complete outcome across child tasks. For tasks, acceptance criteria describe the specific slice that task owns.

Each acceptance criterion should be verifiable by a reviewer, test, command, or observable behavior.

## Actionable Tasks

Tasks are implementation slices an agent can execute directly.

An actionable task has:

- one concrete outcome
- a clear scope boundary
- known prerequisites or dependency edges
- enough context to choose the first implementation step
- acceptance criteria that verify completion

Split broad remainder work into named slices. Replace vague tasks like "finish the feature", "handle the rest", or "draw the rest of the owl" with concrete tasks that state the subsystem, behavior, and completion signal.

Good task shape:

- "Persist user notification preferences"
- "Block invalid project config writes"
- "Render child issue checklist"

Each task should be small enough for an agent to start from `backlog show <id>` and make progress immediately.

## Code in Backlog Items

Backlog items describe contracts, decisions, and observable outcomes. They are not implementation scratchpads.

Include code only when the literal code shape is necessary for implementation. Valid cases:

- invariants that must be preserved exactly
- public interfaces or function signatures the implementation must expose
- schema fields and required/optional semantics
- protocol, command, or config shapes that are part of the contract
- minimal examples needed to remove ambiguity from an external API boundary

Keep code snippets minimal. Prefer names, fields, and contracts over bodies.

Avoid:

- implementation snippets that merely suggest one possible solution
- pseudo-code for ordinary control flow
- copied code from existing files
- large examples that belong in tests or implementation

If the code is not part of the contract, put the decision in `design` and leave implementation to the agent.

## Before Creating or Updating Items

### Check for Existing Work

Search first. Do not create duplicates.

```text
backlog search "auth"
backlog list --type epic
backlog list --type task
```

If an item already exists, prefer updating or linking it.

### Find or Create the Epic

Most substantial work belongs under an epic or other parent container.

```text
backlog list --type epic
backlog show <epic-id>
```

If no fitting epic exists, create one for the user-visible goal, then link child work with `parent-child`.

### Model Dependencies Explicitly

If work truly depends on other work, add the dependency edge.

```text
backlog dep add <issue-id> <depends-on-id> --type blocks
```

Use relationships, not prose, to model execution order.

## Creating Well-Formed Items

Example:

```text
backlog create "Add worker sandbox enforcement" \
  --type task \
  --priority 1 \
  --description "Worker agents currently bypass tau sandbox enforcement because worker sessions do not inherit tau's tool restrictions." \
  --design "Enforce sandbox restrictions in worker tool execution, keep policy inheritance explicit, and fail fast when a requested tool is outside the effective allowlist." \
  --acceptance-criteria "Worker agents can only execute tools allowed by the effective sandbox policy, denied calls fail visibly, and an automated regression test covers the restricted path."
```

If the task belongs under a parent item:

```text
backlog dep add <child-id> <epic-id> --type parent-child
```

## Field Guidance

### Description

Use `description` for:

- the problem
- relevant context
- why the work matters
- user impact or system impact

This is the stable problem statement.

### Design

Use `design` for:

- chosen approach
- architecture or implementation shape
- tradeoffs and constraints
- what patterns to mirror

This can evolve if planning evolves.

Example:

"Add a dedicated execution schema layer, keep `/mode` as the user-facing command, and resolve session behavior through a shared execution-profile service rather than scattered prompt-mode state."

### Acceptance

Use acceptance criteria for:

- observable outcomes
- verifiable completion conditions
- externally meaningful behavior

Acceptance criteria are required for every planned epic, feature, bug, and task.

Example:

"Switching mode updates the active execution profile used by the session, Ralph iterations inherit the intended profile, and spawned agents respect the effective tool policy."

Test:

If the statement would still be valid under a different implementation, it is probably acceptance criteria. If it only describes one implementation approach, it belongs in design.

Quality bar:

- each criterion can be checked directly
- the set covers the agreed scope
- the wording avoids hidden implementation guesses
- the criterion remains true even if the implementation changes

### Comments

Use comments for durable planning notes that matter later:

- decisions made after the item was created
- discovered edge cases
- handoff notes
- narrowed scope or follow-up rationale

Do not overload comments with the core contract if `description`, `design`, or acceptance should be updated instead.

## Decomposition Rules

### Use an Epic When

- the goal spans multiple deliverables
- the user asked for a broad feature or migration
- several tasks share one user-visible outcome

Epic acceptance criteria describe the finished user-visible or system-visible outcome. Child task acceptance criteria describe the smaller implementation slices that together satisfy the epic.

### Split into Tasks When

- deliverables can be completed independently
- dependencies are real and worth modeling
- different files or subsystems can be verified separately
- a single item would otherwise hide too much complexity

Each split task must name the concrete slice it owns. The task title and acceptance criteria should make the first implementation move obvious.

### Keep One Item When

- the work is a small, coherent slice
- decomposition would add bookkeeping without clarity

## Task Types

| Type | Use for | Planning depth |
|------|---------|----------------|
| `epic` | Multi-item goal or initiative | vision and boundaries |
| `feature` | New user-visible capability | full planning |
| `bug` | Broken behavior | repro, expected vs actual |
| `task` | Concrete implementation slice | focused plan |
| `chore` | Maintenance or housekeeping | minimal |

### Bug Planning

For bugs, capture the repro clearly in `description`:

- steps to reproduce
- expected behavior
- actual behavior
- evidence when available

Example:

```text
backlog create "Worker sandbox policy ignored" \
  --type bug \
  --priority 1 \
  --description "Steps: 1. Spawn a worker agent from a restricted session. 2. Call a tool that should be denied. Expected: call is blocked by inherited sandbox policy. Actual: worker executes the tool without restriction."
```

## Priority Guidance

| Level | Meaning | Typical action |
|-------|---------|----------------|
| P0 | Production down or severe incident | do immediately |
| P1 | Urgent, user-impacting, or security-critical | next up |
| P2 | Normal planned work | default |
| P3 | Useful but not urgent | fit in later |
| P4 | Someday or speculative | keep in backlog |

Set priority during planning instead of leaving urgency implicit.

## Planning Checklist

- [ ] Problem is understood
- [ ] Relevant code and patterns were inspected
- [ ] Open decisions were asked with `request_user_input` when they affect the contract
- [ ] Scope and approach are decided
- [ ] Acceptance criteria exist for every planned epic/task/feature/bug
- [ ] Acceptance criteria define real completion
- [ ] Code appears only when needed as an invariant, interface, schema, or contract
- [ ] Existing epic or related work was checked
- [ ] Dependencies are modeled explicitly
- [ ] Priority is set intentionally

If you cannot define done, the work is not planned yet.

## Reference

For backlog mechanics, lifecycle usage, dependencies, and durable task hygiene, use the `$backlog` skill.
