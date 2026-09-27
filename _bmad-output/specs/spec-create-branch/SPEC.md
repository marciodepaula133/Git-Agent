---
id: SPEC-create-branch
companions:
  - ../../planning-artifacts/architecture/architecture-Git-Agent-2026-09-27/ARCHITECTURE-SPINE.md
  - ../../../docs/initial-guidelines.md
sources:
  - ../../planning-artifacts/prds/prd-Git-Agent-2026-09-27/prd.md
  - ../../planning-artifacts/briefs/brief-Git-Agent-2026-09-27/brief.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Git-Agent — create-branch skill

## Why

The author, mid-feature with uncommitted changes and a new task number in hand, needs to start a branch without losing that work or hand-deriving a branch name under time pressure (UJ-1). This is a pain to solve: doing it by hand every time, in every repo, is repetitive and has already cost lost changes and messy history. create-branch exists to make branch creation carry uncommitted work forward automatically and name the branch to a fixed convention every time.

## Capabilities

- **CAP-1**
  - **intent:** User can create a new branch while their current uncommitted, unstaged modifications are carried over automatically.
  - **success:** Against the test repository, starting with uncommitted modifications, running create-branch results in those same modifications present and unstaged on the new branch, with no modification staged automatically as a side effect.

- **CAP-2**
  - **intent:** User can name the branch by a fixed convention by supplying only a task/issue number and a type.
  - **success:** Given a type and task number, the resulting branch name matches `<type>/<task-or-issue>-<description>` exactly; if the user supplies a type not in the repo's configured list, the skill asks for clarification rather than silently accepting it.

## Constraints

- Never lose uncommitted work: no modification may be staged, dropped, or overwritten by branch creation — the single hardest constraint in the product.
- Branch type must be validated against the repo's configured task/branch types (config file, see the configure skill's spec); an unconfigured type blocks with a clarifying question, not a silent create.
- The skill↔subagent call is one-shot: `create-branch` is a single call with no plan to approve, since type/task/description are already resolved in the skill's own conversation (architecture spine, AD-6).

## Non-goals

- Does not touch code content, at any point.
- Does not record or track the new branch's parent for any later use — branch-parent tracking was considered and abolished entirely (architecture spine, AD-7); create-PR's target comes from config instead.

## Success signal

Running create-branch against the disposable test repository, starting from a state with uncommitted modifications and a supplied task number/type, produces a correctly named branch with all modifications intact and unstaged.
