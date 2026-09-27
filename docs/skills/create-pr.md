# create-pr

## What it's for

Opening a pull request with a title and body that already follow house convention and target the right base branch, without re-deriving that convention by hand every time.

## What it does

- Generates a PR title following the same `<type>/<task-or-issue>-<description>` convention as the branch name, and a body with at minimum a summary section and a test plan section (split into multiple test-plan items when the change touches more than one concern).
- Proposes the repo's configured default target branch, and lets the user override it before the PR is actually created — for any branch, regardless of how it was created.

## Rules

- **There is no branch-parent tracking, for any branch.** The target always defaults to the config file's `defaultPrTarget`, shown to the user for confirmation or override before `create-pr` runs. A parent-tracking mechanism (git config, a state file, some derivation heuristic) was considered during planning and explicitly dropped — its failure modes (staleness after a rename or delete, orphaned entries) outweighed the payoff.
- **Two-call shape**: `draft-pr` produces a draft, the user edits it, then `create-pr` actually opens it. A single call never spans a user decision.

## Out of scope

- No GitHub Issues integration in v1 — task/issue numbers are always typed by the user.
- Doesn't attempt to infer or store a branch's parent, ever — abolished by design, not just deferred.

## Done when

Opening a PR yields a title and body matching house convention, targeting the repo's configured default branch, changeable by the user before the PR is actually created.
