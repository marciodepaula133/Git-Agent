---
id: SPEC-commit
companions:
  - ../../planning-artifacts/architecture/architecture-Git-Agent-2026-09-27/ARCHITECTURE-SPINE.md
  - ../../../docs/initial-guidelines.md
sources:
  - ../../planning-artifacts/prds/prd-Git-Agent-2026-09-27/prd.md
  - ../../planning-artifacts/briefs/brief-Git-Agent-2026-09-27/brief.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Git-Agent — commit skill

## Why

The author, with a messy working tree touching two unrelated things, wants a clean, split commit plan to approve rather than building it by hand under time pressure (UJ-2). This is a pain to solve: a single commit per session mixes unrelated changes, and files that look local-only (like `.env`) have landed in commits before by accident. The commit skill exists to turn a working tree into a reviewed, topic-split commit history and to force a decision on anything that looks like it shouldn't be committed.

## Capabilities

- **CAP-1**
  - **intent:** User can get a proposed multi-commit plan that splits unrelated changes into separate commits, including splitting within a single file by line range when it holds two unrelated topics.
  - **success:** Against a test-repo scenario with two unrelated changes in one file, the proposed plan puts those changes into two different commits with correct line attribution; the user sees and approves the plan before any commit is made — no commit happens on a plan the user hasn't confirmed.

- **CAP-2**
  - **intent:** User is asked about each file that looks local-only (e.g. `.env`-style) before it's committed, rather than the agent deciding automatically.
  - **success:** Against a test-repo scenario containing an untracked `.env`-like file, the skill surfaces it and blocks on a user decision before committing, rather than including or excluding it silently.

- **CAP-3**
  - **intent:** Commit messages follow the target repository's own commit template when one is configured, otherwise a documented default format.
  - **success:** In a test repo with a configured commit template, generated commit messages match that template's structure; in a test repo without one, a documented default format is used.

## Constraints

- Local-only detection is owned solely by the subagent's `plan-commit` action via a fixed, extensible filename-pattern heuristic (`.env`, `.env.*`, `*.pem`, `*.key`, `credentials*`, `secrets*`, `*.local`), applied to untracked and modified files — the skill never scans the working tree itself (architecture spine, AD-9).
- `execute-commit` commits using the verbatim hunks from the original plan (snapshot-replay), never a fresh re-diff — what the user approved is exactly what gets committed, even if the working tree changed in the interim (AD-9).
- Two-call shape: `plan-commit` → the skill relays the user's raw, unedited decisions → `execute-commit` (AD-1, AD-6). A subagent call never spans a user decision.

## Non-goals

- Does not auto-exclude or auto-`.gitignore` local-only files — v1 only asks; this is intentional, not a placeholder.
- Does not write or edit code content, at any point.

## Success signal

In a test-repo scenario with mixed unrelated changes and at least one local-only-looking file, commit produces an approved, correctly split commit history whose local-only file's inclusion or exclusion matches exactly what the user decided.

## Open Questions

- How is a subagent's git-planning quality verified — e.g. is a good commit split judged by the author reading it, or by some automated rubric? Left open for implementation time (PRD Open Question 3).
