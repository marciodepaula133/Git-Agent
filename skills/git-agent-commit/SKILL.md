---
name: git-agent-commit
description: Turn a messy working tree with unrelated changes tangled together into a reviewed, topic-split commit history, and force an explicit decision on anything that looks like it shouldn't be committed (secrets, credentials, local-only files). Use when the user wants to commit, split a commit, or clean up a working tree before committing — invoked as /git-agent-commit.
---

# git-agent-commit

Proposes a multi-commit plan — splitting unrelated changes into separate
commits, including splitting a single file by line range when it holds two
unrelated topics — and asks about every file that looks local-only before
anything is actually committed. See `docs/skills/commit.md` for the full spec
this skill implements.

## Hard rules

- **Nothing is committed on an unapproved plan.** The user must see and
  approve the plan (and decide every local-only candidate) before
  `execute-commit` is ever called.
- **The actual commit uses the exact hunks from the approved plan** — never a
  fresh re-diff, even if the user spent a while reviewing and the tree
  changed in the meantime.
- **Local-only detection belongs entirely to the subagent's `plan-commit`
  step.** This skill never scans the working tree itself, and never decides
  on its own that a file should be excluded — it only relays the subagent's
  `localOnlyCandidates` list and asks.

## Flow

1. **Run the subagent's `plan-commit` action.** The subagent is bundled
   alongside this skill. Run:
   ```
   node "<this skill's own installed directory>/subagent/cli.mjs" plan-commit
   ```
   where `<this skill's own installed directory>` is the folder this
   `SKILL.md` file was loaded from. Pipe an empty JSON object on stdin
   (`{}`) — `plan-commit` takes no input fields, it acts on the current
   working tree. Read the subagent's last line of stdout as the result.

2. **Handle a `{ "ok": false, "reason": "no-changes" }` result** by telling
   the user there's nothing to commit, and stop here — do not go any further.

3. **Handle a `{ "ok": false, "reason": "unexpected-error" }` result** by
   reporting that planning failed unexpectedly and suggesting the user check
   the repo state by hand, and stop here.

4. **On `{ "ok": true, "commits": [...], "localOnlyCandidates": [...] }`,
   present the plan to the user:** for each proposed commit, show its
   message and which file(s)/line-ranges it covers. Keep this `plan` object
   around verbatim — it must be relayed unmodified to `execute-commit` later.

5. **For each entry in `localOnlyCandidates`, ask the user individually**
   (via `AskUserQuestion`) whether to include or exclude that specific file.
   Do not batch them into one yes/no, and do not default to either answer —
   always ask. Record each answer as `decisions.localOnly[file] = "include"
   | "exclude"`.

6. **Let the user request adjustments to the proposed split** — merging two
   commits together, or excluding one of the proposed commits entirely (e.g.
   because it should be committed separately by hand, or not at all right
   now). Record these as:
   - `decisions.commitEdits.merge`: an array of `[idA, idB]` pairs, each pair
     naming two commit `id`s from the plan to fold into one. `idA`'s hunks are
     folded into `idB`, which is the surviving commit id — `idB`'s own message
     is kept, `idA`'s message is discarded.
   - `decisions.commitEdits.exclude`: an array of commit `id`s to drop
     entirely from this run.
   If the user asks for no adjustments, omit `commitEdits` (or leave its
   arrays empty).

7. **Once the user approves, call the subagent's `execute-commit` action**
   with exactly:
   ```json
   { "plan": { "...the original plan-commit result, unmodified..." }, "decisions": { "localOnly": { ... }, "commitEdits": { ... } } }
   ```
   `plan` here is the user's raw, unedited `commits`/`localOnlyCandidates`
   from step 1 — never something this skill parsed, re-derived, or rewrote.
   `decisions` is exactly what was recorded in steps 5–6.

8. **Relay the result:**
   - `{ "ok": true, "commits": [...] }` — report each commit that was
     created (id, sha, message), and confirm any excluded local-only file is
     still untouched/untracked.
   - `{ "ok": false, "reason": "conflict" }` — tell the user the working tree
     changed since planning in a way that broke the approved plan: no new
     commit was made past the conflict, but any commits already created
     earlier in this same run remain. Suggest re-running the skill to get a
     fresh plan for whatever is left.
   - `{ "ok": false, "reason": "no-changes" }` — tell the user there was
     nothing left to commit once their decisions were applied (e.g. every
     commit was excluded and no local-only file was included).
   - `{ "ok": false, "reason": "unexpected-error" }` — report that execution
     failed unexpectedly and suggest checking the repo state by hand.

## Rules

- This skill never runs `git` directly — only the subagent does, via the
  bundled `subagent/cli.mjs` sitting next to this file.
- Two subagent calls, never one: `plan-commit` always comes first, and
  `execute-commit` is only ever called after the user has seen the plan and
  decided every local-only candidate.
- Never ask about the same `localOnlyCandidates` entry more than once, and
  never silently default a candidate to "include" or "exclude" when the user
  didn't answer — surface it again instead of guessing.

## Out of scope

- Doesn't auto-exclude or auto-`.gitignore` local-only files — v1 only asks.
- Doesn't write or edit code content, ever — only stages/commits what
  already exists in the working tree.
