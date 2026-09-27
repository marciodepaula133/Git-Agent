# configure

## What it's for

Every other skill depends on a small per-repo settings surface — task/branch types and a default PR target branch. This skill (plus first-run setup) is where that surface gets captured and stays editable, instead of being hardcoded or buried behind re-running the installer.

## What it does

- **First-run setup**: installing via `npx` asks for default task/branch types and a default PR target branch, then writes them to a per-repo config file. Re-running the installer against an already-configured repo asks for confirmation before overwriting the existing config — it never silently overwrites and never silently refuses.
- **Every other skill reads config values directly** rather than hardcoding them — changing the config file's task types changes what `create-branch` accepts, with no code change needed.
- **On-demand reconfiguration**: running the `configure` skill later shows the existing task types and default PR target, and updates the config file to match whatever the user confirms or changes — without needing to re-run the `npx` installer.

## Rules

- The config file is read and written directly by skills. The subagent has no config-reading or config-writing code path at all — see [architecture.md](../architecture.md) for why config isn't treated as git/GitHub work.
- `configure` makes no subagent call whatsoever — it's plain file I/O inside the skill itself.

## Out of scope

- No broad, general-purpose configurability in v1 — the surface is deliberately limited to task/branch types and a default PR target branch.
- No centrally managed, team-wide configuration — v1's config is per-repo and self-serve only.

## Done when

A fresh repo installed via `npx` ends up with a config file matching the answered setup questions. Running `configure` later shows those same current values and updates the file to match whatever the user confirms or changes, without ever needing to re-run the installer.
