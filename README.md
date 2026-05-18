# tau

Tau is a pi extension workspace centered on [`extensions/tau`](extensions/tau). It provides tau runtime features, backlog-backed planning, Exa search tools, memory helpers, and agent workflow wiring.

> **VCS:** this fork is a [jj-vcs](https://github.com/jj-vcs/jj) (Jujutsu) repository, colocated with a `.git/` backing store. Prefer `jj` commands over `git`. The user pushes via `jj git push -c @`; agents never push.

## Quick start

- Install or refresh the global extension symlink:
  ```bash
  ./scripts/pi/install-extensions.sh
  ```
- Run the quality gate from the extension directory:
  ```bash
  cd extensions/tau
  npm run gate
  ```

## Planning and backlog

Tau’s planning surface is backlog.

- Inspect work: `backlog show <id>`
- List actionable work: `backlog ready`
- List all work: `backlog list`
- Create work: `backlog create "Title" --type task --priority 2`
- Update work: `backlog update <id> --status in_progress`
- Close work: `backlog close <id> --reason "Done"`

## Storage model

Backlog state is event-sourced for shared repositories.

- Canonical tracked events live under `.pi/backlog/events/**`
- Derived materialized cache lives under `.pi/backlog/cache/**`
- `.pi/backlog/cache/**` is local, rebuildable, and ignored by both jj and git
- Current issue state is replayed from canonical events, not edited in place

## Development

- Main implementation area: `extensions/tau/`
- Gate command: `cd extensions/tau && npm run gate`
- Exa features require `EXA_API_KEY` in the environment

## Footguns

- Do not edit `.pi/backlog/cache/**` by hand. It is derived state.
- Keep tau-owned docs and prompts on backlog terminology. Tau exposes backlog commands directly.
- When extending shared-repo planning behavior, preserve append-only events and cache rebuild semantics.
