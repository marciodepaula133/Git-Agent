---
title: 'push skill + subagent action'
type: 'feature'
ticket: ''
created: '2026-10-04'
status: 'in-progress'
baseline_revision: 'c7457b915803c35f9ea558ae766391dbbf146919'
route: 'full'
route_source: 'auto'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['{project-root}/docs/architecture.md', '{project-root}/docs/skills/push.md', '{project-root}/_bmad-output/specs/spec-push/SPEC.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `docs/skills/push.md` and `_bmad-output/specs/spec-push/SPEC.md` specify the `push` skill — making "never force push" a structural guarantee — but neither the `git-agent-push` skill nor a subagent `push` action exist yet. Only `create-branch` is built.

**Approach:** Add the second skill↔subagent pair, mirroring `create-branch`'s shipped shape exactly: `skills/git-agent-push/SKILL.md` relays to the user and invokes the bundled `subagent/cli.mjs push` over stdin JSON; the subagent's new `push` action runs `git push` through a `query()` Bash tool-use loop with the existing shared `noForcePushHookMatcher` wired in (reused unmodified, not reimplemented) plus a scoped allow-list hook (same pattern as `createOnlyIntendedCommandsHook`) restricting the session to the one push command it's meant to run.

## Boundaries & Constraints

**Always:**
- The subagent is the only thing that runs `git push`; it runs exclusively as a `Bash` tool call inside the `query()` session that has `noForcePushHookMatcher` registered — never `child_process` (AD-3/AD-4).
- The skill never runs git directly — only invokes the bundled `subagent/cli.mjs` and relays its JSON result in plain language (matches `git-agent-create-branch/SKILL.md`).
- Subagent I/O: one JSON object on stdin, exactly one JSON line (`{ok, ...}`) as the last stdout line; closed failure-reason enum only.
- No force flag is ever passed by the action's own prompt or allow-list hook — the shared hook is defense in depth, not the only guard.

**Never:**
- No override/exception path for force-push, under any circumstance (spec non-goal).
- No branch-parent tracking or PR creation — out of scope for this action.
- Does not manage GitHub auth/credentials — assumes `gh`/git remote auth already works.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ordinary push, branch already tracks remote | `{branchName: "feature/x"}`, upstream set | `git push` succeeds | `{ok:true, branchName}` |
| First push, no upstream yet | `{branchName: "feature/x"}`, no tracking branch | subagent runs `git push -u origin feature/x` (or detects no-upstream and adds `-u`) | `{ok:true, branchName}`, not treated as a failure |
| Remote has commits local doesn't (would need force) | push rejected by remote as non-fast-forward | push attempted once, not forced | `{ok:false, reason:'non-fast-forward'}` |
| Forced push attempted (deliberately induced in testing) | model/action issues any force-shaped push command | shared hook denies the Bash call before execution | denial surfaces in transcript; action maps to `{ok:false, reason:'unexpected-error'}` since the intended plain push never completed |
| Unexpected git/transport failure | e.g. no remote configured, auth failure | push fails for a reason outside the closed enum's named cases | `{ok:false, reason:'unexpected-error'}` |
| Malformed/missing input | stdin is `null`, `{}`, non-string `branchName` | handler validates before entering the session | `{ok:false, reason:'unexpected-error'}`, no `query()` call made |

</frozen-after-approval>

## Code Map

- `subagent/src/actions/create-branch.ts` -- direct structural template: input validation before `try`, `buildPrompt`/`parseOutcome` pattern, scoped `createOnlyIntendedCommandsHook`-style allow-list, `query()` wiring (`tools:['Bash']`, `pathToClaudeCodeExecutable:'claude'`, `permissionMode:'bypassPermissions'`, `allowDangerouslySkipPermissions:true`), stderr diagnostics on `unexpected-error`. Reuse this shape for `push.ts`, adapted to push's own outcomes.
- `subagent/src/actions/create-branch.test.ts` -- test-shape template (`fakeQuery` helper, outcome-mapping tests, hook allow/deny tests, malformed-input tests, "LAST RESULT line wins" test). Mirror for `push.test.ts`.
- `subagent/src/hooks/no-force-push.ts` -- `noForcePushHookMatcher`, already built/tested; import and reuse verbatim, do not edit.
- `subagent/src/cli.ts` -- `actions` record maps subcommand string to handler; add `'push': (input) => push(input as PushInput)` alongside the existing `'create-branch'` entry.
- `skills/git-agent-create-branch/SKILL.md` -- template for `SKILL.md` structure (frontmatter, "Hard rule", numbered Flow, bundled subagent invocation instructions, result-relay mapping, Rules, Out of scope).
- `scripts/bundle-skill-subagents.mjs:17` -- `SKILLS_NEEDING_SUBAGENT` array; add `'git-agent-push'` so `npm run bundle` also produces `skills/git-agent-push/subagent/cli.mjs`.
- `docs/architecture.md:26` -- "built/target" status line currently reads "The `create-branch` action, the `no-force-push` hook, the `git-agent-create-branch` skill..., `git-agent-setup`, and `git-agent-configure` are built; the remaining actions/skills are still target, not built." Update to add `push`/`git-agent-push`.
- `docs/skills/push.md` -- existing spec page; no content changes expected (push's rules are already fully specified there), but re-check after implementation for drift.
- No input to approve mid-flow for push (architecture rule 6: 1 call) — `SKILL.md` needs only to ask which local branch to push (default: current branch) and optionally confirm the remote, no plan/decision object to relay back.

## Tasks & Acceptance

**Execution:**
- [ ] `subagent/src/actions/push.ts` -- new action: `PushInput = {branchName: string}`; `PushResult = {ok:true, branchName:string} | {ok:false, reason:'non-fast-forward'|'unexpected-error'}`; prompt instructs the model to run `git rev-parse --abbrev-ref --symbolic-full-name <branchName>@{upstream}` (or equivalent) to check for an upstream, then either plain `git push` or `git push -u origin <branchName>` accordingly, reply `RESULT: pushed`, `RESULT: non-fast-forward`, or `RESULT: error`; wire `noForcePushHookMatcher` plus a scoped allow-list hook permitting only those exact push-shaped commands (deny everything else, mirroring `createOnlyIntendedCommandsHook`).
- [ ] `subagent/src/actions/push.test.ts` -- outcome-mapping tests (pushed/non-fast-forward/error/unparsable-result/non-success-subtype/thrown-exception), malformed-input rejection, session-options assertions (tools, hooks present, `pathToClaudeCodeExecutable`), and allow-list hook allow/deny cases (deny any `--force`/`-f`/`--force-with-lease` variant and any unrelated git command).
- [ ] `subagent/src/cli.ts` -- import `push` and add the `'push'` entry to `actions`.
- [ ] `scripts/bundle-skill-subagents.mjs` -- add `'git-agent-push'` to `SKILLS_NEEDING_SUBAGENT`.
- [ ] `skills/git-agent-push/SKILL.md` -- frontmatter (`name: git-agent-push`, description per `docs/initial-guidelines.md` naming convention); flow: determine the branch to push (default current branch, confirm with user), run bundled `subagent/cli.mjs push` with `{"branchName": "..."}` on stdin, relay `{ok:true,...}` as success and each `{ok:false, reason}` in plain language (`non-fast-forward` → remote has commits the user doesn't have locally, suggest pulling/rebasing manually — never offer a force option; `unexpected-error` → report and suggest checking repo state by hand); state the "no force, ever" hard rule up front like `create-branch`'s "Hard rule" section.
- [ ] Run `npm run bundle` to produce `skills/git-agent-push/subagent/cli.mjs`.
- [ ] `docs/architecture.md` -- update the built/target status line to include `push` / `git-agent-push`.

**Acceptance Criteria:**
- Given a local branch with an existing upstream and no conflicting remote commits, when the skill runs `push`, then `{ok:true, branchName}` is returned and the remote branch is updated.
- Given a local branch with no upstream yet, when the skill runs `push`, then the push still succeeds (`ok:true`) via an appropriate `-u`/set-upstream path, not a failure.
- Given a remote with commits the local branch doesn't have, when `push` runs, then the result is `{ok:false, reason:'non-fast-forward'}` and no force flag was ever issued.
- Given any attempt (including one deliberately induced in testing) to issue a force-push-shaped Bash command inside the `push` action's session, when the `PreToolUse` hook fires, then the command is denied before execution.

## Implementation Notes

Starting implementation per this plan; no human checkpoint available in this session (background/pre-authorized task per the invoking instructions), so the plan is self-approved at `ready-for-dev`/`in-progress` without a conversational HALT — judgment calls are recorded here and will be surfaced to the user in the PR body's "Assumed subjects" section instead of blocking mid-build.

## Plan Change Log

## Review Triage Log

## Design Notes

- **Reuse, don't re-derive, the shared hook.** `noForcePushHookMatcher` already covers every force-shaped push pattern (long/short/value-attached/combined flags) and is independently tested; `push.ts` wires it in exactly as `create-branch.ts` does, with no push-specific force-detection logic duplicated.
- **Narrow enum subset.** Of the six closed reasons, only `non-fast-forward` and `unexpected-error` are realistic outcomes for a plain push action; the others (`conflict`, `branch-exists`, `no-changes`, `invalid-target`) belong to other actions (`merge`/`finish-merge`, `create-branch`) and are not returned here.
- **No-upstream is success, not failure.** First push of a new branch has no tracking ref yet; the action's prompt must handle this as part of the ordinary happy path (`git push -u origin <branch>`), never surfacing it as an error state.

## Verification

**Commands:**
- `npm run build` -- expected: compiles cleanly.
- `npm run typecheck` -- expected: no errors under `strict: true`.
- `npm run lint` -- expected: no errors.
- `npm test` -- expected: all tests pass, including new `push.test.ts` cases.
- `npm run bundle` -- expected: `skills/git-agent-push/subagent/cli.mjs` is produced.

**Manual checks (if no CLI):**
- In a scratch git repo (not this repo), push a local branch with no upstream and confirm `{"ok":true,...}`; then simulate a non-fast-forward (diverge the remote) and confirm `{"ok":false,"reason":"non-fast-forward"}` with no force flag issued.
