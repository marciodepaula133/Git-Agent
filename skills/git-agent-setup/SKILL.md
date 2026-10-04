---
name: git-agent-setup
description: First-run setup for Git-Agent in this repo — asks for default task/branch types and a default PR target branch, then writes .git-agent/config.json. Use right after installing Git-Agent's skills, or whenever the user asks to set it up — invoked as /git-agent-setup.
---

# git-agent-setup

The first thing to run in a repo right after installing Git-Agent's skills —
asks the setup questions every other skill's config depends on. See
`docs/skills/configure.md` for the full spec (first-run setup and on-demand
reconfiguration share one spec; `git-agent-configure` is the on-demand twin
of this skill).

## Hard rule

**No subagent call, ever.** This skill is plain file I/O against
`.git-agent/config.json`, done directly with your own Read/Write tools, the
same as `git-agent-configure`. The subagent has no config-reading or
config-writing code path at all (`docs/architecture.md`).

## Flow

This is the exact same flow as `git-agent-configure` — read the same spec and
follow it identically:

1. **Read `.git-agent/config.json` in the repo root directly**, if it exists.
   Most of the time on a fresh install it won't; if it does, this repo has
   already been set up before.
2. **Ask for task/branch types and a default PR target branch**, showing any
   existing values as the implied default. Re-ask on an empty answer.
3. **Confirm before writing** when a config file already existed — show
   old vs. new values and ask the user to confirm. Never overwrite silently.
   If there was no existing file, write directly, no confirmation needed.
4. **Write the result** to `.git-agent/config.json`:
   ```json
   { "taskTypes": ["feature", "fix"], "defaultPrTarget": "main" }
   ```
5. **Confirm to the user** what was written, and mention that `/git-agent-configure`
   can change these values again later without re-running setup.

## Rules

- Never call the subagent.
- Never silently overwrite an existing config, and never silently refuse to
  write a new one.
- The config surface is exactly `taskTypes` and `defaultPrTarget`.

## Out of scope

- No broad, general-purpose configurability.
- No centrally managed, team-wide configuration.
- Doesn't touch git, GitHub, or any other file in the repo.
