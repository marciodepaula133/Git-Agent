# Git-Agent

Git-Agent is a set of Claude Code skills — `create-branch`, `commit`, `push`, `create-pr`, `update-branch`, and `configure` — backed by one shared git/GitHub subagent, that does day-to-day git work the way its author does it: never lose uncommitted changes, never force-push, never rebase, split commits by topic, and name branches and PRs to a fixed convention.

It installs into a repository with `npx`, the way BMad does, and uses that repository's own `gh` CLI authentication — it never manages its own GitHub account or credentials, and it never writes or edits code.

## Status

Planning is complete; implementation is just starting. A base TypeScript project is scaffolded (`package.json`, `subagent/src/cli.ts` placeholder); `skills/` and the real subagent actions/hooks don't exist yet — see [docs/architecture.md](docs/architecture.md) for the planned layout.

## Documentation

- [docs/architecture.md](docs/architecture.md) — how the system is split between skills and the subagent, and the hard rules every skill has to follow (no force-push, never lose uncommitted work, no rebase, etc.)
- [docs/skills/](docs/skills/) — one page per skill, explaining what it does and its done-when criteria: [create-branch](docs/skills/create-branch.md), [commit](docs/skills/commit.md), [push](docs/skills/push.md), [create-pr](docs/skills/create-pr.md), [update-branch](docs/skills/update-branch.md), [configure](docs/skills/configure.md)
- [docs/initial-guidelines.md](docs/initial-guidelines.md) — the author's original hand-written rules this project is built from
