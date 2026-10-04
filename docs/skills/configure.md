# configure / setup

## What it's for

Every other skill depends on a small per-repo settings surface — task/branch types and a default PR target branch. These two skills are where that surface gets captured and stays editable, instead of being hardcoded or buried behind re-installing anything.

## What it does

Both skills share one spec and ask the same two questions; they differ only in when a user reaches for them.

- **`git-agent-setup`** — invoked as `/git-agent-setup`, this is what a user runs right after installing Git-Agent's skills. It asks for default task/branch types and a default PR target branch, then writes them to a per-repo config file. If the repo was already set up before, it shows the existing config and asks for confirmation before overwriting it — it never silently overwrites and never silently refuses.
- **`git-agent-configure`** — invoked as `/git-agent-configure`, the on-demand twin of `git-agent-setup`: shows the existing task types and default PR target, and updates the config file to match whatever the user confirms or changes, any time, with no need to re-run `git-agent-setup`.
- **Every other skill reads config values directly** rather than hardcoding them — changing the config file's task types changes what `create-branch` accepts, with no code change needed.

## Rules

- The config file is read and written directly by skills. The subagent has no config-reading or config-writing code path at all — see [architecture.md](../architecture.md) for why config isn't treated as git/GitHub work.
- Neither skill makes a subagent call whatsoever — both are plain file I/O inside the skill itself.

## Out of scope

- No broad, general-purpose configurability in v1 — the surface is deliberately limited to task/branch types and a default PR target branch.
- No centrally managed, team-wide configuration — v1's config is per-repo and self-serve only.

## Done when

Running `/git-agent-setup` in a fresh repo ends up with a config file matching the answered setup questions. Running `/git-agent-configure` later shows those same current values and updates the file to match whatever the user confirms or changes, without ever needing `/git-agent-setup` again.
