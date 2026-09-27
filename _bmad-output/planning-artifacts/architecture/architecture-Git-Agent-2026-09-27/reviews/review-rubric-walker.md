---
title: Rubric-Walker Review — Git-Agent Architecture Spine
reviewed_document: ../ARCHITECTURE-SPINE.md
reviewed_against: [prd.md, .memlog.md]
date: 2026-09-27
---

# Rubric-Walker Review — Git-Agent ARCHITECTURE-SPINE.md

## Verdict

**Conditional pass** — the spine is well-structured and internally mostly coherent (clear ADs, a complete Capability→Architecture Map against all 11 FRs, an appropriately minimal Deferred section for a solo project), but it has one real internal contradiction, one enforceability hole in its most safety-critical rule, two silently-missing behavioral invariants that FR testability depends on, and a drifted relationship with its own driving PRD that the memlog itself already flagged and never resolved. None of these require a rewrite; all are fixable with small additions.

---

## Checklist Walk

### 1. Fixes the real divergence points for the level below (6 skills / subagent) — misses two

Covered well: call-shape per flow (AD-5), subagent-as-real-code vs declarative subagent (AD-2), hook scope (AD-3), single-binary routing (AD-4), branch-parent elimination (AD-6), config ownership (AD-7). These are the right things to fix at this altitude, and each maps to a specific implementation seam a future/independent build could get wrong.

**Missing divergence points (Finding F1, F2 below):**
- FR-4's "local-only-looking file" heuristic (the PRD's own example is `.env`-style names) is never named as a concrete pattern anywhere in the spine — not decided, not deferred, not an open question. It simply doesn't appear. Yet FR-4's testable Consequence ("the skill surfaces it... before committing") requires a stable, reproducible definition of what counts. This is exactly the kind of thing that belongs in Consistency Conventions or its own AD: it's a shared vocabulary item multiple actions (`plan-commit`, possibly `execute-commit`) must agree on, not an incidental implementation detail.
- FR-5's commit-template-detection mechanism (how `plan-commit` decides a repo "defines its own commit message template" — `git config commit.template`? a `.gitmessage` file? something else?) is likewise entirely absent from the spine, including Deferred.

### 2. Every AD's Rule is enforceable and actually prevents its stated divergence — one is not

AD-1, AD-2, AD-4, AD-6, AD-7 are enforceable by code review and clearly prevent their stated divergence.

**AD-3 has a gap (Finding F3, Major):** the Rule specifies what the `PreToolUse` hook matches (`Bash` commands containing `git push` plus a force flag) and where it's registered (`options.hooks` in the subagent's own `query()`/`ClaudeSDKClient` call). But nothing in AD-3, AD-2, or anywhere else *requires* that every subagent action actually execute its git commands through that `query()`'s own agentic tool-use loop rather than direct `child_process`/`execa` calls in plain TypeScript. `push` in particular is the one action a future implementation is most tempted to write as a simple deterministic `execSync('git push ...')` — no LLM reasoning is needed to push. If it's written that way, there is no tool-call for `PreToolUse` to intercept, and the hook silently never fires. The Rule constrains the hook's matching logic but not the one precondition (execution always via the SDK's own tool path) that makes the hook meaningful at all. Given this hook is the entire mechanism behind the PRD's single hardest NFR ("Never force push... must hold even if a future skill or subagent revision tries to force push by mistake"), this is worth closing with one added sentence to AD-3 or AD-2 (e.g., "every action executes git/gh commands exclusively as Bash-tool calls inside its own `query()` loop; no action shells out via `child_process`/`execa` directly").

### 3. Nothing under Deferred could let two independently-built units diverge incompatibly

The four Deferred items (plan-quality verification, commit-plan schema detail beyond the envelope, test-fixture setup, no CI/hosting) are all genuinely implementation-time or non-interop concerns, and — importantly for a solo project — the "two independently-built units" framing barely applies since one author builds both skill and subagent. No finding here beyond noting that F1/F2 above (local-only heuristic, template detection) *should* have been named in Deferred at minimum, even if deferred rather than decided; their total absence (not even acknowledged as an open question) is the actual defect, not their deferral.

### 4. Named tech is verified-current

**Finding F5 (Minor):** `@anthropic-ai/claude-agent-sdk ^0.3.282 (confirmed current on npm, 2026-09-27)` is asserted with a confidence marker ("confirmed current") but the spine gives no trace of how that was checked (no cited registry query, no version-history note). For a claim made by a model whose knowledge cutoff predates the stated date, "confirmed" should mean "verified via an actual npm registry lookup performed during this session," not "stated with confidence." As written it reads as asserted, not demonstrably verified. `TypeScript / Node.js: current LTS` is appropriately left unpinned (a moving reference is fine here since it's not a compatibility-sensitive choice for this project's scope), so no finding there.

