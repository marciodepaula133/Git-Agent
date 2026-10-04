---
title: 'configure skill and first-run setup'
type: 'feature'
ticket: ''
created: '2026-10-04'
status: 'built'
route: 'oneshot'
route_source: 'auto'
review: 'quick'
review_source: 'auto'
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/docs/architecture.md'
  - '{project-root}/docs/skills/configure.md'
  - '{project-root}/docs/initial-guidelines.md'
baseline_revision: '42a0d8ad4c2bad0821f3b0e90aca28354162fe76'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Git-Agent's other skills depend on a per-repo config surface (task/branch types, default PR target) that doesn't exist yet — there's no first-run setup and no `configure` skill, so nothing can read a real config file.

**Approach:** Build two plain markdown skills, no subagent and no new TypeScript code: `git-agent-setup` (first-run — invoked once via `/git-agent-setup` after `npx skills add`, superseding the originally-sketched `install/setup.ts` Node CLI, per human decision) and `git-agent-configure` (on-demand reconfiguration). Both ask the same two questions (task/branch types, default PR target branch), read/write `.git-agent/config.json` directly with the agent's own file tools — mirroring how `git-agent-create-branch` already reads that file — and never call the subagent. If a config file already exists, both show the current values and ask for confirmation before overwriting; neither silently overwrites nor silently refuses. Update `docs/architecture.md`, `README.md`, and the architecture spine's structural note to drop the `install/setup.ts` CLI and reflect `git-agent-setup` as a skill instead, per `CLAUDE.md`'s "keep docs in sync" rule.

</frozen-after-approval>

## Implementation Notes

Decided against a standalone `install/setup.ts` Node CLI (as architecture.md originally sketched) in favor of a seventh skill, `git-agent-setup`, invoked the same way every other Git-Agent skill is (`/git-agent-setup`). This was an explicit human decision made during planning: it avoids inventing an `npx`/`bin` invocation path the rest of the project's distribution story (bundled-into-skill-folder, no npm publish) doesn't otherwise need, and keeps the whole product's UX consistent — every capability is a slash-command skill, none require a raw terminal command. `git-agent-setup` and `git-agent-configure` end up behaving almost identically (both show-current-then-confirm when a config already exists, per the confirmed PRD assumption that re-running setup never silently overwrites or silently refuses); they stay separate skills rather than merging into one, per the human's choice, so a brand-new install has an obviously-named entry point.

## Plan Change Log

## Review Triage Log

Quick lens, 1 pass, 2 findings (both `medium`, verified real):
- Architecture spine (`_bmad-output/planning-artifacts/.../ARCHITECTURE-SPINE.md`) still showed `install/setup.ts` and a single `configure/` skill after the plan's own Intent promised to update it. **patch** — updated the structural-seed tree and capability map to `skills/setup/` + `skills/configure/`, dropped the `install/` entry.
- `CLAUDE.md`'s `bmad:context` block still lists only the original six skills, omitting `setup`. **defer** — CLAUDE.md edits are always deferred per standing review-triage precedent (see `deferred-work.md`'s existing `npm test` entry); the block is also explicitly refresh-managed, not meant for hand-edits. Logged to `deferred-work.md`.

## Verification

**Commands:**
- `npm run lint` -- expected: no lint errors (new/changed Markdown and docs don't affect this, but confirms nothing else broke)
- `npm run typecheck` -- expected: no type errors (no TypeScript changes expected, confirms nothing broke)

**Manual checks (if no CLI):**
- Read both new `SKILL.md` files end to end and confirm each: never mentions calling the subagent, matches `docs/skills/configure.md`'s done-when criteria, and the confirm-before-overwrite behavior is explicit for both the "config already exists" case.
- Diff `docs/architecture.md` and `README.md` against the old `install/setup.ts`-based wording to confirm no stale references remain.
