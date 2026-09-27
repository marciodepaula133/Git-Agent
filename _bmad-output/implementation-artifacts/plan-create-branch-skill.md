---
title: 'create-branch skill + subagent action'
type: 'feature'
ticket: ''
created: '2026-09-27'
status: 'built'
baseline_revision: '19a00815a752eecb24187c1104a66dd00be8ad75'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
context: ['{project-root}/docs/architecture.md', '{project-root}/docs/skills/create-branch.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Git-Agent has only a scaffolded TypeScript project (`subagent/src/cli.ts` is a placeholder) — there is no working `create-branch` skill, no subagent action, and no way to actually create a task branch that preserves uncommitted changes the way `docs/skills/create-branch.md` specifies.

**Approach:** Implement the first end-to-end skill↔subagent pair: `skills/git-agent-create-branch/SKILL.md` (invoked as `/git-agent-create-branch`, prefixed per `docs/initial-guidelines.md` and BMad's own naming convention, avoiding collisions with other installed skills) gathers type/task/description, validates type against `.git-agent/config.json` (fallback `["feature","fix"]` if absent), then runs `npx --yes git-agent create-branch` with the resolved branch name on stdin. The subagent's new `create-branch` action creates that branch via `query()`'s Bash tool-use loop with the shared `no-force-push` hook wired in from the start.

## Boundaries & Constraints

**Always:**
- No modification is staged, committed, or altered by branch creation — `git checkout -b` from the current HEAD naturally preserves the dirty working tree; nothing else may touch it.
- Branch name is exactly `<type>/<task-or-issue>-<description>` (no dangling separator when task is omitted).
- Every git command the subagent issues runs as a `Bash` tool call inside the `query()` session that registers `no-force-push` (AD-3/AD-4) — never `child_process`.
- Subagent I/O: single JSON object on stdin, exactly one JSON line (`{ok, ...}`) as the last stdout line; failure `reason` is one of the closed enum (here: `branch-exists`, `unexpected-error`).
- Type validation against configured task types happens in the skill (conversational), not the subagent — the subagent has no config access (AD-8).

**Never:**
- No `install/setup.ts`, no `configure` skill, no config-writing (FR-10/FR-12) — out of scope; config is read-only here with a hardcoded fallback.
- No branch-parent tracking, no staging/commit logic (belongs to the `commit` skill).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path, dirty tree | type=feature, task=42, desc="digest-delivery", uncommitted mods present | branch `feature/42-digest-delivery` created, HEAD moved, mods still present & unstaged | none |
| No task number | type=fix, task omitted, desc="typo" | branch `fix/typo` (no leading dash) | none |
| Type not in config | user supplies "hotfix", config only allows feature/fix | skill re-asks for a valid type; subagent never called | n/a (handled in skill) |
| Branch name collision | requested name already exists as a local branch | `{ok:false, reason:'branch-exists'}`, no new ref created | closed-enum reason relayed to user |
| Missing `.git-agent/config.json` | file absent | skill falls back to `["feature","fix"]`, no error | none |
| Push-shaped command in any subagent session | a future/mistaken action issues a force-push-like Bash call | `no-force-push` hook denies it (`permissionDecision:'deny'`) | denial reason surfaces in the session transcript |

</frozen-after-approval>

## Code Map

- `subagent/src/cli.ts` -- placeholder `console.log(...)`; replace with stdin-JSON-in / one-JSON-line-out dispatch per `docs/architecture.md` Conventions.
- `subagent/src/actions/`, `subagent/src/hooks/`, `skills/` -- none exist yet; create `actions/create-branch.ts`, `hooks/no-force-push.ts`, `skills/git-agent-create-branch/SKILL.md`.
- `docs/skills/create-branch.md`, `docs/architecture.md` (rules 1,3,4,5,6,8 + Conventions) -- binding spec: branch naming, "never lose uncommitted work", one subagent call, call shape, hook mechanics, stdin/stdout contract, config ownership. Both currently show the skill as bare `create-branch`; `docs/initial-guidelines.md:39` and this session confirm the installed/invoked name is prefixed (`git-agent-create-branch`) — docs need a small correction alongside this build (Known Pitfalls in CLAUDE.md).
- `package.json` -- no `bin` entry, no SDK dependency yet; add both (`@anthropic-ai/claude-agent-sdk@^0.3.283`, live-checked against npm).
- SDK types (`sdk.d.ts`) -- `query({prompt, options}): Query`; `options.hooks.PreToolUse: HookCallbackMatcher[]`; `PreToolUseHookInput = {hook_event_name, tool_name, tool_input, ...}`; hook returns `permissionDecision: 'allow'|'deny'` (never `'ask'`/`'defer'` — no human to prompt here); restrict session to `tools: ['Bash']`.
- `skills-lock.json` -- shows the existing generic `npx skills add <repo> --skill <name>` mechanism (copies `skills/<name>/SKILL.md` from a GitHub source) already used for this project's own BMad skills. Confirms a plain `skills/git-agent-create-branch/SKILL.md` is all "installable via npx" needs on the skill side — no custom installer code.

## Tasks & Acceptance

**Execution:**
- [ ] `package.json` -- add `@anthropic-ai/claude-agent-sdk` (`^0.3.283`) dependency and a `"git-agent": "dist/cli.js"` bin entry, matching the PRD's `npx git-agent <action>` model.
- [ ] `subagent/src/hooks/no-force-push.ts` -- add `noForcePushHook`: a `PreToolUse` callback matching the `Bash` tool, tokenizing `tool_input.command` (not one regex over the raw string), denying anything force-push-shaped (`--force`, `-f`, `--force-with-lease=<ref>`, combined flags like `-uf`) or unrecognized as a plain push, allowing everything else through.
- [ ] `subagent/src/actions/create-branch.ts` -- handler for `{branchName: string}`: run a `query()` session (`tools: ['Bash']`, hook above) whose prompt checks existence (`git show-ref --verify --quiet refs/heads/<name>`) then `git checkout -b <name>` if absent; map the outcome to `{ok:true, branchName}` or `{ok:false, reason:'branch-exists'|'unexpected-error'}`.
- [ ] `subagent/src/cli.ts` -- replace the placeholder: read all of stdin, `JSON.parse`, dispatch `process.argv[2]` through an action map, print the result as the final JSON line; reserve non-zero exit for a genuinely unexpected top-level throw, never an `ok:false` result.
- [ ] `skills/git-agent-create-branch/SKILL.md` -- name: `git-agent-create-branch` (invoked as `/git-agent-create-branch`, prefixed to avoid collisions per `docs/initial-guidelines.md`); ask for an optional task/issue number and a type; read `.git-agent/config.json`'s `taskTypes` (fallback `["feature","fix"]`), re-asking if the type isn't allowed; ask for a short kebab-case description; compute `<type>/<task-or-issue>-<description>`; run `npx --yes git-agent create-branch` via Bash, piping `{"branchName": "..."}` on stdin; relay the parsed result to the user.
- [ ] `docs/skills/create-branch.md`, `docs/architecture.md` -- correct the skill's shown name/path from bare `create-branch` to `git-agent-create-branch` (Shape/directory-mapping sections), matching what was actually built.
- [ ] `subagent/src/hooks/no-force-push.test.ts`, `subagent/src/actions/create-branch.test.ts` -- cover the hook's token parsing and the action's outcome mapping per the I/O matrix.

**Acceptance Criteria:**
- Given uncommitted modifications and no branch of that name, when the skill runs create-branch with a valid type/task/description, then a branch named `<type>/<task-or-issue>-<description>` exists, HEAD points to it, and the modifications are present and unstaged.
- Given a branch name that already exists, when create-branch runs, then the result is `{ok:false, reason:'branch-exists'}` and no new ref is created.
- Given `.git-agent/config.json` is absent, when the skill validates the supplied type, then it falls back to `["feature","fix"]` without erroring.
- Given any subagent session issues a force-push-shaped `Bash` call, when the hook's `PreToolUse` matcher fires, then the call is denied with `permissionDecision:'deny'`.

## Implementation Notes

Implemented per plan (package.json, no-force-push.ts, create-branch.ts, cli.ts rewrite, SKILL.md, doc corrections, tests). Independently re-ran verification at review time: `npm run typecheck`, `npm run lint`, `npm test` (17/17 passing) all green; re-ran the manual scratch-repo check myself (isolated `/tmp` repo, not this repo) — `create-branch` on a dirty tree produced `{"ok":true,...}` with the modification still present and unstaged, and a repeat call against the same name produced `{"ok":false,"reason":"branch-exists"}`.

Matrix Test Audit: rows "No task number", "Type not in config", and "Missing .git-agent/config.json" describe `SKILL.md` conversational behavior (branch-name assembly, config fallback, re-ask on invalid type) with no backing TypeScript — there is no code path for `node:test` to exercise. Confirmed by reading the shipped `skills/git-agent-create-branch/SKILL.md` that steps 2 and 4 specify exactly the matrix's expected behavior (silent `["feature","fix"]` fallback, re-ask on mismatch, no dangling separator when task is omitted); treated as covered by design/inspection rather than an automated test, since none is buildable for prompt-only skill instructions in this repo's current test setup. Rows "Happy path" and "Branch name collision" are covered by both the automated `create-branch.test.ts` outcome-mapping tests and the manual scratch-repo re-run above. The "push-shaped command" row is covered by `no-force-push.test.ts` (17 cases).

## Plan Change Log

## Review Triage Log

Lenses run: blind-hunter, edge-case-hunter, verification-gap, intent-alignment (all four reported; no subagent-unavailable fallback needed).

1. **verdict: high, route: patch** — `subagent/src/actions/create-branch.ts:56` destructures `branchName` from `input` *before* the `try` block starts (line 58); `subagent/src/cli.ts` never validates that parsed JSON is an object with a string `branchName` before calling the handler. Malformed-but-valid JSON on stdin (`null`, `42`, `"x"`, `[]`, or `{}` with no `branchName`) throws synchronously inside `createBranch`, which — as an `async` function — turns into a rejected promise that propagates through `main()`'s `await handler(input)` to `main().catch(...)`, producing a non-zero exit with **no JSON line printed at all**. Verified by tracing: line 56 is textually before line 58's `try {`. This violates `docs/architecture.md`'s own contract ("last line of stdout is always exactly one JSON object... non-zero exit reserved for genuinely unexpected failures, never for ordinary `ok:false`") on a plausible, easily-reachable input. Merges blind-hunter's cli.ts-validation finding, edge-case-hunter's two structurally-identical findings (create-branch.ts:56, cli.ts:36) and its two claim-mismatch findings citing the same root cause, and verification-gap's pre-verified finding that `cli.ts`'s dispatch path has zero test coverage (arrives pre-verified per triage rules; its suggested fix — a `cli.test.ts` spawning the built CLI with piped stdin, including malformed input — is exactly what would have caught this).
2. **verdict: high, route: patch** — `subagent/src/hooks/no-force-push.ts`'s `findSubcommandIndex` (the function `isPushShaped` relies on to locate `push`) returns the index of the *first token after `git` that doesn't start with `-`* — so a git global option that takes a value, e.g. `git -C /tmp push --force` or `git -c x=y push --force`, makes it land on the option's *value* (`/tmp`, `x=y`) instead of `push`. `isPushShaped` then returns `false`, `evaluateSegment` returns `null`, and the force-push is allowed straight through — a verified, structural bypass of the project's single explicitly-"structural" safety guarantee (`docs/architecture.md` rule 3). Verified by tracing the deterministic token logic (no LLM involved, so no empirical run needed to be certain). Merges blind-hunter's wrapped-invocation finding (the `-C`/`-c` case specifically — see finding 5 for the broader eval/command-substitution case, kept separate since its fix is not equally bounded) and edge-case-hunter's matching finding plus its claim-mismatch finding citing the same root cause.
3. **verdict: low, route: patch** — `no-force-push.ts`'s `isPushShaped` for `gh` checks whether *any* token after `gh` equals `push` (`tokens.slice(1).some(...)`), not just the subcommand position — so a wholly unrelated, legitimate command like `gh issue create --title push` is denied as an "unrecognized push-equivalent." No test exercises any `gh` command, and no action in this diff (or the codebase) actually calls `gh` yet, so there is no live caller hitting this today; graded low rather than rejected because the fix is a trivial, direct correction (check the subcommand position, same as the `git` branch already does) and this hook is explicitly shared infrastructure future actions will call into. Merges blind-hunter's missing-gh-coverage finding, edge-case-hunter's over-broad-denial finding, and its claim-mismatch finding citing the same root cause.
4. **verdict: medium, route: patch** — `docs/skills/create-branch.md`'s hard rule and this plan's own frozen "Always" bullet ("No modification is staged, committed, or altered by branch creation") are enforced, in the shipped code, *only* by natural-language instructions inside `create-branch.ts`'s prompt ("Never run git push, git commit, git add, git reset, git rebase, git stash... Never modify, stage, or drop any file"). The session's only code-level restriction is `tools: ['Bash']` plus the `no-force-push` hook, which only screens push-shaped commands — nothing stops a `git add`/`commit`/`stash`/`reset` from executing if the model deviates from its five numbered steps. This is a real inconsistency with `docs/architecture.md`'s own stated rationale for hooks over prompts ("a prompt instruction can be argued past or simply missed; a hook... cannot"), applied here to the plan's own "single most important guarantee." Likelihood is low (the prompt is short, tightly scripted, and gives the model no reason to deviate) but consequence is high (irreversible working-tree loss), so graded medium. Smallest fix: constrain `create-branch.ts`'s session to allow only the two exact git subcommands its own prompt uses (`show-ref`, `checkout`) via an additional scoped hook/matcher, denying everything else — bounded, no new public surface, directly delivers the already-frozen invariant rather than reopening it. From intent-alignment's divergence report (§3, "surface of the hard rule's enforcement").
5. **verdict: low, route: patch** — `create-branch.ts`'s `RESULT_LINE` regex (`/^RESULT:\s*(created|branch-exists|error)\s*$/im`) uses `.exec`, which returns the *first* matching line in the model's final result text. If that text ever contains more than one line matching the pattern (e.g. the model echoes the protocol before its real final answer), the wrong outcome is parsed. Likelihood is low given the prompt demands "reply with exactly one line," but the fix (scan for the *last* matching line instead of the first) is a direct, trivial correction. From blind-hunter.
6. **verdict: false** — blind-hunter's concern that `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` might cause the SDK to skip `PreToolUse` hook evaluation entirely (which would silently neutralize the whole no-force-push guarantee), and that `allowDangerouslySkipPermissions` might not be a real SDK option. Refuted empirically: ran a live `query()` session with these exact two options and a deny-everything `PreToolUse` hook against a real `claude` CLI backend — the hook fired and its `deny` decision was honored (command blocked, reported back as denied). `allowDangerouslySkipPermissions` is also confirmed real and correctly paired in the installed SDK's own `sdk.d.ts` (`permissionMode: 'bypassPermissions'` "requires `allowDangerouslySkipPermissions`").
7. **verdict: false** — blind-hunter's concern that `skills/git-agent-create-branch/SKILL.md`'s `npx --yes git-agent create-branch` invocation has no fallback for the package not being published yet. True today, but this is the plan's own deliberate, human-approved Design Notes decision: production behavior matches the PRD's npx-distribution model, and pre-publish verification is explicitly documented to go through `node dist/cli.js` directly instead. Not a defect relative to the frozen intent, which specifies exactly this invocation.
8. **verdict: false** — blind-hunter's, edge-case-hunter's, and intent-alignment's flagging of the `.claude/scheduled_tasks.lock` deletion and the new plan file as "outside stated intent" / unexplained noise. The lock-file deletion predates this entire session (present in `git status` before any planning began) and the user explicitly instructed leaving it as-is; the plan file is the expected BMad workflow artifact for this build, not incidental scope creep.
9. **verdict: false** — blind-hunter's concern that `package.json`'s new `test` script might depend on `tsconfig.json` compiling `*.test.ts` into `dist/` in a way that isn't actually verified, such that `node --test` could silently match zero files and report a false pass. Refuted by independently re-running `npm test` myself on the actual working tree (not trusting the implementer's report): 17/17 tests executed and passed; `tsconfig.json`'s `include: ["subagent/src"]` carries no exclude for test files.
10. **verdict: false, no action** — blind-hunter's and intent-alignment's observation that the I/O matrix's three `SKILL.md`-only rows (no task number, type-not-in-config, missing-config fallback) have no backing automated test. Already transparently self-disclosed in this plan's own Implementation Notes at review time, with the reasoning for why no test is buildable for prompt-only skill instructions in this repo's current setup — not a hidden gap.
11. **verdict: medium (unverified severity as filed), route: defer** — verification-gap's pre-verified finding that none of `CLAUDE.md`'s documented "Running and verifying" commands (`npm install`/`build`/`typecheck`/`lint`) include `npm test`, so a contributor following it exactly would never run the new safety-relevant hook tests; no CI exists either. Arrives pre-verified per triage rules (skip re-verification, trust the filed evidence). Its filed disposition (`patch`: add `npm test` to `CLAUDE.md`) is overridden by the standing rule that any finding whose fix edits an agent-context file (`CLAUDE.md` named explicitly) routes to `defer` regardless of the lens's suggestion.

## Design Notes

- **npx invocation, not a resolved local path.** The skill shells `npx --yes git-agent create-branch`, matching the PRD's npx distribution model (no install step once published). Before publishing, verify with `node dist/cli.js create-branch` against the built output — same contract, different invocation.
- **No shared session-launcher abstraction yet.** Only one action exists, so `create-branch.ts` wires `query()` + the hook inline; extract a shared launcher when a second action is added, not speculatively now.
- **Existence pre-check.** A dedicated `git show-ref --verify --quiet` call makes `branch-exists` unambiguous to detect, rather than pattern-matching git's stderr from a failed `checkout -b`.

## Verification

**Commands:**
- `npm run build` -- expected: compiles cleanly, `dist/cli.js` exists.
- `npm run typecheck` -- expected: no errors under `strict: true`.
- `npm run lint` -- expected: no errors.
- Manual, in a scratch git repo with an uncommitted modification: `node dist/cli.js create-branch <<< "{\"branchName\":\"feature/42-test\"}"` -- expected: branch created, modification still present and unstaged, one JSON line `{"ok":true,...}` printed; re-running the same command -- expected: `{"ok":false,"reason":"branch-exists"}`.
