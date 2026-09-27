# commit

## What it's for

A working tree with two unrelated changes tangled together, and no time to hand-build a clean, split commit plan. This skill turns a messy working tree into a reviewed, topic-split commit history, and forces an explicit decision on anything that looks like it shouldn't be committed at all.

## What it does

- Proposes a multi-commit plan that splits unrelated changes into separate commits — including splitting *within* a single file by line range, when that file holds two unrelated topics. The user sees and approves the plan before anything is actually committed; nothing is committed on an unapproved plan.
- Flags every file that looks local-only (`.env`-style secrets, credentials, `.local` files) and asks about each one individually, rather than deciding automatically.
- Matches the target repo's own commit message template when one is configured; falls back to a documented default format when it isn't.

## Rules

- **Local-only detection belongs entirely to the subagent's planning step**, using a fixed, extensible filename-pattern heuristic (`.env`, `.env.*`, `*.pem`, `*.key`, `credentials*`, `secrets*`, `*.local`), applied to untracked and modified files. The skill itself never scans the working tree.
- **The actual commit uses the exact hunks from the approved plan** — never a fresh re-diff. What the user approved is exactly what gets committed, even if the working tree changed in the meantime.
- **Two-call shape**: plan first, relay the user's raw decisions, then execute. A single call never spans a user decision.

## Out of scope

- Doesn't auto-exclude or auto-`.gitignore` local-only files — v1 only asks. That's intentional, not a placeholder for later.
- Doesn't write or edit code content, ever.

## Done when

Against a working tree with mixed unrelated changes and at least one local-only-looking file, the resulting commit history is split correctly, and the local-only file's inclusion or exclusion matches exactly what the user decided.

## Open question

How the quality of a proposed commit split gets verified (human read-through vs. some automated rubric) isn't settled yet — left for implementation time.
