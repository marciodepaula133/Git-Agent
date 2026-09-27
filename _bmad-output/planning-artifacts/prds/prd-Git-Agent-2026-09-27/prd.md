---
title: "PRD: Git-Agent"
status: final
created: 2026-09-27
updated: 2026-09-27
note: "Updated post-architecture to reconcile with the Git-Agent architecture spine (architecture-Git-Agent-2026-09-27): branch-parent tracking dropped (FR-8), a sixth 'configure' skill added (FR-12), FR-4 wording corrected."
---

# PRD: Git-Agent

## 0. Document Purpose

This PRD turns the [Product Brief](../../briefs/brief-Git-Agent-2026-09-27/brief.md)'s vision and scope into concrete, testable requirements for building Git-Agent. It is written for the author, who is both PM and sole developer on this project, and it feeds directly into the next steps: architecture (to resolve the open questions below) and per-skill implementation tickets. Features are grouped by the five skills named in the brief; functional requirements (FRs) are numbered globally so tickets can reference them by stable ID. `[ASSUMPTION]` tags mark places this PRD inferred detail the brief didn't specify.

## 1. Vision

Git-Agent is a small, opinionated git workflow, expressed as six Claude Code skills backed by one dedicated subagent (five workflow skills plus a configure skill added during architecture), that does exactly what its author would do by hand — split commits by topic, name branches and PRs to a fixed pattern, never force push, never lose uncommitted work — without having to re-derive those habits every session, in every repo.

Its real payoff isn't the tool itself: it's a working, explainable example of the skill + subagent + hook + install-question pattern for building disciplined Claude Code agents, one the author can point to and rebuild for the next unrelated workflow.

## 2. Target User

### 2.1 Jobs To Be Done

- As the author, I want my git habits enforced automatically so I don't have to remember or re-apply them under time pressure in every repo.
- As the author, I want a hard guarantee (not just a prompt suggestion) that I never force push or lose uncommitted changes.
- As the author, I want a concrete, working example I can dissect and explain, so I can rebuild this pattern for other agents later.
- As a secondary user (anyone else with Claude Code + authenticated `gh`), I want to install someone else's disciplined git workflow into my repo without adopting their whole toolchain.

### 2.2 Non-Users (v1)

- Teams wanting a shared, centrally-configured git policy across many contributors — v1's config surface (task/branch types, default PR target) is per-repo and self-serve, not centrally managed.
- Anyone wanting code-writing or code-review assistance — Git-Agent never touches code content, only git/GitHub mechanics.

### 2.3 Key User Journeys

*Solo developer-tool scope — journeys are one-sentence JTBD restatements rather than full narratives.*

- **UJ-1.** The author, mid-feature with uncommitted changes and a new task number in hand, runs create-branch and gets a correctly named branch with nothing lost.
- **UJ-2.** The author, with a messy working tree touching two unrelated things, runs commit and gets a clean, split commit plan to approve rather than building it by hand.
- **UJ-3.** The author, ready to open a PR, runs create-PR and gets a title and body that already follow the house convention, targeting the right base branch.
- **UJ-4.** The author needs their feature branch caught up with `main` and runs update-branch, trusting it will never rebase and will stop cleanly on conflicts.

## 3. Glossary

- **Skill** — A Claude Code skill: the conversational entry point for one of the six workflows (create branch, commit, push, create PR, update branch, configure). Holds the conversation with the user.
- **Subagent** — The single dedicated git subagent shared by the five workflow skills (not configure, which does its own file I/O), which performs the mechanical git/GitHub work (diff analysis, commit planning, running `git`/`gh` commands).
- **Hook** — A Claude Code `PreToolUse` hook enforcing the no-force-push rule as a platform-level guarantee rather than a prompt instruction.
- **Task/branch type** — The category (`feature`/`fix`, extensible) used both in branch naming and as a per-repo config default.
- **Local-only file** — A modified or untracked file that looks like it shouldn't be committed (e.g. `.env`), which commit must ask about rather than silently include or exclude.
- **Test repository** — The small, disposable repository used to verify each skill's behavior against a known starting state.
- **Config file** — The per-repo file storing the configurable surface for v1 (task/branch types, default PR target branch).