### 5. Every structural dimension this altitude owns is decided, deferred, or an explicit open question

Deployment/infra/operations: explicitly and correctly decided as "none" (Deferred: "CI, hosting, or any server-side component — none exists; Git-Agent is entirely local"). This is a clean, explicit decision, not silence — no finding.

The two real silent gaps are F1 and F2 above (local-only-file heuristic, commit-template detection) — both are structural dimensions this altitude should own (they're shared contracts between skill and subagent, testable per the PRD's own Consequences) and both are silent, not merely deferred.

### 6. Capability → Architecture Map completeness against the PRD

The table itself is mechanically complete — all FR-1 through FR-11 appear, each with a governing AD. No FR is orphaned.

**However (Finding F4, High):** the PRD this map claims to be complete against is stale relative to the spine's own decisions, and the memlog already flagged both drifts as unresolved:
- AD-6 abolishes branch-parent tracking entirely, defaulting create-PR's target to config with user override. But PRD FR-8's Consequences ("For a branch created by create-branch... create-PR proposes that parent as the target *without asking*"), its Notes line, and Open Question 2 still describe the now-abandoned parent-detection mechanism as if it were still live. The memlog (line 10) explicitly flagged this needing a PRD update "before/alongside spine finalization" — that update was never made.
- The memlog (lines 12–13) adds a 6th "configure" skill to v1 scope, which directly reverses the PRD's own explicit Non-Goal/Out-of-Scope line ("Any second subagent or skill beyond the five named — additions here are explicitly a v2+ conversation") and contradicts the PRD Vision's "five Claude Code skills" and MVP Scope's "five skills" language. The memlog (line 13) flagged this too, listing exactly which PRD sections need updating — again, never done.

The spine's own frontmatter (`scope: '...6 Claude Code skills...'`) is consistent with the memlog's decisions but *inconsistent with the PRD it lists as its only source*. The Capability Map is complete against the FR *numbers*, but "complete against the PRD" should also mean not contradicting the PRD's prose — and here it does, on two points the process itself already caught and then dropped.

---

## Findings Summary (by severity)

| # | Severity | Finding |
| --- | --- | --- |
| F3 | Major | AD-3's no-force-push hook Rule never requires that git execution route through the subagent's own SDK tool-use loop; a deterministic direct-shell implementation of any action (esp. `push`) would silently bypass the hook entirely, defeating the PRD's hardest NFR. |
| F0 | Major | Internal inconsistency: the Consistency Conventions table labels "local-only file found" as an `ok:false`-shaped expected stop alongside merge conflicts, but AD-1/AD-5's actual design has `plan-commit` return local-only candidates as part of a *successful* (`ok:true`) plan for the skill to relay via `AskUserQuestion` — these are two incompatible models of the same requirement and the spine never says which governs. |
| F4 | High | The spine's source PRD is stale relative to decisions the spine itself encodes (AD-6 vs. FR-8's parent-detection text; the memlog's added 6th "configure" skill vs. the PRD's explicit "five skills only, no 6th until v2" Non-Goal) — both drifts were flagged in the memlog and never reconciled in the PRD. |
| F1 | Moderate | FR-4's "local-only-looking file" heuristic (concrete filename/pattern list) is never named as an invariant anywhere in the spine, despite FR-4's testable Consequences depending on a stable, reproducible definition. |
| F2 | Moderate | FR-5's commit-template-detection mechanism is entirely unaddressed — not decided, not deferred, not flagged as an open question. |
| F5 | Minor | The SDK version's "confirmed current on npm" claim carries no verification trail; reads as asserted rather than checked. |

## What's genuinely solid

- AD-5's call-count table matches every FR's flow shape correctly, including the conditional 1-or-2-call update-branch case.
- AD-1's "raw decisions only, never a skill-mutated plan object" rule is a sharp, enforceable answer to the PRD's Open Question 1 and directly protects the skill/subagent split the PRD's glossary and SM-1 depend on.
- Deferred section correctly resists inventing enterprise concerns (no CI/hosting is an explicit, correct decision for this scope, not an omission).
- Dependency-direction diagram is unambiguous and matches the prose rules exactly (no skill runs git directly; subagent never touches config).
