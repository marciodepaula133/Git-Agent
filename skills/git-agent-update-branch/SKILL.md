---
name: git-agent-update-branch
description: Catch the current branch up with another branch (typically main) by merging it in — never rebasing — and stop cleanly on conflict instead of doing anything destructive. Use when the user wants to update, sync, or catch up a branch with main/another branch — invoked as /git-agent-update-branch.
---

# git-agent-update-branch

Merges a chosen branch into the current one, trustworthily: a clean,
fast-forward-able update completes with no prompting, and a conflict stops
cleanly, reports exactly which files conflict, and hands control back to the
user rather than attempting any workaround. See `docs/skills/update-branch.md`
for the full spec this skill implements.

## Hard rule

**Never rebases, in any flow.** This skill merges, full stop. On a conflict,
the working tree is left exactly as git left it — no `merge --abort`, no
guessed resolution.

## Flow

1. **Ask for the source branch to merge in** (e.g. `main`, or `origin/main`
   to merge in the up-to-date remote branch). There is no default and no
   config field for this — always ask.

2. **Run the subagent's `merge` action.** The subagent is bundled alongside
   this skill — it ships in this same installed folder, no separate package
   install needed. Run:
   ```
   node "<this skill's own installed directory>/subagent/cli.mjs" merge
   ```
   where `<this skill's own installed directory>` is the folder this
   `SKILL.md` file itself was loaded from. `subagent/cli.mjs` is always a
   fixed path relative to that folder.
   Pipe exactly one JSON object on stdin (never as a CLI argument):
   ```json
   { "from": "<source branch the user named>" }
   ```
   Read the subagent's last line of stdout as the result — exactly one JSON
   object, `{ "ok": boolean, ... }`.

3. **Relay the `merge` result to the user:**
   - `{ "ok": true, "result": "up-to-date" }` — tell the user the current
     branch is already caught up; nothing to do.
   - `{ "ok": true, "result": "fast-forward" }` or `{ "ok": true, "result": "merged" }`
     — confirm the branch is now caught up with the source branch.
   - `{ "ok": false, "reason": "invalid-target" }` — tell the user that
     branch name didn't resolve to anything, and ask them to double-check it
     (including the `origin/`-style prefix if they meant a remote branch).
   - `{ "ok": false, "reason": "conflict", "files": [...] }` — tell the user
     exactly which files conflict, and that the working tree has been left
     mid-merge for them to resolve by hand. Do not attempt to resolve, stage,
     or abort anything yourself. Once the user says they've resolved the
     conflicts, go to step 4.
   - `{ "ok": false, "reason": "unexpected-error" }` — report that the merge
     failed unexpectedly and suggest checking the repo state by hand.

4. **Only after a reported conflict, once the user says it's resolved, run
   the subagent's `finish-merge` action.** Same invocation pattern:
   ```
   node "<this skill's own installed directory>/subagent/cli.mjs" finish-merge
   ```
   Pipe an empty JSON object on stdin (`{}`) — `finish-merge` re-discovers
   the in-progress merge and its unmerged files live from the repository
   itself; nothing from step 3 needs to be passed through.

5. **Relay the `finish-merge` result to the user:**
   - `{ "ok": true }` — confirm the merge is now complete.
   - `{ "ok": false, "reason": "conflict", "files": [...] }` — tell the user
     those specific files still have unresolved conflict markers, and ask
     them to finish resolving those before trying again (repeat step 4).
   - `{ "ok": false, "reason": "unexpected-error" }` — report that finishing
     the merge failed unexpectedly (e.g. there was no merge in progress to
     finish) and suggest checking the repo state by hand.

## Rules

- This skill never runs `git` directly — only the subagent does, via the
  bundled `subagent/cli.mjs` sitting next to this file.
- One-or-two-call shape: `merge` alone when clean; `merge` then `finish-merge`
  only when `merge` reported a conflict.
- Never passes a custom commit message, `-X ours`/`-X theirs`, `--squash`, or
  any rebase to the subagent — this skill has no option for any of those.
- No new config field: this skill doesn't read or write `.git-agent/config.json`.

## Out of scope

- No rebase support, in any flow — deferred indefinitely, not just for v1.
- Doesn't track or remember a branch's parent for later use.
