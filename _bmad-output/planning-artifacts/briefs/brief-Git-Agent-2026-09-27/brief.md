---
title: "Product Brief: Git-Agent"
status: final
created: 2026-09-27
updated: 2026-09-27
---

# Product Brief: Git-Agent

## Executive Summary

Git-Agent is a set of Claude Code skills, backed by one dedicated git subagent, that does day-to-day git and GitHub work exactly the way its author does it. There are five skills: create a branch, commit, push, open a pull request, and update a branch from another branch. It is installed into a repository and uses that repository's Claude Code setup and whichever account the `gh` CLI is logged into in that repository. It never writes code. It only moves work through git, following written rules: never lose uncommitted changes, never force push, split commits by what they are about, and name branches and PRs to a fixed pattern.

The real goal is learning: the git tool is a vehicle for learning how agents are built in practice (see What This Is For, below). Success means the author can build this kind of agent again for their own everyday problems, and can explain every design choice in a job interview.

## What This Is For

This project is a hands-on way to learn how Claude Code agents are actually built, using a real, opinionated git workflow as the exercise. The finished thing matters less than being able to explain, in an interview or on the next unrelated agent, why each piece was built the way it was: which logic went in a skill versus a subagent, which rules were enforced with a hook versus a prompt, how the tool was packaged and installed with its own setup questions, and how its behavior was checked rather than assumed.

## The Problem

Generic git assistance (typing requests at Claude Code directly, or a generic plugin like `commit-commands`) does not enforce a specific author's habits: a fixed branch/PR naming convention, a hard "never force push" rule, commit plans split by topic instead of one commit per session, and a consistent check for local-only files before they land in a commit. Doing this by hand, every time, in every repo, is repetitive and easy to get wrong under time pressure — and skipping it has cost before (lost changes, messy history, an accidental force push).

## The Solution

Git-Agent is five Claude Code skills — create branch, commit, push, create PR, update branch — each a short, conversational entry point that hands the actual git/gh work to one dedicated subagent carrying the author's rules. The skill asks what only a person can answer (task number, branch type, approve this commit plan, which of these local-only files should be committed); the subagent does the reading and mechanical work (diff analysis, commit planning, running git and `gh` commands). A `PreToolUse` hook makes the no-force-push rule a hard guarantee rather than a prompt suggestion. The tool installs into a repository via `npx`, the way BMad does, asking a small number of setup questions (default task types, default PR target branch) the first time.

It uses whatever Claude Code and `gh` CLI are already set up in the repository where it's installed — no separate account or service of its own.

## What Makes This Different

This is not a race against `commit-commands` or asking Claude Code directly — both already do "generic" git help well. The difference is that Git-Agent encodes one person's specific rules as defaults and enforces the ones that must never be broken (no force push, never lose uncommitted changes) at the platform level, not just in a prompt. It is deliberately narrow: it never writes or edits code, only moves work through git and GitHub.

## Who This Serves

Primarily the author, as a personal tool and a learning project. Secondarily, anyone else with Claude Code and an authenticated `gh` CLI who wants to install the same opinionated git workflow into their own repo — the author's defaults apply out of the box, with a small config surface (task/branch types today) for adjusting them.

## Success Criteria

**Learning (primary):**
- Can explain, unprompted, how each of the five skills is split between the main-conversation skill and the git subagent, and why.
- Can point to a concrete rule (no force push) enforced by a hook, and explain why a hook was needed instead of just a prompt instruction.
- Can describe how the tool is packaged and installed, and what happens at first install (setup questions).
- Has run at least one skill against the disposable test repository and checked its resulting state, as a working answer to "how do you know your agent behaves correctly?"
- Could rebuild this pattern (skill + subagent + hook + install question) for a new, unrelated agent without starting from zero.

**Product (secondary, still real):**
- All five skills are implemented and each does its documented job in a real repository, on the author's own repos day to day.
- `git-agent` never loses uncommitted local changes and never force pushes, across ordinary use.
- `docs/` contains a complete, indexed description of what is defined, where, and why — usable by the author (or anyone else) to understand the system without reading all the source.

## Scope

**In for v1 — all five skills, built and documented in this order:**
1. **Create branch** — carries over modified changes without staging; asks for task/issue number and type (`feature`/`fix`); names `<type>/<task-or-issue>-<description>`; never loses changes.
2. **Commit** — inspects modified files, proposes a multi-commit plan (splitting within a single file when it holds two unrelated topics, showing which lines go to which commit); follows a repo's own commit template when one exists; asks about local-only-looking files (e.g. `.env`) rather than silently including or excluding them.
3. **Push** — never force pushes, under any circumstance.
4. **Create PR** — title follows the branch naming pattern; body has a summary and a test plan (split into several when needed); confirms or asks for the target branch, defaulting to the branch it detects as the current branch's parent, falling back to the install-time default when that isn't known.
5. **Update branch from another** — merges the chosen branch (local or from origin) into the current one; never rebases; on conflicts, stops and hands off to the user, and can continue once they're resolved.

Each skill gets its own implementation spec; skills are built and shipped one at a time, in the order above, rather than all at once.

**Also in scope:**
- One dedicated git subagent used by all five skills.
- A `PreToolUse` hook enforcing "never force push" as a hard rule.
- An `npx`-installed package, distributed from the author's own git repository (not a marketplace plugin), with first-run setup questions (default task/branch types, default PR target branch).
- A small, disposable test repository used to verify agent behavior: a skill is run against it in a known state, then the repository's resulting state is checked (right branch name, changes preserved, no force push occurred).
- A per-repo config file for the few things made configurable in v1 (task/branch types).
- An indexed `docs/` folder describing the system.

**Out for v1:**
- Any code-writing or code-editing behavior — this agent only moves work through git/GitHub.
- Rebase, in any flow.
- GitHub Issues integration — task/issue numbers are always typed by the user.
- Automatic handling of local-only files (auto-exclude or auto-`.gitignore`) — v1 only asks.
- Broad, general-purpose configurability — v1's config surface is deliberately just task/branch types.

## Open Questions

- **Where does the conversation live vs. where the git work happens?** Per Claude Code's docs, a subagent cannot ask the user questions (`AskUserQuestion` is unavailable to it) — it runs to completion and returns a result. The plan here is that each skill holds the conversation in the main session and delegates read/plan/execute work to the subagent. This needs to be validated while implementing the first skill (create branch), since it's the architectural decision the rest of the project depends on.
- **How is a branch's parent recorded?** Git does not track "which branch this was created from." The plan is for create-branch to record it (a small per-branch state file or scoped git config) so create-PR can default to it; branches created outside the agent won't have this, and fall back to the install-time default target.
- **How is a subagent's git-planning quality actually verified**, beyond the repo-state checks below — e.g. is a good commit split judged by a human reading it, or by some automated rubric? Left open for implementation time.

## Vision

If this works, the pattern generalizes past git: a small library of narrow, rule-following subagents — each backed by skills that hold the conversation and a subagent that does the disciplined, opinionated execution — for the recurring workflows in the author's own day-to-day work, each one built the same well-understood way.
