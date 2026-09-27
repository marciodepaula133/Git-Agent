---
title: Adversarial Review — Git-Agent Architecture Spine
target: ARCHITECTURE-SPINE.md (Git-Agent, 2026-09-27)
method: construct concrete "two units one level down" pairs that each satisfy every AD to the letter yet build incompatibly
---

# Adversarial Review — Git-Agent Architecture Spine

## Method

For each pair below: two independent, fully spec-compliant implementations (a skill vs. its subagent action, or two people implementing the same AD) are constructed. Each obeys every AD in the spine as literally written. The pair still produces incompatible JSON, contradictory assumptions, or silently wrong behavior. Every pair is therefore a gap in the spine, not a bug in either implementation.

---

## Finding 1 — "Raw decisions" has no fixed shape (AD-1 × AD-5, commit flow)

**Severity: Critical**

AD-1's Rule says the second `execute-commit` call receives "the *original result* plus the *user's raw decisions*" as plain input, "never a plan object the skill parsed or mutated itself." AD-5 confirms the 2-call shape for commit. But the spine explicitly defers "Commit-plan diagram/schema detail beyond the envelope shape" to the `plan-commit` action's implementation, and nowhere fixes the shape of "raw decisions" either.

- **plan-commit/execute-commit builder** designs `execute-commit`'s input as:
  ```json
  { "planId": "abc123", "originalPlan": {...}, "decisions": { "commitEdits": [{"commitIndex": 0, "files": [...]}], "localOnly": {".env": "exclude"} } }
  ```
  keyed by commit *index* into the original plan array, with local-only decisions as a flat filename→action map.
- **commit skill builder**, working only from FR-3/FR-4 prose and AskUserQuestion's own answer shape, serializes the user's answers as:
  ```json
  { "resultFrom": {...}, "userDecisions": [ {"type": "include-file", "file": ".env", "value": true}, {"type": "split-request", "targetCommit": "feat: X", "files": [...]} ] }
  ```
  keyed by commit *message/title* (a natural key from the AskUserQuestion transcript) with local-only decisions mixed into the same decision list as split/merge edits.

Both obey AD-1's rule ("raw decisions... never a plan the skill parsed/mutated") — arguably *more* faithfully, since the skill-builder's list literally mirrors the user's answers verbatim. But `execute-commit` cannot parse the skill's shape, and the skill cannot address commits by index if the subagent's plan uses IDs. This is not an edge case — it fires on every single commit invocation.

**Close with:** an AD (or an addendum to AD-1) that fixes the literal JSON schema for `plan-commit`'s output (so it has stable per-commit and per-file identifiers) and for the "raw decisions" payload — specifically: (a) commits addressed by a stable `id` field, never index or message; (b) local-only-file decisions structured as their own top-level array distinct from split/merge edits, with a fixed `{file, decision: "include"|"exclude"}` shape; (c) split/merge edits structured as an explicit operation list (`{op: "move-file"|"move-hunk"|"merge-commits", ...}`) rather than a redefinition of file→commit membership, so `execute-commit` doesn't have to diff two whole-plan JSON blobs to infer what changed.

---

## Finding 2 — FR-4 contradicts the spine on who detects local-only files (AD-1 × dependency diagram)

**Severity: Critical**

PRD FR-4 states: *"the **skill** identifies files that look local-only... and asks."* But the spine's Dependency Direction diagram states unconditionally: `Skill -.->|never runs git/gh directly| Repo`, and the Capability→Architecture Map assigns FR-4 to `plan-commit.ts`/`execute-commit.ts` under AD-1 — i.e., the *subagent* inspects the working tree, not the skill.

This is a genuine spine/PRD contradiction that two builders will resolve differently, both "correctly":

