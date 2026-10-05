---
name: git-agent-create-pr
description: Open a pull request for the current branch with a title/body already following house convention, targeting the repo's configured default branch (overridable). Use when the user wants to open, create, or draft a PR — invoked as /git-agent-create-pr.
---

# git-agent-create-pr

Drafts a pull request title and body that already follow house convention and
target the right base branch, then opens it once the user has reviewed and,
if they want, edited the draft. See `docs/skills/create-pr.md` for the full
spec this skill implements.

## Hard rule

**A subagent call never spans a user decision.** `draft-pr` only ever
produces a self-contained draft; this skill does all the back-and-forth with
the user; `create-pr` is only ever called with the user's exact final
`title`/`body`/`targetBranch` — never a value this skill re-derived itself.

## Flow

1. **Read `.git-agent/config.json` in the repo root directly** (this skill
   owns all config I/O — the subagent never reads this file) to get
   `defaultPrTarget`.
   - If the file is missing, has no `defaultPrTarget`, or doesn't parse, ask
     the user which branch to target instead of failing.

2. **Run the subagent's `draft-pr` action.** The subagent is bundled
   alongside this skill — it ships in this same installed folder, no
   separate package install needed. Run:
   ```
   node "<this skill's own installed directory>/subagent/cli.mjs" draft-pr
   ```
   where `<this skill's own installed directory>` is the folder this
   `SKILL.md` file itself was loaded from. `subagent/cli.mjs` is always a
   fixed path relative to that folder.
   Pipe exactly one JSON object on stdin (never as a CLI argument):
   ```json
   { "targetBranch": "<defaultPrTarget, or the branch the user gave you>" }
   ```
   Read the subagent's last line of stdout as the result — exactly one JSON
   object, `{ "ok": boolean, ... }`.

3. **Handle a `draft-pr` failure:**
   - `{ "ok": false, "reason": "invalid-target" }` — tell the user the
     target branch doesn't exist locally or on `origin`, and ask for a
     different one before retrying `draft-pr`.
   - `{ "ok": false, "reason": "no-changes" }` — tell the user the current
     branch has no commits ahead of the target, so there is nothing to open
     a PR for.
   - `{ "ok": false, "reason": "unexpected-error" }` — report that drafting
     failed unexpectedly and suggest checking the repo state by hand.

4. **Present the draft to the user.** On `{ "ok": true, "title", "body",
   "targetBranch" }`, show the title, the body, and the target branch. Let
   the user:
   - Edit the title and/or body freely (plain text, their call entirely).
   - Confirm or override the target branch.
   Keep offering until the user explicitly confirms they're ready to open the
   PR with the current title/body/target.

5. **Run the subagent's `create-pr` action** with the user's exact final
   values — never a value this skill parsed, reformatted, or re-derived from
   the branch:
   ```
   node "<this skill's own installed directory>/subagent/cli.mjs" create-pr
   ```
   stdin:
   ```json
   { "title": "<user's final title>", "body": "<user's final body>", "targetBranch": "<user's final target>" }
   ```

6. **Relay the result to the user:**
   - `{ "ok": true, "url": "...", "number": ... }` — confirm the PR was
     opened and share the URL.
   - `{ "ok": false, "reason": "branch-exists" }` — tell the user a pull
     request is already open for this branch (closest existing enum value —
     there is no dedicated "pr already exists" reason), share that this is
     likely the cause, and suggest they check GitHub for the existing PR.
   - `{ "ok": false, "reason": "unexpected-error" }` — report that opening
     the PR failed unexpectedly and suggest checking the repo/`gh` state by
     hand before retrying.

## Rules

- This skill never runs `git`/`gh` directly — only the subagent does, via
  the bundled `subagent/cli.mjs` sitting next to this file.
- Exactly two subagent calls: `draft-pr` (read-only, self-contained), then
  `create-pr` (mutating, only after the user confirms). Never fewer, never
  more, and nothing in between touches git/GitHub.
- There is no branch-parent tracking. The target always starts from
  `defaultPrTarget` and is only ever changed by the user explicitly saying so
  — this skill never inspects or stores what the current branch was created
  from.
- `create-pr` always gets the user's literal final title/body/target, even
  if the skill thinks a different phrasing would be better.

## Out of scope

- No GitHub Issues integration — task/issue numbers only ever come from the
  branch name, never looked up.
- Doesn't track or remember a branch's parent for later use.
