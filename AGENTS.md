# Agent Instructions

This project uses the event-sourced **backlog** for planning and issue tracking.
Inspect work with `backlog ready` and `backlog show <id>`.

## pi extension packaging (crucial)

- **tau is a single pi extension with many features**. Keep extension source code under `./extensions/tau/` (`package.json` + `pi.extensions`).
- **Global pi config lives under `~/.pi`** and global extensions are discovered from **`~/.pi/agent/extensions/`**.
- To install/update tau globally, symlink (or copy) `./extensions/tau` into `~/.pi/agent/extensions/`.
- **Never create or use `./.pi/extensions/` inside this repo.** Project-local pi extension folders are not part of tau’s design.
- Use the helper installer:
  ```bash
  ./scripts/pi/install-extensions.sh
  ```
- **pi loads extension entrypoints via jiti** (https://github.com/unjs/jiti). This means TypeScript/ESM files are executed at runtime (no separate build step). Keep extension entrypoints compatible with jiti/Node ESM resolution (e.g. `type: "module"`, explicit `.js` import specifiers in TS where required).

## parallel agent safety (crucial)

This fork uses **jj-vcs** (Jujutsu) as its canonical VCS. Read the jj-fluency skill before doing any VCS work. Multiple agents may work in the same checkout concurrently.

- **Do not run destructive jj or git commands** outside the extension directory you are actively working on.
  - Never `jj abandon`, `jj op restore`, `jj undo`, `git restore`, `git checkout`, `git reset`, `git clean`, or similar on other extensions’ files.
- If the working copy is dirty due to someone else’s work and it blocks `jj git fetch`, **stop and ask** instead of trying to “fix” it.
- It is always safe to inspect backlog state. Canonical shared state lives under `.pi/backlog/events/**`, and `.pi/backlog/cache/**` is derived local cache.

## Naming Conventions

- All tool names, tool labels, and command names that are visible to the user should be **lowercase** to match pi's built-in tools (`read`, `bash`, `edit`, `write`, etc.).
- If you need namespaces, use lowercase separators like `.` or `_` (e.g. `exa.web_search`, `exa.code_context`, `backlog`).

## Writing Conventions

- Avoid contrastive phrasing that defines decisions by exclusion; state what the system does and the precise behavior/guarantee instead.

## Extension logging

- Do not print startup banners or "extension loaded" messages (e.g. via `console.log`) from extensions.
- Rely on pi's own reporting/rendering system (tool renderers, custom messages, UI status) instead.

## typescript hardening (crucial)

Goal: make `extensions/tau` as safe as rust.

- `any` is forbidden (including `as any`, `Record<string, any>`, and `unknown as any`).
  - Use `unknown` at boundaries (JSON, tool inputs) and narrow with type guards/validation.
  - Prefer explicit types over widening casts.
- Unused locals/params are allowed as warnings only (do not fail builds on unused).
  - Prefer `_name` for intentionally-unused values; lint reports warnings only.
- Keep strict options on in `extensions/tau/tsconfig.json` (no implicit any, exact optional types, no unchecked indexed access).

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.
Also read and follow `.reference/effect-smol/LLMS.md` for the local Effect style guide.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `.reference/effect/` for real implementations (run `effect-solutions setup` first)

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

<!-- effect-solutions:end -->

## Final Form Code Style

Write code clean, explicit, without fallbacks:

- **No fallback logic**: Remove old code entirely when changing schemas.
- **No migrations**: Breaking changes fail fast with clear errors.
- **Explicit over implicit**: Mandatory fields, strict parsing, no silent defaults.
- **Delete, don't deprecate**: Remove old code rather than keeping it working temporarily.
- **Invalid states are unrepresentable**: Design APIs and data structures so that invalid states cannot be expressed. When invalid data is encountered, stop immediately and report the error.

## Backlog Storage

- Canonical tracked backlog events live under `.pi/backlog/events/**`.
- Materialized current-state cache lives under `.pi/backlog/cache/**` and is rebuildable.

## Quick Reference

```bash
backlog ready                                  # Find unblocked work
backlog show <id>                              # View issue details
backlog list                                   # List tracked work
backlog create "Title" --type task --priority 2 # Create issue
backlog update <id> --status in_progress       # Claim work
backlog close <id> --reason "Done"            # Complete work
backlog status                                 # Show summary counts
```

## Quality Gate

Run from `extensions/tau/`:
```bash
npm run gate
```

This runs: typecheck → lint → test

## VCS workflow (jj-first)

This fork is a **jj-vcs** repository. The `.git/` directory is a colocated backing store; treat jj as the canonical VCS and prefer jj commands.

- One change per logical feature (gerrit-like). Squash review feedback into the same change so the remote shows clean interdiffs.
- Bookmarks (not branches) point at changes under review. Modern aliases are built in: `jj b a` (advance), `jj b s` (set), `jj b c` (create), `jj st`, `jj desc`, `jj ci`.
- Vocabulary mapping: `branch` → `bookmark`, `git commit -m ...` → `jj describe -m ...` (jj auto-amends on the next jj command), `git commit --amend` / `git add -p` → `jj squash [-i]`, `git stash` → `jj new`, `git diff` → `jj diff`, `commit hash` → `change ID` (stable across rewrites), `git pull --rebase && git push` → `jj git fetch` then the **user** runs `jj git push -c @`.
- The `git_commit_with_user_approval` tool wraps `jj describe` (and `jj squash` when consolidating) in this repo. The tool name is unchanged; the underlying VCS is jj.
- **Agents do not push.** The user runs `jj git push -c @` when ready — their FIDO security key is the discipline gate against mindless pushes.

## Saying "Done" (chat / handoff rule)

Before the agent says "I'm done" (or hands off work as complete):

1. The agent MUST run `npm run gate` in `extensions/tau/`.
2. The agent MUST NOT present broken / failing code as finished work.
3. If `npm run gate` fails:
   - If the failure is caused by the agent's changes: fix it (or explicitly ask for approval to ship broken code).
   - If the failure seems pre-existing or unrelated: stop and ask the user before continuing, and record it in backlog.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL stages below in order. Work is NOT complete until the change is described and the user has been handed off cleanly.

**MANDATORY WORKFLOW:**

1. **Stage 1 — File follow-up issues.** Use `backlog create` for anything that needs follow-up. Update or close in-progress items so the canonical backlog matches reality.
2. **Stage 2 — Gate.** From `extensions/tau/`, run `npm run gate` (typecheck → lint → test). Fix anything your changes broke.
3. **Stage 3 — Describe the change.** Run `jj describe -m "<message>"` on `@`. No commit/amend ceremony — jj auto-amends the working-copy change. If the change accumulated review-fix sub-changes, `jj squash` them into the parent so the remote sees one clean change with interdiffs.
4. **Stage 4 — Hand off to the user.**
   - Confirm `jj st` is clean (or shows only the one change you intended).
   - Confirm `jj diff` (or `jj show`) matches what you described.
   - Announce ready-to-push. The **user** runs `jj git push -c @`. Their FIDO key is the discipline gate; never push on their behalf.

**CRITICAL RULES:**
- NEVER run `jj git push`. Pushing is the user's responsibility, gated by their FIDO tap.
- NEVER abandon, restore, or undo someone else's changes to “tidy up” before handoff.
- If `jj git fetch` reveals divergence, stop and ask before rebasing or rewriting history.
