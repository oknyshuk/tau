---
name: autoresearch-create
description: Set up and run task-scoped autoresearch loops on tau's shared loop engine. Use when asked to create or operate `/autoresearch` tasks, run benchmark trials, or iterate on performance experiments.
---

# Autoresearch Create

Use task-scoped autoresearch loops only. The canonical runtime lives under `.pi/loops/**`.

## When to Use

- User asks to run autoresearch
- User asks to optimize a benchmark/metric in an iterative loop
- User asks to create or operate `/autoresearch` tasks
- User asks how to run benchmark trials with `autoresearch_run` and `autoresearch_done`

## Canonical Rules

1. Use `/autoresearch create <task-id> [goal]` to create `.pi/loops/tasks/<task-id>.md`.
2. Use `/autoresearch start|resume|pause|stop|status|archive|cancel|clean` for lifecycle.
3. Use `autoresearch_run` to execute exactly one trial from the active child session.
4. Use `autoresearch_done` exactly once to finalize the pending run.
5. Keep/discard/crash/checks_failed decisions are finalized through `autoresearch_done`.
6. Run artifacts are canonical under `.pi/loops/runs/<task-id>/<run-id>/`.
7. Task contract and phase identity come from `.pi/loops/tasks/<task-id>.md` frontmatter plus pinned execution profile.
8. Legacy cwd-global autoresearch files are not steady-state inputs (`autoresearch.md`, `autoresearch.jsonl`, `.autoresearch/**`, etc.).

## Setup Workflow

1. Pick a task id and objective.
2. Create the task with `/autoresearch create <task-id> [goal]`.
3. Edit `.pi/loops/tasks/<task-id>.md` contract fields as needed.
4. Start the task with `/autoresearch start <task-id>`.
5. In each active child-session trial:
   - call `autoresearch_run`
   - inspect result + checks
   - call `autoresearch_done` with status and summary
6. Continue trials until objective is met.
7. Pause/stop/archive with `/autoresearch` lifecycle commands.

## Task File Contract Example

The task file must include strict frontmatter and workflow-managed section anchors.

```markdown
---
kind: autoresearch
title: optimize-loop-runtime
benchmark:
  command: bash scripts/bench.sh
  checks_command: bash scripts/checks.sh
metric:
  name: total_ms
  unit: ms
  direction: lower
scope:
  root: extensions/tau
  paths:
    - src
    - test
  off_limits:
    - dist
constraints:
  - no new dependencies
  - keep gate green
limits:
  max_iterations: 30
---

## Goal
<!-- tau:autoresearch.goal:start -->
Reduce end-to-end loop runtime while preserving behavior and correctness checks.
<!-- tau:autoresearch.goal:end -->

## Program
<!-- tau:autoresearch.program:start -->
Focus first on high-frequency hot paths and remove unnecessary filesystem churn.
<!-- tau:autoresearch.program:end -->

## Ideas
<!-- tau:autoresearch.ideas:start -->
- Cache repeated parse results.
<!-- tau:autoresearch.ideas:end -->

## Findings
<!-- tau:autoresearch.findings:start -->
Record durable findings from completed runs.
<!-- tau:autoresearch.findings:end -->

## Progress
<!-- tau:autoresearch.progress:start -->
Append run IDs, metrics, and decisions.
<!-- tau:autoresearch.progress:end -->

## Next Steps
<!-- tau:autoresearch.next_steps:start -->
List the next highest-value experiment.
<!-- tau:autoresearch.next_steps:end -->
```

## Tool Usage

### `autoresearch_run`

- Executes one trial.
- Enforces one pending run per task.
- Persists logs + parsed metrics under `.pi/loops/runs/<task-id>/<run-id>/`.

### `autoresearch_done`

- Finalizes the pending run.
- Required fields: `status`, `description`.
- Optional: `metrics`, `asi`.
- `keep` records the trial in the isolated checkout's working change; non-keep statuses clean/reset isolated checkout only.

Example:

```json
{
  "status": "keep",
  "description": "cache normalized path lookup",
  "metrics": {
    "total_ms": 91.2
  },
  "asi": {
    "hypothesis": "avoiding repeated normalization removes hot-path overhead"
  }
}
```
