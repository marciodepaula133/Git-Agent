# Git-Agent

Git-Agent is a set of Claude Code skills — `create-branch`, `commit`, `push`, `create-pr`, `update-branch`, `configure`, and `setup` — backed by one shared git/GitHub subagent, that does day-to-day git work the way its author does it: never lose uncommitted changes, never force-push, never rebase, split commits by topic, and name branches and PRs to a fixed convention.

It installs into a repository with `npx skills add`, the way BMad does, and uses that repository's own `gh` CLI authentication — it never manages its own GitHub account or credentials, and it never writes or edits code. The subagent that each skill talks to is bundled directly into the skill's own folder (no separate npm package to publish or install).

## Status

`create-branch`, `push` (skill + subagent action + safety hooks), `git-agent-setup`, and `git-agent-configure` are built. The remaining git/GitHub skills are still target, not built — see [docs/architecture.md](docs/architecture.md) for the planned layout and current status.

## Documentation

- [docs/architecture.md](docs/architecture.md) — how the system is split between skills and the subagent, and the hard rules every skill has to follow (no force-push, never lose uncommitted work, no rebase, etc.)
- [docs/skills/](docs/skills/) — one page per skill, explaining what it does and its done-when criteria: [create-branch](docs/skills/create-branch.md), [commit](docs/skills/commit.md), [push](docs/skills/push.md), [create-pr](docs/skills/create-pr.md), [update-branch](docs/skills/update-branch.md), [configure / setup](docs/skills/configure.md)
- [docs/initial-guidelines.md](docs/initial-guidelines.md) — the author's original hand-written rules this project is built from
