# update-branch

## What it's for

Catching a feature branch up with another branch (typically `main`) in a way that's trustworthy: never reaches for a rebase, and stops cleanly instead of doing anything destructive when it hits a conflict.

## What it does

- Merges a chosen branch (local, or from `origin`) into the current branch. For a clean, fast-forward-able merge, it just completes — no prompting.
- If the merge source is remote-qualified (e.g. `origin/main`), it fetches that remote immediately before merging. If the source is a local branch, no fetch happens — there's nothing remote to reconcile against.
- On a conflict, it stops, clearly reports which files conflict, and hands control back to the user rather than attempting any workaround. Once the user resolves the conflict and signals it's done, the skill finishes the merge (e.g. commits the resolution) — the user doesn't have to finish it manually outside the agent.

## Rules

- Never rebases, in any flow. This skill merges, full stop.
- One-or-two-call shape: `merge` (clean = done; conflict = report and hand off) → `finish-merge`, only if there was a conflict.

## Out of scope

- No rebase support, in any flow — deferred indefinitely, not just for v1.

## Done when

A clean scenario completes without intervention. An engineered conflict stops cleanly, reports the conflicting files, and lets the user finish the merge once they've resolved it by hand.