## 4. Features

### 4.1 Create Branch

**Description:** Starts a new branch for a task without losing whatever is already in the working tree. Realizes UJ-1.

#### FR-1: Preserve uncommitted changes across branch creation

The skill can create a new branch while carrying over the user's currently modified (but not necessarily staged) changes.

**Consequences (testable):**
- Against the test repository, starting with uncommitted modifications, running create-branch results in those same modifications present and unstaged on the new branch.
- No modification is staged automatically as a side effect of branch creation.

#### FR-2: Name branches by a fixed convention

The skill asks the user for a task/issue number and a type (`feature`/`fix`, or another configured type), then creates a branch named `<type>/<task-or-issue>-<description>`.

**Consequences (testable):**
- Given a type and task number, the resulting branch name matches `<type>/<task-or-issue>-<description>` exactly.
- If the user supplies a type not in the repo's configured list, the skill asks for clarification rather than silently accepting it.

### 4.2 Commit

**Description:** Turns a working tree's modifications into one or more well-scoped commits, asking the user to approve the plan and to weigh in on anything that looks local-only. Realizes UJ-2.

#### FR-3: Propose a multi-commit plan split by topic

The subagent inspects modified files and proposes a commit plan that splits unrelated changes into separate commits, including splitting within a single file when it holds two unrelated topics (showing which lines go to which commit).

**Consequences (testable):**
- Against a test-repo scenario with two unrelated changes in one file, the proposed plan puts those changes into two different commits with correct line attribution.
- The user sees and approves the plan before any commit is made; no commit happens on a plan the user hasn't confirmed.

#### FR-4: Ask about local-only-looking files

Before committing, the subagent identifies files that look local-only (e.g. `.env`-style names) as part of its commit plan, and the skill asks the user whether each should be included, rather than deciding automatically.

**Consequences (testable):**
- Against a test-repo scenario containing an untracked `.env`-like file, the skill surfaces it and blocks on a user decision before committing, rather than including or excluding it silently.

#### FR-5: Follow a repo's own commit template when present

When the target repository defines its own commit message template, the proposed commit messages follow it instead of a hardcoded default.

**Consequences (testable):**
- In a test repo with a configured commit template, generated commit messages match that template's structure; in a test repo without one, a documented default format is used.

### 4.3 Push

**Description:** Pushes committed work to the remote, with force-pushing made structurally impossible rather than merely discouraged. Realizes the brief's "never lose work / never force push" guarantee.

#### FR-6: Never force push, under any circumstance

The push skill never executes a force push, and this is enforced by a `PreToolUse` hook that blocks any force-push invocation regardless of what the skill or subagent attempts.

**Consequences (testable):**
- A direct attempt (including a deliberately induced one, e.g. during testing) to run `git push --force` or `--force-with-lease` through the agent's tool path is blocked by the hook before execution.
- Ordinary (non-force) pushes succeed unaffected by the hook.

### 4.4 Create PR

**Description:** Opens a pull request whose title and body follow the house convention, targeting the right base branch. Realizes UJ-3.

#### FR-7: Title and body follow the naming and structure convention

The PR title follows the same pattern as the branch name; the body contains a summary and a test plan, split into several test-plan items when the change touches more than one concern.

**Consequences (testable):**
- For a branch named per FR-2's pattern, the generated PR title reflects that same type/task/description.
- The generated PR body contains at minimum a summary section and a test plan section.

#### FR-8: Default target branch to the repo's configured default, letting the user override

Create-PR always proposes the repo's configured default target branch (set at install time / via the configure skill), and lets the user change it before the PR is created. Git-Agent does not track or detect a branch's parent.

**Consequences (testable):**
- For any branch, regardless of how it was created, create-PR proposes the repo's configured default target branch as the target.
- The user can override the proposed target before create-PR runs; overriding does not require any prior tracking of that branch's history.