- **Subagent-builder** reads the Capability Map and AD-2/AD-7 (skill never touches git) and puts local-only detection entirely inside `plan-commit`, using its own heuristic (e.g. a hardcoded list: `.env`, `.env.*`, `*.pem`, `*.key`, `credentials*` — applied only to *untracked* files, since a previously-committed file re-modified isn't "local-only" by any reasonable reading).
- **Skill-builder** reads FR-4's literal text ("the skill identifies") and, noting AD-7 already gives skills direct file I/O for config, decides the skill can legitimately `Read`/`Glob` the working directory itself (not "running git", just reading files) to build its own local-only candidate list — using a broader heuristic (anything matching common `.gitignore` secret patterns, including tracked files whose diff touches a `.env`-shaped path).

Result: two independent, divergent local-only-file scanners running in the same commit flow, potentially surfacing different files to the user, or the skill's AskUserQuestion prompt listing files the subagent's plan doesn't even mention (since the subagent's plan is the source of truth for what's being committed).

**Close with:** an AD stating unambiguously that local-only detection is entirely a `plan-commit` (subagent) responsibility, is emitted as a `localOnlyCandidates: [...]` field in `plan-commit`'s envelope, and that the skill never independently scans the filesystem for this purpose — only relays what `plan-commit` returned. Also fix the FR-4 wording mismatch (flag back to PRD).

---

## Finding 3 — `merge`'s "from" is unspecified: stale local ref vs. fetch-first (FR-9 × AD-5 × AD-7)

**Severity: High**

AD-5's table lists `merge` as taking a source ("local or from origin", per FR-9) with no input schema, and AD-7's dependency diagram forbids the skill from running git directly — so only the subagent can fetch. Nothing in the spine obligates a fetch before merge, and nothing forbids one.

- **Subagent-builder A** implements `merge --from origin/main` as literally `git merge origin/main` against whatever the local remote-tracking ref already holds — no implicit fetch, on the reasoning that "merge" is a mechanical action and fetching is a separate concern outside its one-shot, stateless contract (AD-1: minimal side effects per call).
- **Subagent-builder B** implements the same input by first running `git fetch origin` then merging, on the reasoning that FR-9's UJ-4 ("needs their feature branch caught up with `main`") is meaningless if the merge silently uses stale data — a user who ran `update-branch` five minutes after a teammate pushed to `main` would see "clean merge, nothing to do" from Builder A's stale ref and an actual up-to-date merge from Builder B.

Both are legal readings of "merge a chosen branch (local or from origin)" — the Rule never says whether "from origin" means "the current state of origin" or "our last-known view of origin." This also silently interacts with FR-9's "never lose uncommitted work" NFR: a stale-ref merge that reports success gives the user false confidence their branch is caught up.

**Close with:** an AD fixing that `merge` with an origin/remote source always fetches that remote (or that specific branch) before merging, and specifying the exact input shape (e.g. `{ source: "origin/main" | "main", currentBranch resolved internally }`) so "from" is a single unambiguous ref string, not an implicit local-vs-remote inference.

---

## Finding 4 — No-force-push hook matcher: rule text is specific but still has escape routes (AD-3)

**Severity: High** (given this is the product's one hard safety guarantee)

AD-3's Rule is unusually precise — it names the exact flags (`--force`, `-f`, `--force-with-lease`) and says the hook matches "`Bash` commands containing `git push` plus a force flag." That precision is good, but it's precise about *what to match*, not *how the match is implemented*, and two spec-compliant regexes diverge:

- **Builder A**: `/git\s+push\b.*(--force(-with-lease)?|(?:^|\s)-f(?:\s|$))/` — anchors on the literal substring `git push` appearing in the command.
- **Builder B**: `/(--force(-with-lease)?\b|(?:^|\s)-f\b)/` combined with a separate check that the command's first token resolves to `git` — functionally similar, but implemented as two independent checks.

Both satisfy AD-3's Rule as literally written ("matching Bash commands containing `git push` plus a force flag") — yet both miss cases that are still "a force-push invocation" in FR-6's stricter Cross-Cutting NFR sense ("never force push... even if a future skill or subagent revision tries to force push by mistake"):

- A git alias invoked as `git pushf` (user/repo-configured alias for `push --force`) — the Bash command text contains neither a separate `--force` token nor the literal substring `git push`, so *neither* builder's matcher fires, yet it is a force push.
- `--force-with-lease=refs/heads/main:<sha>` (flag with `=value` attached) — Builder A's regex requires a following space or end-of-string after `-f`, and depending on exact construction may or may combine short flags like `-uf` (`push -uf origin branch`, `-f` folded into a combined short-option cluster) — a builder who tested only the four literal examples in the Rule (`--force`, `-f`, `--force-with-lease`, plus combined) can pass every documented test case while still missing `-uf`.
- A wrapped invocation: the subagent's own `push.ts` (or a test harness inducing FR-6's "deliberately induced attempt") shells out to a script (`bash deploy.sh`) that itself runs `git push -f` — the top-level Bash command the hook sees is `bash deploy.sh`, containing neither `git push` nor a force flag literally, even though a force push occurs downstream. AD-3 says the hook matches "`Bash` commands containing `git push` plus a force flag" — a wrapped script is a `Bash` command that does *not* textually contain either, so a builder is fully compliant while the guarantee silently doesn't hold.

**Close with:** tighten AD-3 to (a) enumerate the exact regex/token-matching algorithm (not just the flags), explicitly requiring it to catch combined short-flag clusters and `=`-attached values; (b) state whether alias resolution is in scope (if not, explicitly declare aliases and wrapper-script invocations out of scope as a documented limitation, so builders don't each independently discover and differently patch this gap); (c) add a test-plan requirement (tying into FR-6's Consequences) enumerating these exact adversarial forms so "deliberately induced attempt" in FR-6 has a fixed test list both a skill-builder's test repo and the subagent's own unit tests draw from.

---

## Finding 5 — Envelope `reason` codes are illustrative, not canonical (Consistency Conventions table)

**Severity: Medium**

The Consistency Conventions table gives example reason codes ("e.g. `conflict`, `non-fast-forward`, `branch-exists`") but never states these are an exhaustive, fixed enum. Two builders:

- **`merge.ts` builder** emits `{ ok: false, reason: "merge-conflict", files: [...] }` on conflict (a more descriptive choice than the table's illustrative `"conflict"`).
- **`update-branch` skill builder**, reading only the Consistency Conventions table's literal example, writes its conflict-branch handling logic to switch on `reason === "conflict"`.

Both are compliant — the table never commits to `"conflict"` as the actual required string, only offers it as an example ("e.g."). The skill's conflict-handling branch silently never fires; FR-9's "stops, reports the conflict, and hands control back to the user" Consequence fails at the first conflict test, and it will look like a subagent bug when it's a spine ambiguity.

**Close with:** promote the illustrative reason codes to a canonical, closed enum table (one row per action × failure mode), analogous to how AD-5 already tabulates call counts per flow.

---

## Finding 6 — stdin vs. `--input` flag: both legal, but not equivalent under Windows argv limits

**Severity: Medium** (elevated because this project's actual dev environment is Windows)

The Consistency Conventions row for subagent I/O says: "Input via stdin or `--input` flag, JSON" — offering both as equally valid without specifying which action must use which, or a payload-size rule.

- **Skill-builder**, favoring the simpler `execSync`/`spawnSync` call shape, always invokes the subagent with `--input '<json>'` for every action, including `execute-commit` (which, per Finding 1, may carry a full multi-file, multi-hunk plan-plus-decisions payload).
- **Subagent-builder**, doing its own local testing, always pipes JSON via stdin and never exercises the `--input` flag path for large payloads.

On Windows, command-line length is capped well below what a several-file commit-split plan with hunk-level diffs can reach (~8K char practical ceiling via `cmd.exe`/`CreateProcess`, and Node's `spawnSync` on Windows inherits this). A skill-builder who defaults to `--input` for uniformity will intermittently truncate or fail on exactly the commit-split scenario FR-3 is built to showcase, while every unit test the subagent-builder wrote (stdin-based) passes.

**Close with:** either drop `--input` entirely (stdin-only, no ambiguity, no size ceiling) or explicitly restrict `--input` to single-scalar-argument actions (e.g. `create-branch`) and mandate stdin for any action whose payload includes a `plan-commit` result or diff content.

---

## Finding 7 — `execute-commit` re-diffing vs. snapshot: a race the spine doesn't foreclose

**Severity: Medium**

AD-1 requires the flow be split so the skill does all `AskUserQuestion` interaction between `plan-commit` and `execute-commit`. That interaction has no guaranteed duration or isolation — the user is free to edit files while answering questions (nothing in the spine locks the working tree). The spine says `execute-commit` receives "the original plan-commit result plus... raw decisions" but never says whether `execute-commit` (a) applies the original hunks as a stored patch, or (b) re-reads the current working tree and re-derives hunks matching the original file list.

- **Builder A** implements `execute-commit` as literally replaying the original plan's stored hunks (`git apply`-style), ignoring the live working tree beyond sanity-checking it still applies cleanly — deterministic, matches exactly what the user approved.
- **Builder B** implements `execute-commit` as re-invoking the same diff-splitting logic against the *current* working tree, filtered to the approved file/commit assignments — reasoning that re-deriving is simpler to implement (reuses `plan-commit`'s internals) and "more correct" since it reflects the latest file state.

Both are spec-compliant (the spine never says which). But if the user made any edit during the AskUserQuestion pause, Builder B's committed diff differs from what was shown and approved — a direct, silent violation of FR-3's Consequence ("no commit happens on a plan the user hasn't confirmed") that neither builder would catch in isolated testing, since each only tests against a static, unmodified-between-calls test repo.

**Close with:** an AD stating `execute-commit` must apply the exact hunks captured in the original `plan-commit` result (snapshot semantics), and must fail with a stable `reason` (e.g. `"working-tree-changed"`) if the current working tree no longer matches what was planned, rather than silently re-deriving.

---

## Finding 8 — `defaultPrTarget` value format: bare branch vs. remote-qualified (AD-6 × AD-7)

**Severity: Low-Medium**

AD-6 says the target is "always the config file's `defaultPrTarget`." AD-7 says skills read/write the config JSON directly with no schema fixed by the spine beyond field names ("taskTypes, defaultPrTarget").

- **`configure` skill builder** stores what the user types verbatim, e.g. the user types `main`, or types `origin/main` out of habit — nothing in FR-10/FR-11 or AD-6 validates or normalizes the input.
- **`create-pr` skill/subagent builder** assumes the stored value is a bare branch name suitable for direct use as `gh pr create --base <value>`, which errors or behaves unexpectedly if handed `origin/main`.

Since both the writer (`configure`) and reader (`create-pr`) are built independently against the same untyped config schema, whether the value is remote-qualified is a silent convention neither AD pins down.

**Close with:** AD-7 (or FR-10/11) should specify `defaultPrTarget`'s exact value format (bare local branch name, validated against `git branch --list` or similar at config-write time) and that `configure` normalizes/strips any `origin/`-style prefix before writing.

---

## Summary Table

| # | Pair | Severity | Root cause |
|---|------|----------|------------|
| 1 | plan-commit/execute-commit JSON shape vs. commit-skill's decision serialization | Critical | "Raw decisions" shape explicitly deferred, never fixed |
| 2 | FR-4 detection: skill-side scan vs. subagent-side scan | Critical | PRD text ("the skill identifies") contradicts spine's dependency diagram |
| 3 | `merge`'s stale-ref vs. fetch-first | High | "from origin" input/behavior unspecified |
| 4 | No-force-push regex: alias/wrapper/combined-flag escapes | High | Rule specifies flags, not the matching algorithm or its scope boundary |
| 5 | Envelope `reason` codes illustrative not canonical | Medium | "e.g." example codes read as spec by one builder |
| 6 | stdin vs `--input` flag, Windows argv limits | Medium | Both channels declared legal with no size/action binding |
| 7 | execute-commit: snapshot replay vs. re-diff | Medium | No guarantee working tree is unchanged across the AskUserQuestion pause |
| 8 | `defaultPrTarget` bare vs. remote-qualified | Low-Medium | Config value format left untyped |
