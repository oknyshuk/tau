# Agent instructions

tau is a single **pi extension** (many features) whose source is this repo root (`package.json` + `pi.extensions` → `./src/index.ts`). Planning and issue tracking use the event-sourced **backlog**: start with `backlog ready` and `backlog show <id>`.

## Runtime & packaging

- pi loads extension entrypoints via **jiti** (https://github.com/unjs/jiti): TypeScript/ESM runs directly, no build step. Keep entrypoints jiti/Node-ESM compatible (`type: "module"`, explicit `.js` import specifiers in TS).
- The runtime is **bun**, first-class. Fix issues at the bun layer (e.g. `src/shared/home.ts` `getHomeDir()` instead of `os.homedir()`); do not route around bun through Node.
- Global pi config lives under `~/.pi`; global extensions load from `~/.pi/agent/extensions/`. Install/update tau by symlinking the repo root there:
  ```bash
  ln -sfn "$PWD" ~/.pi/agent/extensions/tau
  ```

## Parallel-agent safety (crucial)

Canonical VCS is **jj-vcs** (Jujutsu); `.git/` is a colocated backing store. Multiple agents may share one checkout.

- Never run destructive jj/git on work that isn't yours: no `jj abandon`/`op restore`/`undo`, `git restore`/`checkout`/`reset`/`clean` touching other agents' files.
- If the working copy is dirty from someone else and blocks `jj git fetch`, **stop and ask** — do not "fix" it.
- Inspecting backlog state is always safe.

## Code style — Final Form

- No fallbacks, no migrations, no deprecation: delete old code, don't keep it limping.
- Explicit over implicit: mandatory fields, strict parsing, no silent defaults.
- Make invalid states unrepresentable; on invalid data, fail fast with a clear error.
- Smaller is better — prefer leaning on pi upstream over owning code.

## TypeScript hardening (crucial)

Goal: make tau as safe as Rust.

- `any` is forbidden (incl. `as any`, `Record<string, any>`). Use `unknown` at boundaries and narrow with guards/validation.
- Keep strict options on in `tsconfig.json` (no implicit any, exact optional types, no unchecked indexed access).
- Unused locals/params are warnings only; prefer `_name`.

## Conventions

- User-visible tool and command names are **lowercase**, matching pi built-ins (`read`, `bash`, `edit`). Namespaces use `.`/`_` (`exa.web_search`).
- No startup banners or "extension loaded" logs; use pi's own rendering (tool renderers, custom messages, UI status).
- State what the system does and the exact guarantee; avoid phrasing that defines behavior by what it is not.

<!-- effect-solutions:start -->

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.
Also read and follow `.reference/effect-smol/LLMS.md` for the local Effect style guide.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `.reference/effect/` for real implementations (run `effect-solutions setup` first)

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

<!-- effect-solutions:end -->

## Backlog & memory

- Canonical backlog events live in `.pi/backlog/events/**`. The materialized cache `.pi/backlog/cache/**` is rebuildable and untracked — never hand-edit it.
- `.pi/tau/memories/PROJECT.jsonl` is shared, tracked project memory; save team-wide facts there (`target: project`). Personal/per-machine facts go to `~/.pi/agent/tau/memories/` (`target: user`/`global`) and are never tracked.

```bash
backlog ready                                    # unblocked work
backlog show <id>                                # issue details
backlog create "Title" --type task --priority 2  # new work
backlog update <id> --status in_progress         # claim work
backlog close <id> --reason "Done"               # finish work
```

## Quality gate

From the repo root:
```bash
npm run gate    # typecheck → lint → test
```

`format:check` (`oxfmt --check`) is intentionally **not** part of the gate. Apply
oxfmt to the files you touch (`npm run format` formats `src test`); do not run a
repo-wide reformat as part of unrelated work — a sweeping format-only diff is
unreviewable and collides with other agents sharing the checkout.

## Finishing work (jj-first)

Prefer jj. One change per logical feature; squash review-fixes into the same change for clean interdiffs.

Before saying "done" or handing off:
1. **File follow-ups** in backlog; update or close in-progress items so the backlog matches reality.
2. **Gate**: run `npm run gate`. Never present failing code as finished. If a failure looks pre-existing or unrelated, stop and ask, and record it in backlog.
3. **Describe**: `jj describe -m "<message>"` on `@` (jj auto-amends the working copy); `jj squash` sub-changes into their parent.
4. **Hand off**: confirm `jj st` is clean and `jj diff` matches the description, then announce ready-to-push.

Agents never push — the **user** runs `jj git push -c @` (FIDO-gated). Never abandon/restore/undo someone else's work to tidy up. If `jj git fetch` shows divergence, stop and ask.
