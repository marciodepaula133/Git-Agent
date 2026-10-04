---
title: 'create-pr skill (draft-pr / create-pr subagent pair)'
type: 'feature'
ticket: ''
created: '2026-10-04'
status: 'built'
baseline_revision: 'c7457b915803c35f9ea558ae766391dbbf146919'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There is no `create-pr` skill yet. Opening a PR today means hand-deriving the house title/body convention and remembering the configured default base branch every time.

**Approach:** Add the `draft-pr`/`create-pr` subagent action pair (two-call shape — `draft-pr` is read-only and self-contained, `create-pr` only runs after the user reviews/edits) plus the `git-agent-create-pr` skill that drives them, modeled directly on the `create-branch` action/skill and the `plan-commit`/`execute-commit` pair.

## Boundaries & Constraints

**Always:**
- Subagent is the only thing running `git`/`gh`, only via the SDK `query()` tool-use loop (never `child_process`), with `noForcePushHookMatcher` wired into both new actions' sessions.
- Stdin-only input, last stdout line exactly one JSON object `{ ok: boolean, ... }`; `ok:false` reason restricted to the closed enum (`conflict`, `non-fast-forward`, `branch-exists`, `no-changes`, `invalid-target`, `unexpected-error`).
- Two-call shape: `draft-pr` returns a self-contained draft; the skill does all user back-and-forth; `create-pr` is called with the user's exact final `title`/`body`/`targetBranch` — never a value the skill re-derived.
- No branch-parent tracking: `draft-pr` takes the configured `defaultPrTarget` as input (skill reads `.git-agent/config.json` directly) and only reflects the current branch's own `<type>/<task-or-issue>-<description>` shape into the title — it never inspects or stores what the branch was created from.
- Each new action gets its own `PreToolUse` command-allowlist hook (mirrors `createOnlyIntendedCommandsHook`/`planCommitReadOnlyHook`), restricting the Bash tool to exactly the commands that action needs.

**Never:**
- The subagent never reads/writes `.git-agent/config.json`.
- `create-pr` never re-derives title/body/target from the branch itself — only from the input it's given.
- No GitHub Issues integration; task/issue numbers only ever come from the branch name the user already created.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path draft | Branch `feature/42-digest-delivery`, target `main` exists, commits ahead of target | `draft-pr` → `{ ok:true, title:"feature: digest delivery (#42)", body:"## Summary\n...\n## Test plan\n...", targetBranch:"main" }` | n/a |
| No task number | Branch `fix/typo-cleanup` | title `"fix: typo cleanup"`, no `(#...)` suffix | n/a |
| Target doesn't exist | `defaultPrTarget` names a branch absent locally and on `origin` | `{ ok:false, reason:"invalid-target" }` | subagent checks both `refs/heads/<t>` and `origin/<t>` before failing |
| Nothing to PR | Current branch has no commits/diff ahead of target | `{ ok:false, reason:"no-changes" }` | checked via `git log <target>..HEAD` |
| Create succeeds | User-approved title/body/target passed to `create-pr` | `{ ok:true, url:"https://github.com/.../pull/7", number:7 }` | parsed from `gh pr create`'s own stdout URL |
| PR already exists for branch | `gh pr create` fails because one is already open for this head branch | `{ ok:false, reason:"branch-exists" }` | repurposing the closest existing enum value (no dedicated "pr-exists" reason) — flagged for user review in the PR |
| Unexpected gh/git failure | Any other failure | `{ ok:false, reason:"unexpected-error" }` | stderr diagnostics, same pattern as `create-branch.ts` |

</frozen-after-approval>

## Code Map

- `subagent/src/actions/create-branch.ts` -- structural model: `buildPrompt`/`RESULT:` line protocol, `createOnlyIntendedCommandsHook`, `queryFn` injection, stderr diagnostics on error. Copy this shape exactly.
- `subagent/src/actions/plan-commit.ts` (on `origin/feat/commit-skill`, not yet merged into `develop` — read via `git show origin/feat/commit-skill:subagent/src/actions/plan-commit.ts`) -- model for a read-only, JSON-returning action (`planCommitReadOnlyHook`, `parseOutcomeLine`/`textAfterResultLine`, JSON validation helpers). `draft-pr` follows this shape.
- `subagent/src/actions/execute-commit.ts` (same branch) -- model for a mutating action that runs a single externally-composed Bash command via a heredoc (`git apply --cached <<'PATCH'`) under a strict allowlist hook with `splitIntoSegments(command, { splitOnNewline: false })`. `create-pr` follows this shape for `gh pr create --body-file - <<'EOF'`.
- `subagent/src/hooks/no-force-push.ts` -- reuse `noForcePushHookMatcher` as-is; do not modify. (Note: `splitIntoSegments` is not exported on `develop`'s copy of this file — only on the unmerged `feat/commit-skill` copy. `create-pr.ts`'s own allowlist hook must not depend on an export this file doesn't have; write its own small segment-splitter or keep the check on the raw command string with a start-anchored regex, consistent with what `create-branch.ts`'s hook already does without any segment splitter.)
- `subagent/src/cli.ts` -- add `'draft-pr'` and `'create-pr'` entries to the `actions` map, same pattern as `'create-branch'`.
- `skills/git-agent-create-branch/SKILL.md`, `skills/git-agent-configure/SKILL.md` -- structural model for `skills/git-agent-create-pr/SKILL.md` (front matter, Hard rule(s), numbered Flow, Rules, Out of scope).
- `scripts/bundle-skill-subagents.mjs` -- add `'git-agent-create-pr'` to `SKILLS_NEEDING_SUBAGENT`.
- `docs/architecture.md`, `docs/skills/create-pr.md` -- update only if implementation diverges from what's written (e.g. the `branch-exists` repurposing above).

