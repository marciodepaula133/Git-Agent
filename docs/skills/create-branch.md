# create-branch

## What it's for

Starting a new branch, mid-feature, with uncommitted changes already in the working tree — without losing that work and without hand-typing a branch name under time pressure.

## What it does

- Carries over the current uncommitted, unstaged modifications onto the new branch automatically. Nothing gets staged as a side effect.
- Asks for a task/issue number and a branch type (`feature`, `fix`, or whatever the repo's config allows), then names the branch `<type>/<task-or-issue>-<description>`.
- If the given type isn't in the repo's configured list, it asks for clarification instead of silently accepting it.

## Hard rule

Never lose uncommitted work. No modification may be staged, dropped, or overwritten by creating a branch — this is the single most important guarantee this skill has to keep.

## Shape

Installed and invoked as `git-agent-create-branch` (`/git-agent-create-branch`), prefixed per `docs/initial-guidelines.md` to avoid collisions with other installed skills. Its directory is `skills/git-agent-create-branch/`.

One subagent call: the unprefixed `create-branch` subcommand. There's no plan to approve here — type, task number, and description are already settled in conversation before the call happens.

## Out of scope

- Never touches code content.
- Doesn't track or remember a branch's parent for later use — see [create-pr](create-pr.md) for why that idea was dropped entirely.

## Done when

Starting from uncommitted modifications and a supplied type/task number, the result is a correctly named branch with every modification intact and still unstaged.