**Notes:** An earlier draft of this PRD considered detecting a branch's "parent" to default the target branch. Architecture (see the Git-Agent architecture spine, AD-7) scrapped that mechanism as unnecessary complexity relative to a simple default-plus-override — resolves former Open Question 2.

### 4.5 Update Branch

**Description:** Brings a branch up to date from another branch via merge only, stopping cleanly on conflicts. Realizes UJ-4.

#### FR-9: Merge only, never rebase; stop and hand off on conflicts

The skill merges a chosen branch (local or from `origin`) into the current branch. It never rebases. On merge conflicts, it stops, reports the conflict, and hands control back to the user, and can resume once the user has resolved conflicts.

**Consequences (testable):**
- In a test-repo scenario with a clean fast-forward-able merge, the skill completes the merge without prompting for conflict resolution.
- In a test-repo scenario engineered to conflict, the skill stops before completing the merge, clearly reports which files conflict, and does not attempt a rebase as a workaround.
- Once the user resolves conflicts and signals completion, the skill can finish the merge (e.g. commit the resolution) rather than requiring the user to do so manually outside the agent.

### 4.6 Installation and Configuration

**Description:** Distributes Git-Agent as an `npx`-installed package (author's own repository, not a marketplace plugin) and captures the small v1 configuration surface at first install.

#### FR-10: First-run setup asks a small set of configuration questions

Installing the package via `npx` runs a first-time setup that asks for default task/branch types and a default PR target branch, then writes them to a per-repo config file.

**Consequences (testable):**
- Running the installer against a fresh test repo produces a config file containing the answered task/branch types and default PR target branch.
- Re-running the installer against an already-configured repo does not silently overwrite existing config without the user's confirmation. `[ASSUMPTION: re-install behavior wasn't specified in the brief — confirm before finalizing.]`

#### FR-11: Skills read the per-repo config file for task/branch types and default PR target

All skills that reference task/branch types (FR-2) or a default PR target (FR-8) read them from the config file written by FR-10 (or updated by configure, FR-12), rather than hardcoding values.

**Consequences (testable):**
- Changing the config file's task types changes what create-branch accepts, without any code change.

### 4.7 Configure

**Description:** Lets the user redo the per-repo config surface (task/branch types, default PR target) at any time, without re-running the `npx` installer. Added during architecture (see the Git-Agent architecture spine) as a sixth skill, reversing this PRD's original v1 scope of five skills only.

#### FR-12: A configure skill lets the user redo the config surface on demand

Running the configure skill asks the same questions as first-run setup (FR-10), shows the current config values, and writes confirmed changes back to the config file.

**Consequences (testable):**
- Running the configure skill against a configured test repo shows the existing task types and default PR target, and updates the config file to match whatever the user confirms/changes.

## 5. Non-Goals (Explicit)

- Git-Agent does not write, edit, or review code content, at any point, in any skill.
- Git-Agent does not rebase, in any flow (update-branch merges only).
- Git-Agent does not integrate with GitHub Issues or any issue tracker in v1 — task/issue numbers are always typed by the user.
- Git-Agent does not automatically handle local-only files (no auto-exclude, no auto-`.gitignore` edits) — v1 only asks (FR-4).
- Git-Agent does not offer broad, general-purpose configurability in v1 — the config surface is deliberately limited to task/branch types and default PR target (FR-10, FR-11).
- Git-Agent does not manage its own GitHub account or credentials — it uses whichever account the repo's `gh` CLI is already authenticated as.

## 6. MVP Scope

### 6.1 In Scope

- All six skills (create branch, commit, push, create PR, update branch, configure), each implemented and documented, built and shipped **in that order**, one at a time.
- One dedicated git subagent shared by the five workflow skills.
- The `PreToolUse` no-force-push hook (FR-6).
- `npx`-based installer with first-run setup (FR-10) and a per-repo config file (FR-11).
- A disposable test repository, used to verify each skill's behavior per the Consequences listed under FR-1 through FR-9.
- An indexed `docs/` folder describing what's defined, where, and why.

### 6.2 Out of Scope for MVP

- Rebase support (any flow) — deferred indefinitely, not just v1; see Non-Goals.
- GitHub Issues integration — possible future version once the manual-entry flow is proven.
- Automatic local-only-file handling — v1's ask-every-time behavior is intentional, not a placeholder.
- Centrally managed / team-wide configuration — v1 is per-repo, self-serve config only.
- Any second subagent, or any skill beyond the six named (the five workflow skills plus configure) — additions here are explicitly a v2+ conversation.

## 7. Success Metrics

*Adapted from the brief's Success Criteria. This is a solo learning project first, a working tool second — metrics reflect that weighting rather than a quantitative launch breakdown.*

**Primary (learning)**
- **SM-1**: The author can explain, unprompted, how each of the five skills splits work between the main-conversation skill and the git subagent, and why. Validates the whole FR set as a teaching artifact.
- **SM-2**: The author can point to the FR-6 hook and explain why a hook was needed instead of a prompt instruction alone. Validates FR-6.
- **SM-3**: The author could rebuild the skill + subagent + hook + install-question pattern for a new, unrelated agent without starting from zero.

**Secondary (product)**
- **SM-4**: All six skills (FR-1 through FR-12) are implemented and each does its documented job in a real repository, used by the author day to day.
- **SM-5**: Across ordinary use, Git-Agent never loses uncommitted local changes and never force pushes. Validates the Cross-Cutting NFRs in §8.
- **SM-6**: `docs/` contains a complete, indexed description of what's defined, where, and why.

**Counter-metrics (do not optimize)**
- **SM-C1**: Number of skills shipped is not itself a success signal — shipping all five quickly with weak understanding of the skill/subagent/hook split would satisfy SM-4 while failing SM-1 through SM-3, which matter more per the brief's stated priority.

## 8. Cross-Cutting NFRs

- **Never lose uncommitted work.** No skill, under any input or error path, may cause data loss of a user's uncommitted changes. This is the single hardest constraint in the product and should be treated as a release blocker for any skill that risks it.
- **Never force push.** Enforced structurally via the FR-6 hook, not just through skill/subagent prompting — the hook must hold even if a future skill or subagent revision tries to force push by mistake.
- **Uses existing repo setup only.** Git-Agent relies entirely on the installing repo's own Claude Code configuration and `gh` CLI authentication; it introduces no separate account, credential store, or external service.
- **Verifiable by inspection.** Each skill's correctness must be checkable by inspecting the resulting repository state (branch name, diff contents, commit history, PR metadata) against the test repository — not just by the agent's own claim that it succeeded.

## 9. Open Questions

1. **Where does the conversation live vs. where the git work happens?** A subagent cannot use `AskUserQuestion` — it runs to completion and returns a result. The brief's working assumption is that each skill holds the conversation in the main session and delegates read/plan/execute work to the subagent, but this PRD leaves the mechanism open for architecture to validate or revise while implementing the first skill (create branch), since FR-1, FR-3, FR-4, and FR-9 all depend on some form of mid-flow user interaction.
2. ~~**How is a branch's parent recorded, for FR-8?**~~ **Resolved by architecture:** it isn't. Branch-parent tracking was scrapped entirely; FR-8 always defaults to the config's default PR target branch, with the user able to override. See the architecture spine, AD-7.
3. **How is a subagent's git-planning quality verified**, beyond the repo-state checks in FR-1 through FR-9 — e.g., is a good commit split (FR-3) judged by the author reading it, or some automated rubric? Left open for implementation time.
4. ~~**Re-install / re-configure behavior (FR-10)**~~ **Resolved:** confirmed as this PRD's original assumption — re-running `npx` setup against an already-configured repo shows current values and asks for confirmation before overwriting. Additionally, a sixth **configure** skill (§4.7, FR-12) was added so re-configuration doesn't require re-running the installer at all.

## 10. Assumptions Index

- §4.6, FR-10 — Re-running the installer against an already-configured repo asks for confirmation before overwriting, rather than silently overwriting or silently refusing. Not specified in the brief; confirmed during architecture (formerly Open Question 4).