## Tasks & Acceptance

**Execution:**
- [ ] `subagent/src/actions/draft-pr.ts` -- read-only action; Bash-only session; validates target branch exists (local or `origin/`), computes commits-ahead via `git log <target>..HEAD`, parses current branch into `type`/`task`/`description`, builds `title` (`"<type>: <description with - as space>"`, ` (#<task>)` suffix when present) and `body` (`## Summary` bullets from commit subjects, `## Test plan` bullets grouped by top-level changed-path concern) -- the read-only half of the pair.
- [ ] `subagent/src/actions/create-pr.ts` -- mutating action; takes `{ title, body, targetBranch }` verbatim; Bash-only session with `noForcePushHookMatcher` + a dedicated allowlist hook permitting only `gh pr create --base <targetBranch> --title "<title>" --body-file - <<'EOF' ... EOF`; parses the created PR's URL/number from the model's `RESULT: ok` JSON -- the mutating half of the pair.
- [ ] `subagent/src/cli.ts` -- route `'draft-pr'` and `'create-pr'`.
- [ ] `subagent/src/actions/draft-pr.test.ts`, `subagent/src/actions/create-pr.test.ts` -- same structure as `create-branch.test.ts`: outcome mapping, hook wiring assertions, malformed-input rejection without invoking the session, last-`RESULT:`-line-wins, and allowlist-hook allow/deny cases.
- [ ] `skills/git-agent-create-pr/SKILL.md` -- reads `.git-agent/config.json` for `defaultPrTarget` directly (falls back to asking the user if absent); calls `draft-pr`; presents the draft and lets the user edit title/body and confirm/override the target; calls `create-pr` with the user's final raw values; relays the closed-enum result.
- [ ] `scripts/bundle-skill-subagents.mjs` -- add `'git-agent-create-pr'`; run `npm run bundle`.
- [ ] `docs/architecture.md` / `docs/skills/create-pr.md` -- sync any divergence (expected: the `branch-exists` repurposing, and the exact title/body convention chosen above).

**Acceptance Criteria:**
- Given a branch and an existing target with commits ahead, when `draft-pr` runs, then it returns `ok:true` with a title following `<type>: <description>` (+ `(#task)` when present) and a body containing at least `## Summary` and `## Test plan` sections.
- Given a target branch missing both locally and on `origin`, when `draft-pr` runs, then it returns `{ ok:false, reason:"invalid-target" }` without running `gh`.
- Given a user-approved `{ title, body, targetBranch }`, when `create-pr` runs, then it invokes exactly one allowlisted `gh pr create` command and returns `{ ok:true, url, number }` parsed from that command's real output.
- Given any Bash command outside each action's allowlist, when the session attempts it, then the `PreToolUse` hook denies it.

## Implementation Notes

Implemented by a dispatched subagent per plan, then self-reviewed by the supervising session. All tasks completed as scoped: `draft-pr.ts`, `create-pr.ts`, both test files, `cli.ts` routing, `skills/git-agent-create-pr/SKILL.md`, `scripts/bundle-skill-subagents.mjs` + rebundle (which also regenerated `skills/git-agent-create-branch/subagent/cli.mjs`, expected since it's the same single routed binary copied per skill), and doc sync in `docs/architecture.md`/`docs/skills/create-pr.md`. `npm run build`/`typecheck`/`lint`/`test` all clean (55/55 tests). Removed a stray `_bmad/render/` scratch directory (left over from invoking the bmad-build skill itself, not part of the deliverable) before committing.

## Plan Change Log

## Review Triage Log

## Design Notes

Title convention (no existing precedent to copy, so fixed here): split the current branch name on the first `/` into `type` and `rest`; if `rest` matches `^(\d+)-(.+)$`, that's `task`+`description`, else `description = rest` and no task. `title = "${type}: ${description.replace(/-/g, ' ')}"`, with `" (#${task})"` appended when `task` is present. Example: `feature/42-digest-delivery` → `"feature: digest delivery (#42)"`.

Body convention: `## Summary` as one bullet per `git log <target>..HEAD --format=%s` line; `## Test plan` as one checklist item (`- [ ] ...`) per distinct top-two-path-segment "concern" touched by `git diff <target>...HEAD --name-only` (e.g. all of `subagent/src/actions/*` is one concern, `skills/git-agent-create-pr/*` another) — satisfies the spec's "split into multiple test-plan items when the change touches more than one concern" without inventing per-file detail the model can't verify.

`create-pr`'s `gh pr create` invocation: `gh pr create --base "<targetBranch>" --title "<title>" --body-file - <<'EOF'\n<body>\nEOF` as one Bash command — mirrors `execute-commit.ts`'s inline-heredoc pattern (never pipe the body in from a separate command). Capture the real PR URL from the command's own stdout (gh prints it on success) rather than having the model fabricate one.

## Verification

**Commands:**
- `npm run build` -- expected: compiles cleanly, no TS errors.
- `npm run typecheck` -- expected: no type errors under `strict: true`.
- `npm run lint` -- expected: no ESLint errors.
- `npm run test` -- expected: all existing + new tests pass.
- `npm run bundle` -- expected: `skills/git-agent-create-pr/subagent/cli.mjs` is produced with no errors.
