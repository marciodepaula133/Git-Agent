---
title: 'update-branch skill: merge/finish-merge subagent actions + SKILL.md'
type: 'feature'
ticket: ''
created: '2026-10-04'
status: 'in-progress'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/architecture.md', '{project-root}/docs/skills/update-branch.md']
baseline_revision: 'c7457b915803c35f9ea558ae766391dbbf146919'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Git-Agent has no way yet to catch a branch up with another branch safely — the user needs a merge-only flow that never rebases and stops cleanly on conflict instead of doing anything destructive.

**Approach:** Add a `git-agent-update-branch` skill plus two subagent actions, `merge` and `finish-merge`, following the exact skill/subagent split, hook, and stdin/stdout JSON conventions already established by `create-branch`.

## Boundaries & Constraints

**Always:**
- Subagent runs every git command through the SDK's `query()` Bash tool loop (never `child_process`) so the shared `noForcePushHookMatcher` and a new scoped intended-commands hook both fire (architecture rules 3/4).
- `merge`/`finish-merge` never rebase and never pass a force flag; the scoped hook denies anything not on its allowlist.
- If `from` is remote-qualified (prefix before first `/` matches an actual configured remote, checked via `git remote`), fetch that remote/branch immediately before merging (AD-10). Local `from` never triggers a fetch.
- On conflict, `merge` leaves the conflicted working tree exactly as git left it (no `git merge --abort`) and reports the conflicting files; `finish-merge` is the only thing that completes it, and only after confirming no conflict markers remain in previously-unmerged files.
- Skill never runs git directly; only invokes `subagent/cli.mjs merge` / `finish-merge` via stdin JSON, same pattern as `git-agent-create-branch`.
- Config file is never touched by the subagent; the skill has no new config field for this (doc doesn't define one) — it simply asks the user for the source branch.

**Never:**
- No `-X ours`/`-X theirs`, no `--squash`, no `git merge --abort`, no `git rebase` anywhere in either action's allowed command set.
- No custom commit message on `finish-merge`'s completing commit — always `git commit --no-edit` so the default merge message (from the already-set `MERGE_HEAD`) is used.
- `finish-merge` never blindly trusts "I resolved it" — it re-checks for unmerged paths and leftover `<<<<<<<` markers before committing.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Clean fast-forward | `merge` with local `from`, current branch is a strict ancestor | `{ ok:true, result:"fast-forward" }` | No error |
| Clean merge commit | `merge` with local `from`, histories diverged, no overlapping hunks | `{ ok:true, result:"merged" }` | No error |
| Already up to date | `merge`, `from` already an ancestor of HEAD | `{ ok:true, result:"up-to-date" }` | No error |
| Remote-qualified source | `merge` with `from:"origin/main"` | fetches `origin main` first, then merges as above | Fetch failure -> `unexpected-error` |
| Unresolvable ref | `merge` with `from` that doesn't resolve to a commit | `{ ok:false, reason:"invalid-target" }` | Stops before attempting merge |
| Merge conflict | `merge` hits overlapping hunks | `{ ok:false, reason:"conflict", files:[...] }`, working tree left mid-conflict | No merge/abort attempted |
| Finish after real resolution | `finish-merge` called, previously-conflicted files have no markers and are resolvable | stages exactly those files, `git commit --no-edit`, `{ ok:true }` | No error |
| Finish while markers remain | `finish-merge` called but a file still has `<<<<<<<` | `{ ok:false, reason:"conflict", files:[...] }`, nothing committed | Re-reports remaining files |
| Finish with no merge in progress | `finish-merge` called without a prior conflicted `merge` | `{ ok:false, reason:"unexpected-error" }` | Treated as caller misuse, not a modeled outcome |

</frozen-after-approval>

## Code Map

- `subagent/src/actions/create-branch.ts` -- pattern to mirror exactly: injectable `queryFn`, prompt-builder, scoped `PreToolUse` hook built per-call, `RESULT:` line parsing, stderr diagnostics on unexpected paths.
- `subagent/src/actions/create-branch.test.ts` -- test pattern to mirror: fake `query()` streams, hook-behavior assertions via `bashHookInput`/`decisionOf` helpers.
- `subagent/src/hooks/no-force-push.ts` -- `noForcePushHookMatcher`, reused unchanged in both new actions' sessions.
- `subagent/src/cli.ts` -- `actions` routing map; add `'merge'` and `'finish-merge'` entries.
- `skills/git-agent-create-branch/SKILL.md` -- structure/tone/invocation pattern to mirror for the new `skills/git-agent-update-branch/SKILL.md` (config ownership note, `node <skill dir>/subagent/cli.mjs <action>` invocation, result-relay table).
- `docs/skills/update-branch.md`, `docs/architecture.md` (rule 10, call-count table) -- already describe this correctly; update only if implementation diverges.
- New: `subagent/src/actions/merge.ts`, `subagent/src/actions/merge.test.ts`, `subagent/src/actions/finish-merge.ts`, `subagent/src/actions/finish-merge.test.ts`, `skills/git-agent-update-branch/SKILL.md`.

## Tasks & Acceptance

**Execution:**
- [x] `subagent/src/actions/merge.ts` -- implement `merge(input, deps)`: resolve remote-qualified `from` via live `git remote` output, conditionally fetch, verify target resolves (else `invalid-target`), run `git merge --no-edit <from>`, classify outcome (`up-to-date` / `fast-forward` / `merged` / `conflict` via unmerged-paths check) -- core action logic.
- [x] `subagent/src/actions/finish-merge.ts` -- implement `finishMerge(input, deps)`: read unmerged paths from `git status`, fail `conflict` if any still carry markers, else `git add` each then `git commit --no-edit`; no-merge-in-progress -> `unexpected-error` -- completes the hand-off half of the flow.
- [x] `subagent/src/actions/merge.test.ts`, `finish-merge.test.ts` -- cover every row of the I/O matrix plus the scoped hook's allow/deny set, following `create-branch.test.ts`'s fake-stream pattern.
- [x] `subagent/src/cli.ts` -- wire `'merge'` and `'finish-merge'` into the `actions` map.
- [x] `skills/git-agent-update-branch/SKILL.md` -- author the skill: ask for source branch, call `merge`, relay result; on `conflict`, instruct user to resolve by hand then call `finish-merge`; relay its result too.
- [x] `docs/skills/update-branch.md`, `docs/architecture.md` -- adjust only where the built shape diverges from what's written (e.g. exact `result`/`reason` values). Only `docs/architecture.md`'s "what's built" list needed updating; `docs/skills/update-branch.md` already matched the implemented shape exactly, so it was left unchanged.
- [x] `scripts/bundle-skill-subagents.mjs` -- added `'git-agent-update-branch'` to `SKILLS_NEEDING_SUBAGENT` and ran `npm run bundle`, so `skills/git-agent-update-branch/subagent/cli.mjs` ships with the skill (not called out explicitly in the Code Map, but required for the skill to be invocable at all, matching `git-agent-create-branch`'s own layout).

**Acceptance Criteria:**
- Given a local `from` branch that's a strict ancestor's descendant with no conflicting edits, when the skill calls `merge`, then it completes without any user prompt.
- Given `from:"origin/main"`, when `merge` runs, then a `git fetch origin main` is issued before the merge attempt, never after.
- Given overlapping edits, when `merge` runs, then no merge/abort command is left to complete the merge, the conflicting files are named in the result, and no commit is created.
- Given a prior conflict was resolved by hand (no markers left), when `finish-merge` runs, then exactly the previously-unmerged files are staged and one commit completes the merge, using the default merge message.
- Given neither action is ever asked to rebase or force-push, when the scoped hook sees such a command, then it denies it.

## Implementation Notes

- Outcome/conflict reporting from inside the SDK session needed more than the single-word `RESULT:` line `create-branch` uses, since `merge`/`finish-merge` sometimes have to report a file list too. Extended the convention: a `RESULT: conflict` line may be followed by one `FILE: <path>` line per conflicting/still-marker-carrying file; the action parses everything after the last `RESULT:` line for `FILE:` lines rather than assuming a fixed count.
- `finish-merge`'s scoped hook can't allow-list exact command strings the way `create-branch`'s and `merge`'s do (branch/ref names are known at call time; the unmerged file paths `finish-merge` will `git add` are only discovered live from `git status` inside the session). It instead allow-lists by command *shape*: a single bare/quoted positional `git add <path>` (excluding `-A`/`-u`/flags and the bare `.`), `git diff --check` with an optional pathspec, plus the three fixed exact commands (`git rev-parse -q --verify MERGE_HEAD`, `git status --porcelain=v1`, `git commit --no-edit`).
- Leftover-conflict-marker detection uses `git diff --check`, which already flags conflict markers natively, rather than shelling out to `grep` — keeps every command the subagent runs a `git`/`gh` command per the architecture's framing, not an incidental process call.
- `scripts/bundle-skill-subagents.mjs` needed `git-agent-update-branch` added to `SKILLS_NEEDING_SUBAGENT` and a re-run of `npm run bundle` for the new skill to actually carry a working `subagent/cli.mjs`; this also regenerated `skills/git-agent-create-branch/subagent/cli.mjs` (same shared `cli.ts`, now routing `merge`/`finish-merge` too) — expected, not a regression.

## Plan Change Log

## Review Triage Log

## Design Notes

- Outcome classification after a successful `git merge --no-edit <from>`: compare pre/post `HEAD` and parent count rather than parsing git's human-readable output — `up-to-date` (HEAD unchanged), `fast-forward` (HEAD moved, 1 parent), `merged` (HEAD moved, 2 parents).
- Conflict detection: parse `git status --porcelain=v1` for `XY` codes where either side is `U`, or `AA`/`DD` -- these are the unmerged paths reported back verbatim as `files`.
- The global failure-reason enum (`conflict`, `non-fast-forward`, `branch-exists`, `no-changes`, `invalid-target`, `unexpected-error`) is shared vocabulary across all actions, not a mandate that every action use every value — `merge`'s result type only unions `'conflict' | 'invalid-target' | 'unexpected-error'`; `non-fast-forward`/`branch-exists`/`no-changes` are push/create-branch-shaped concerns that don't arise here, matching `create-branch.ts`'s own narrower per-action union. "Already up to date" is folded into `ok:true` (a `result` value), not treated as the `no-changes` failure — it's not an error.
- `finish-merge` stages files by their exact path (one `git add <path>` per previously-unmerged file reported by `git status`), never `git add -A`/`-u`/`.` — keeps staging scoped to exactly what was conflicted.

## Verification

**Commands:**
- `npm run build` -- expected: clean compile -- ran clean.
- `npm run typecheck` -- expected: no type errors -- ran clean.
- `npm run lint` -- expected: no lint errors -- ran clean.
- `npm test` -- expected: all tests pass, including new `merge.test.ts`/`finish-merge.test.ts` -- 60/60 pass (was 44 before this change; added 10 `merge.test.ts` + a hook-shape fix round, plus `finish-merge.test.ts`'s own set).
- `npm run bundle` -- not in the plan's own list, but run to produce `skills/git-agent-update-branch/subagent/cli.mjs` -- ran clean.
