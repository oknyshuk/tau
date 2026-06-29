# tau

tau is a [pi](https://github.com/earendil-works/pi) extension - its source is this repo root. It adds backlog-backed planning, Exa search, subagents, sandboxing, and tau runtime wiring.

## Install

Symlink the repo into pi's global extensions dir, then restart pi:

```bash
ln -sfn "$PWD" ~/.pi/agent/extensions/tau
```

## Develop

```bash
npm run gate    # typecheck → lint → test
```

Exa need `EXA_API_KEY` in the environment.

## Backlog

Planning is event-sourced backlog:

```bash
backlog ready                                    # unblocked work
backlog show <id>                                # issue details
backlog create "Title" --type task --priority 2  # new work
backlog update <id> --status in_progress         # claim work
backlog close <id> --reason "Done"               # finish work
```

- Canonical events live in `.pi/backlog/events/**` (tracked).
- The materialized cache `.pi/backlog/cache/**` is local, rebuildable, and ignored by jj and git.
- Issue state is replayed from canonical events, not edited in place — don't hand-edit the cache.
