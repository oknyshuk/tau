---
name: requesting-code-review
description: Iterative code review loop with a persistent reviewer agent. Reviews repeat until no findings remain. Agent validates each finding by writing a RED test before fixing. Use when completing tasks, implementing major features, or before merging.
---

# Requesting Code Review

## Overview

Dispatch a single reviewer agent and keep the conversation going until there are zero actionable findings. Validate every claim the reviewer makes — write a failing test (RED) before fixing anything.

**Core principle:** Trust but verify. A reviewer finding that cannot be reproduced with a RED test is not a real finding.

## When to Request Review

**Mandatory:**
- After completing a major feature or backlog task
- Before handoff for `jj git push -c @`
- After bug fixes touching critical paths

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After complex logic implementation

## The Review Loop

### Step 1: Spawn One Reviewer

Spawn a single review agent. This agent has full workspace access — it can read files, run tests, inspect diffs, and query the backlog on its own. Keep the prompt focused on *what* was done, not *how* to find it.

**When work is backlog-tracked (most common case):**

```
agent spawn review "Review the implementation for the following backlog items:
- <backlog-id-1>: <title>
- <backlog-id-2>: <title>

The backlog has full context — use `backlog show <id>` for requirements and acceptance criteria.
Use `jj diff` (or `jj show`) and workspace access to inspect the actual changes.

Focus on: correctness against requirements, edge cases, error handling, security, test coverage.

OUTPUT FORMAT:
- P0 (critical): blocks merge
- P1 (important): should fix before merge
- P2 (minor): improvement opportunity
- Verdict: APPROVE / REQUEST_CHANGES"
```

**When work is not backlog-tracked:**

```
agent spawn review "Review the implementation of [brief description of what was done].

Use `jj diff` (or `jj show`) and workspace access to inspect the changes.

Focus on: correctness, edge cases, error handling, security, test coverage.

OUTPUT FORMAT:
- P0/P1/P2 findings
- Verdict: APPROVE / REQUEST_CHANGES"
```

### Step 2: Wait and Read Findings

```
agent wait [reviewer_id]
```

Read the findings. Categorize:
- **P0 (critical):** Must fix. Security holes, broken behavior, data loss risk.
- **P1 (important):** Should fix. Missing edge cases, poor error handling, requirement gaps.
- **P2 (minor):** Improvement opportunity. Style, naming, docs, minor refactors.

If verdict is **APPROVE** with zero P0/P1 findings → done. Close the reviewer.

> **Gerrit-style interdiff workflow.** Review feedback is squashed **into the same change** so the remote sees a clean interdiff between revisions. Make fixes in a fresh fix-up working copy (`jj new`), then `jj squash` them down into the change under review. Do **not** stack new follow-up changes for review fixes — that breaks interdiff and review continuity.

### Step 3: Validate Each Finding with a RED Test

For every P0 and P1 finding, before writing any fix:

1. **Write a test that exposes the claimed bug or missing behavior.**
2. **Run the test.** It must fail (RED).
3. If the test **passes** → the reviewer's claim is wrong. Record it as invalid with evidence.
4. If the test **fails** → confirmed real. Proceed to fix.

This is the RED-GREEN-REFACTOR cycle from the test-driven-development skill — follow it exactly.

### Step 4: Push Back on Invalid Findings

If a test passes immediately (finding is not reproducible):
- The reviewer was wrong. Do not fix a non-bug.
- Record the evidence: which test was written, why it passes, what it proves.
- Include this in the follow-up message to the reviewer.

### Step 5: Record Findings in Backlog

When the review is tied to backlog items, materialize all findings and outcomes as backlog comments. This creates a searchable audit trail — future work can reference whether similar bugs were found and how they were resolved.

**For each valid finding that was fixed:**
```
backlog comment <task-id> "REVIEW FIX: <finding summary>. Test: <test file and name>. Fix: <what changed>."
```

**For each finding invalidated by a passing test:**
```
backlog comment <task-id> "REVIEW INVALID: <finding summary>. Evidence: <test file> passes — behavior is correct."
```

**For P2 findings deferred to later:**
```
backlog comment <task-id> "REVIEW DEFERRED (P2): <finding summary>. Reason: <why deferred>."
```

Nothing is lost. Every reviewer observation becomes a durable record on the relevant backlog item.

### Step 6: Send Follow-Up Review

After fixing all valid P0/P1 findings, send a follow-up to the **same reviewer agent**:

```
agent send [reviewer_id] "Follow-up review — fixes applied.

FIXES:
- <finding 1>: added bounds check, regression test in <test location>
- <finding 2>: handle empty input, test in <test location>

INVALIDATED:
- <finding 3>: wrote test proving behavior is correct (<test location>)

Re-review the fixes and check for new issues introduced by the changes.

Same output format: P0/P1/P2 + Verdict."
```

Then `agent wait [reviewer_id]` again.

### Step 7: Repeat Until APPROVE

Continue the loop:
1. Read findings
2. Validate with RED tests
3. Fix valid findings, record in backlog
4. Send follow-up to same reviewer
5. Wait for re-review

**Exit conditions:**
- Verdict is APPROVE with zero P0/P1 findings.
- All remaining findings are P2 and recorded as deferred comments in backlog.

### Step 8: Close Reviewer

```
agent close [reviewer_id]
```

## Decision Tree

```
spawn reviewer → wait for findings
  ↓
APPROVE + no P0/P1 → record any P2 deferrals in backlog → close → done
  ↓
REQUEST_CHANGES →
  for each P0/P1 finding:
    write RED test →
      test FAILS → fix (GREEN) → record fix in backlog
      test PASSES → mark invalid → record evidence in backlog
  ↓
send follow-up to same reviewer → wait
  ↓
(repeat until APPROVE)
```

## Rules

1. **One reviewer agent for the entire loop.** Spawn once, send follow-ups. Spawning new reviewers each round loses accumulated context.
2. **Every P0/P1 finding gets a RED test.** No exceptions. If you cannot write a test for it, ask the reviewer to clarify the exact failure scenario.
3. **Invalid findings are reported back.** Do not silently ignore them. Tell the reviewer what you tested and why the finding does not hold.
4. **P2 findings are optional but never lost.** Fix if quick, otherwise record as deferred comments on the relevant backlog item.
5. **The loop ends on APPROVE.** Not on "I think it's fine." The reviewer must explicitly approve.
6. **Run the full test suite after each fix round.** No regressions allowed.
7. **Materialize everything in backlog.** Findings, fixes, invalidations, and deferrals all become comments on the relevant task. This builds an institutional memory of what was reviewed, what broke, and how it was fixed.

## Integration with TDD

The RED test step IS the test-driven-development skill applied to review findings. The reviewer's finding is the "requirement" — follow that skill's full RED-GREEN-REFACTOR cycle to validate and fix it. The test stays as a permanent regression guard.

Review findings that survive RED test validation become permanent tests in the codebase. This is how reviews compound the test suite over time.

## Anti-Patterns

- **Blindly trusting the reviewer:** Fixing things without verifying they are actually broken. Wastes time and introduces unnecessary churn.
- **Spawning a new reviewer each round:** Loses context from previous rounds. The reviewer cannot see what was already discussed.
- **Skipping RED tests for "obvious" findings:** Obvious bugs that cannot be reproduced with a test are not bugs.
- **Arguing without evidence:** If you disagree with a finding, write the test. The test result is the evidence.
- **Fixing P2s before P0s:** Priority order matters. Critical issues first.
- **Losing deferred findings:** P2 findings that aren't fixed immediately must be recorded in backlog. Untracked observations decay to zero.
