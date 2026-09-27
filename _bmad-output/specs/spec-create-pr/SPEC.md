---
id: SPEC-create-pr
companions:
  - ../../planning-artifacts/architecture/architecture-Git-Agent-2026-09-27/ARCHITECTURE-SPINE.md
  - ../../../docs/initial-guidelines.md
sources:
  - ../../planning-artifacts/prds/prd-Git-Agent-2026-09-27/prd.md
  - ../../planning-artifacts/briefs/brief-Git-Agent-2026-09-27/brief.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Git-Agent — create-pr skill

## Why

The author, ready to open a pull request, wants a title and body that already follow the house convention and target the right base branch, without re-deriving that convention by hand each time (UJ-3). This is a pain to solve: generic PR creation doesn't enforce a fixed naming pattern or a summary-plus-test-plan structure. create-pr exists to produce that convention-following PR automatically while still letting the author confirm or change the target branch.

## Capabilities

- **CAP-1**
  - **intent:** PR title and body follow the branch naming convention and a fixed structure — a summary and a test plan, split into several test-plan items when the change touches more than one concern.
  - **success:** For a branch named per the fixed `<type>/<task-or-issue>-<description>` convention, the generated PR title reflects that same type/task/description; the generated PR body contains at minimum a summary section and a test plan section.

- **CAP-2**
  - **intent:** User is proposed the repo's configured default target branch and can override it before the PR is created.
  - **success:** For any branch, regardless of how it was created, create-pr proposes the repo's configured default target branch as the target; the user can override the proposed target before create-pr runs, and doing so does not require any prior tracking of that branch's history.

## Constraints

- No branch-parent tracking mechanism exists or is attempted, for any branch — the target always defaults to the config file's `defaultPrTarget`, shown to the user for confirmation or override before `create-pr` runs (architecture spine, AD-7).
- Two-call shape: `draft-pr` → the user edits the draft → `create-pr` (AD-1, AD-6). A subagent call never spans a user decision.

## Non-goals

- No GitHub Issues integration in v1 — task/issue numbers are always typed by the user.
- Does not attempt to infer or store a branch's parent, ever — this was considered during planning and explicitly abolished (AD-7), not merely deferred.

## Success signal

Opening a PR through create-pr against the test repository yields a title and body matching the house convention and a target branch equal to the repo's configured default, changeable by the user before the PR is actually created.
