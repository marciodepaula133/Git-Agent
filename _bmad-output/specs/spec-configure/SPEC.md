---
id: SPEC-configure
companions:
  - ../../planning-artifacts/architecture/architecture-Git-Agent-2026-09-27/ARCHITECTURE-SPINE.md
  - ../../../docs/initial-guidelines.md
sources:
  - ../../planning-artifacts/prds/prd-Git-Agent-2026-09-27/prd.md
  - ../../planning-artifacts/briefs/brief-Git-Agent-2026-09-27/brief.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Git-Agent — configure skill and first-run setup

## Why

Git-Agent's other five skills all depend on a small per-repo configuration surface — task/branch types and a default PR target branch — that has to be captured somewhere and stay editable without re-installing the package. This is an opportunity to capture: a first-run setup question flow plus an on-demand configure skill let the author (and anyone else installing Git-Agent) set and revise that surface deliberately, instead of it being hardcoded or buried in re-running an installer.

## Capabilities

- **CAP-1**
  - **intent:** Installing the package via `npx` runs a first-time setup that asks for default task/branch types and a default PR target branch, then writes them to a per-repo config file.
  - **success:** Running the installer against a fresh test repo produces a config file containing the answered task/branch types and default PR target branch; re-running the installer against an already-configured repo asks for confirmation before overwriting existing config, rather than silently overwriting or silently refusing.

- **CAP-2**
  - **intent:** Every skill that references task/branch types or a default PR target reads them from the config file rather than hardcoding values.
  - **success:** Changing the config file's task types changes what create-branch accepts, without any code change.

- **CAP-3**
  - **intent:** User can redo the config surface at any time via a configure skill, without re-running the `npx` installer.
  - **success:** Running the configure skill against a configured test repo shows the existing task types and default PR target, and updates the config file to match whatever the user confirms or changes.

## Constraints

- The config file is read and written directly by skills; the subagent has no config-reading or config-writing code path (architecture spine, AD-8).
- `configure` makes no subagent call — it is direct file I/O in the skill itself (AD-6).

## Non-goals

- No broad, general-purpose configurability in v1 — the config surface is deliberately limited to task/branch types and default PR target branch.
- No centrally managed, team-wide configuration — v1's config surface is per-repo and self-serve only.

## Success signal

A fresh repo installed via `npx` ends up with a config file matching the answered setup questions; running the configure skill later shows those same current values and updates the config file to match whatever the user confirms or changes, without ever re-running the installer.

## Assumptions

- Re-running the installer against an already-configured repo asks for confirmation before overwriting, rather than silently overwriting or silently refusing. Not specified in the original brief; confirmed during architecture (PRD Assumptions Index, formerly Open Question 4).
