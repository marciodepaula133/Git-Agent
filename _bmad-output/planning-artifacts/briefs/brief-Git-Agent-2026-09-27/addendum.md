---
title: "Addendum: Git-Agent"
created: 2026-09-27
updated: 2026-09-27
---

# Addendum: Git-Agent

Depth captured during discovery that belongs in the PRD / spec rather than the brief.

## Operation rules (from docs/initial-guidelines.md, 2026-09-27)

### Create branch
- Carry over any modified files to the new branch **without staging** them.
- Ask whether there is a task/issue number, and which branch type it is (`feature` or `fix`).
- Name pattern: `<type>/<task-or-issue-number-if-present>-<description-of-work>`.
- Must **never** lose changes when creating a branch.

### Commit
- On request, inspect modified files and **propose a commit plan** rather than one big commit.
- Use the LLM to evaluate the changes and split them into several commits when needed, each with its own context and message. Example:
  - `commit 1: <task#> - Updated form validations` → form.ts, form-values.ts
  - `commit 2: <task#> - Fixed issue with current state when page loads` → state.ts, state-values.ts
- Follow commit best practices.
- Detect local-only changes that should not be committed (env files, local dev/test configuration).
- Look for and honor any commit templates in the repo.

### Push
- Never force push, under any circumstances.

### Create PR
- Title follows the branch pattern: `<type>/<task-or-issue-number-if-present>-<description-of-work>`.
- Body: summary of changes and a short test plan (split into several test plans if needed).
- Confirm the target branch, or ask if it isn't obvious. The default is the branch the current branch was created from.

### Update branch from another
- Merge the chosen branch (local or origin) into the current one.
- On conflicts, hand off to the user to resolve, then be able to continue the merge afterwards.

## Platform constraints from Claude Code docs (checked 2026-09-27)

- **Subagents can't talk to the user.** `AskUserQuestion` is removed from subagents' tools even when it's listed. A subagent runs to completion and returns its result to the main thread. The only live interaction is permission prompts, which appear in the main session. Source: https://code.claude.com/docs/en/sub-agents.md
- **Interactive flows belong in skills that run in the main conversation.** A skill with `context: fork` runs in an isolated subagent that has no conversation history, which suits non-interactive background work. Source: https://code.claude.com/docs/en/skills.md
- **Three ways to enforce a policy:**
  1. A `PreToolUse` hook blocks a command, via exit code 2 or a `permissionDecision: "deny"`. This is the hard guarantee.
  2. The subagent's `tools` or `disallowedTools` frontmatter limits what that agent can use.
  3. `permissions.deny` in `settings.json` applies a blanket ban. Example: `Bash(git push --force*)`.

  Sources: https://code.claude.com/docs/en/hooks.md and https://code.claude.com/docs/en/sub-agents.md
- **Distribution:** native Claude Code plugins install through a marketplace (`claude plugin install <name>@<marketplace>`), not through npm. BMad installs with `npx skills add`, which copies skill folders into `.claude/skills/`. Both are viable: the npx route copies files, the plugin route is native.

## v1 implementation defaults (picked to keep scope simple, revisit later)

These fill gaps the original guidelines didn't cover. Each is a v1 default, not a permanent constraint — reasonable to change once a real spec is written for that skill.

- **Recording a branch's parent.** Git has no built-in concept of "the branch this one came from." Create-branch records the parent (a small per-branch state file, or a git config value scoped to that branch) at creation time. Create-PR reads it when present and falls back to the install-time default target branch when it's not (e.g. for branches created outside the agent).
- **Commit message shape.** If the repo has a commit template configured (`commit.template` in git config, or a `.gitmessage` file), the commit skill follows its structure. Otherwise it uses its own default message shape.
- **"Local-only" file heuristic.** v1 treats a file as local-only-looking if it is already gitignored, or if it's tracked but matches a common local-override naming pattern (`.env`, `.env.local`, and similar). This is a simple heuristic, not exhaustive — good enough to trigger the "should this be committed?" question, not meant to catch every case.
- **Merge, never rebase, for update-branch.** Consistent with the project-wide "never rebase" rule. Conflicts stop the flow and hand off to the user; the merge resumes once they're resolved.
