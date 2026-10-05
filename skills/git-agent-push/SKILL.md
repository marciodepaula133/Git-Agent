---
name: git-agent-push
description: Push committed work on the current (or a named) local branch to its remote, with force-pushing structurally impossible. Use when the user wants to push, publish, or sync a branch to the remote — invoked as /git-agent-push.
---

# git-agent-push

Pushes committed work to the remote through the ordinary path. See
`docs/skills/push.md` for the full spec this skill implements.

## Hard rule

**No force-push, ever, under any circumstance.** There is no override or
exception flag for this — not in this skill, not in the subagent, not in the
underlying hook. A push that would require force (the remote has commits this
branch doesn't have locally) is reported back, never forced through.

## Flow

1. **Determine the branch to push.**
   - Default to the current local branch.
   - Confirm the branch name with the user (and the remote it's pushing to,
     if relevant) before calling the subagent — there's no plan to approve
     mid-flow, so everything needed is settled here.

2. **Run the subagent's `push` action.** The subagent is bundled alongside
   this skill — it ships in this same installed folder, no separate package
   install needed. Run:
   ```
   node "<this skill's own installed directory>/subagent/cli.mjs" push
   ```
   where `<this skill's own installed directory>` is the folder this
   `SKILL.md` file itself was loaded from (Claude Code reports this when
   invoking a skill; if it isn't already apparent from context, locate it
   from the path this file was read from). `subagent/cli.mjs` is always a
   fixed path relative to that folder.
   Pipe exactly one JSON object on stdin (never as a CLI argument):
   ```json
   { "branchName": "<branch to push>" }
   ```
   Read the subagent's last line of stdout as the result — exactly one JSON
   object, `{ "ok": boolean, ... }`.

3. **Relay the result to the user:**
   - `{ "ok": true, "branchName": "..." }` — confirm the branch was pushed to
     its remote (including the case where it had no upstream yet and one was
     just set).
   - `{ "ok": false, "reason": "non-fast-forward" }` — tell the user the
     remote has commits they don't have locally, so the push was rejected.
     Suggest they pull or rebase by hand and decide how to reconcile it
     themselves. Never offer a force option, and never retry with one.
   - `{ "ok": false, "reason": "unexpected-error" }` — report that the push
     failed unexpectedly and suggest checking the repo state (remote
     configuration, auth) by hand before retrying.

## Rules

- This skill never runs `git` directly — only the subagent does, via the
  bundled `subagent/cli.mjs` sitting next to this file.
- This is a single subagent call. There is no commit plan or PR draft to
  review mid-flow — only the branch (and optionally the remote) need
  confirming before the call happens.
- Never pass a force flag, or suggest one to the user as a way around a
  rejected push — this skill has no override path for that, by design.

## Out of scope

- Doesn't create or track a branch's parent.
- Doesn't open or manage a pull request — that's `git-agent-create-pr`.
- Doesn't manage GitHub auth or credentials — assumes the repo's `git`/`gh`
  remote auth already works.
