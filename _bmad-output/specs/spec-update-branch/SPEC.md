---
id: SPEC-update-branch
companions:
  - ../../planning-artifacts/architecture/architecture-Git-Agent-2026-09-27/ARCHITECTURE-SPINE.md
  - ../../../docs/initial-guidelines.md
sources:
  - ../../planning-artifacts/prds/prd-Git-Agent-2026-09-27/prd.md
  - ../../planning-artifacts/briefs/brief-Git-Agent-2026-09-27/brief.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Git-Agent — update-branch skill

## Why

The author needs a feature branch caught up with another branch (typically `main`), and wants to trust that the operation will never rebase and will stop cleanly rather than doing something destructive if it hits a conflict (UJ-4). This is a pain to solve: resolving "bring my branch up to date" by hand risks reaching for a rebase, or losing track of a merge mid-conflict. update-branch exists to make catching up a branch a merge-only operation that fails safely.

## Capabilities

- **CAP-1**
  - **intent:** User can merge a chosen branch (local or from `origin`) into the current branch.
  - **success:** In a test-repo scenario with a clean, fast-forward-able merge, the skill completes the merge without prompting for conflict resolution; if the merge source is remote-qualified, the remote is fetched immediately before merging.

- **CAP-2**
  - **intent:** On merge conflicts, the operation stops, reports which files conflict, and hands control back to the user rather than attempting any workaround; once the user resolves conflicts, it can finish the merge.
  - **success:** In a test-repo scenario engineered to conflict, the skill stops before completing the merge, clearly reports which files conflict, and does not attempt a rebase as a workaround; once the user resolves conflicts and signals completion, the skill finishes the merge (e.g. commits the resolution) rather than requiring the user to do so manually outside the agent.

## Constraints

- Never rebase, in any flow — the skill merges only.
- One-or-two-call shape: `merge` (clean = done; conflict = report and hand off) → `finish-merge`, only if conflicted (architecture spine, AD-6).
- If the merge source (`from`) is remote-qualified (e.g. `origin/main`), the remote is fetched immediately before merging; if `from` is a local branch, no fetch occurs (AD-10).

## Non-goals

- No rebase support, in any flow — deferred indefinitely, not just for v1.

## Success signal

update-branch against the test repository completes a clean merge without intervention, and against an engineered conflict, stops cleanly, reports the conflicting files, and lets the user finish the merge once they've resolved the conflict.
