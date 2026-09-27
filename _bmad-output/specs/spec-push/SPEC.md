---
id: SPEC-push
companions:
  - ../../planning-artifacts/architecture/architecture-Git-Agent-2026-09-27/ARCHITECTURE-SPINE.md
  - ../../../docs/initial-guidelines.md
sources:
  - ../../planning-artifacts/prds/prd-Git-Agent-2026-09-27/prd.md
  - ../../planning-artifacts/briefs/brief-Git-Agent-2026-09-27/brief.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Git-Agent — push skill

## Why

Skipping git discipline by hand under time pressure has cost the author before — lost changes, an accidental force push. This is a mandate the product sets for itself: "never force push" must hold as a hard guarantee, not a prompt suggestion that can be argued past or forgotten. The push skill exists to make force-pushing structurally impossible rather than merely discouraged.

## Capabilities

- **CAP-1**
  - **intent:** User can push committed work to the remote through the ordinary path.
  - **success:** Ordinary (non-force) pushes succeed unaffected by the no-force-push hook.

- **CAP-2**
  - **intent:** Force-pushing is structurally impossible regardless of what invokes it.
  - **success:** A direct attempt — including one deliberately induced during testing — to run `git push --force` or `--force-with-lease` through the agent's tool path is blocked before execution, covering long form (`--force`), short form (`-f`), value-attached (`--force-with-lease=<ref>`), and combined short flags (`-uf`).

## Constraints

- Enforced by a `PreToolUse` hook registered inside the subagent's own SDK `query()`/`ClaudeSDKClient` call — deny-by-default for anything push-shaped, parsing the command's argument tokens rather than matching a single regex over the raw string (architecture spine, AD-3).
- The hook lives only inside the subagent's own SDK session: never written to `settings.json` or `settings.local.json`, and never affecting the user's manual terminal use or any other Claude Code session (AD-2, AD-3).
- Every git-mutating action must run its git/`gh` commands through the SDK's own agentic tool-use loop, never a bypassing direct process call — otherwise the hook never fires (AD-4).

## Non-goals

- No exception path or override flag for force-push, ever, under any circumstance.
- Does not manage its own GitHub account or credentials — uses whichever account the repo's `gh` CLI is already authenticated as.

## Success signal

Across ordinary use, Git-Agent never force pushes and never loses uncommitted local changes; a deliberately induced force-push attempt during testing is blocked by the hook, while a normal push through the same path succeeds unaffected.
