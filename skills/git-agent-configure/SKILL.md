---
name: git-agent-configure
description: Show and update this repo's Git-Agent config (task/branch types, default PR target branch) at any time. Use when the user wants to change allowed task types or the default PR target — invoked as /git-agent-configure.
---

# git-agent-configure

Lets the user redo Git-Agent's small per-repo config surface on demand,
without re-running first-run setup. See `docs/skills/configure.md` for the
full spec this skill implements.

## Hard rule

**No subagent call, ever.** This skill is plain file I/O against
`.git-agent/config.json`, done directly with your own Read/Write tools. The
subagent has no config-reading or config-writing code path at all
(`docs/architecture.md`), so there's nothing to invoke here.

## Flow

1. **Read `.git-agent/config.json` in the repo root directly**, if it exists.
   - If it exists and parses as JSON, show the user the current `taskTypes`
     and `defaultPrTarget`.
   - If it's missing, or exists but isn't valid JSON, tell the user no usable
     config was found and that you'll create one from scratch.

2. **Ask for the new values**, showing the current ones (when there are any)
   as the implied default if the user doesn't want to change them:
   - Task/branch types — a short list of allowed types (e.g. `feature, fix`).
   - Default PR target branch — a single branch name (e.g. `main`), stored
     bare (no `origin/` prefix).
   Re-ask if either answer is empty.

3. **Confirm before writing** when a config file already existed: show a
   quick before/after (old values vs. new values) and ask the user to
   confirm. Never overwrite silently.
   - If the user declines, leave the file untouched and stop.
   - If there was no existing file, skip confirmation and write directly.

4. **Write the result** to `.git-agent/config.json` as pretty-printed JSON:
   ```json
   { "taskTypes": ["feature", "fix"], "defaultPrTarget": "main" }
   ```

5. **Confirm to the user** what was written (or that nothing changed, if they
   declined the overwrite).

## Rules

- Never call the subagent — this skill never shells out to `subagent/cli.mjs`
  or any other git/`gh` tooling.
- Never silently overwrite an existing config, and never silently refuse to
  write a new one — always show current values and confirm changes.
- The config surface is exactly `taskTypes` and `defaultPrTarget` — don't
  invent or carry over other fields.

## Out of scope

- No broad, general-purpose configurability — only task/branch types and the
  default PR target branch.
- No centrally managed, team-wide configuration — this is per-repo and
  self-serve only.
- Doesn't touch git, GitHub, or any other file in the repo.
