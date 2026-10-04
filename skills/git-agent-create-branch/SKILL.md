---
name: git-agent-create-branch
description: Create a new git branch from the current HEAD, carrying over any uncommitted, unstaged modifications without losing or staging them. Use when the user wants to start a new branch, a new task, or a new feature/fix branch — invoked as /git-agent-create-branch.
---

# git-agent-create-branch

Starts a new branch, mid-feature, with uncommitted changes already in the
working tree — without losing that work and without hand-typing a branch name
under time pressure. See `docs/skills/create-branch.md` for the full spec this
skill implements.

## Hard rule

**Never lose uncommitted work.** No modification may be staged, dropped, or
overwritten by creating a branch. This is the single most important guarantee
this skill has to keep, and it holds even if any step below fails.

## Flow

1. **Ask for a task/issue number (optional) and a branch type.**
   - The task/issue number may be omitted.
   - The branch type has no default — always ask.

2. **Validate the type against the repo's configured task types.**
   - Read `.git-agent/config.json` in the repo root directly (this skill owns
     all config I/O — the subagent never reads this file).
   - If the file exists and has a `taskTypes` array, the type must be one of
     its entries.
   - If the file is missing, or has no `taskTypes` array, fall back to
     `["feature", "fix"]` silently — this is not an error.
   - If the supplied type isn't in the allowed list, tell the user which
     types are allowed and ask again. Do not call the subagent with an
     unvalidated type.

3. **Ask for a short kebab-case description of the work.**

4. **Compute the branch name:** `<type>/<task-or-issue>-<description>` when a
   task/issue number was given, or `<type>/<description>` when it wasn't —
   never a dangling separator.

5. **Run the subagent's `create-branch` action.** The subagent is bundled
   alongside this skill — it ships in this same installed folder, no
   separate package install needed. Run:
   ```
   node "<this skill's own installed directory>/subagent/cli.mjs" create-branch
   ```
   where `<this skill's own installed directory>` is the folder this
   `SKILL.md` file itself was loaded from (Claude Code reports this when
   invoking a skill; if it isn't already apparent from context, locate it
   from the path this file was read from). `subagent/cli.mjs` is always a
   fixed path relative to that folder.
   Pipe exactly one JSON object on stdin (never as a CLI argument):
   ```json
   { "branchName": "<computed branch name>" }
   ```
   Read the subagent's last line of stdout as the result — exactly one JSON
   object, `{ "ok": boolean, ... }`.

6. **Relay the result to the user:**
   - `{ "ok": true, "branchName": "..." }` — confirm the branch was created
     and that uncommitted modifications carried over untouched.
   - `{ "ok": false, "reason": "branch-exists" }` — tell the user a branch
     with that exact name already exists (e.g. from a previous attempt or a
     collision), and offer to pick a different task number or description.
   - `{ "ok": false, "reason": "unexpected-error" }` — report that branch
     creation failed unexpectedly and suggest checking the repo state by hand
     before retrying.

## Rules

- This skill never runs `git` directly — only the subagent does, via the
  bundled `subagent/cli.mjs` sitting next to this file.
- This is a single subagent call. There is nothing to approve mid-flow — type,
  task number, and description are all settled in conversation before the
  call happens.
- Never pass an unvalidated type through to the subagent; validation happens
  here, not in the subagent (it has no config access).

## Out of scope

- Never touches code content.
- Doesn't track or remember a branch's parent for later use.
