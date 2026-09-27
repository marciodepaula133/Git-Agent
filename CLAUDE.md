<!-- bmad:context -->
<!-- Verified 2026-09-27 against repo state (not yet a git repository — no SHA). Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## Git-Agent

This repo builds Git-Agent: Claude Code skills (`create-branch`, `commit`, `push`, `create-pr`, `update-branch`, `configure`) backed by one shared git/GitHub subagent built on the Claude Agent SDK. TypeScript/Node.js. No implementation exists yet.

The sections below are instructions for you, Claude Code, working in this repo — they are not the product's own behavior. Git-Agent's own git rules (never force-push, never rebase, etc.) are a spec for the code you're writing, documented in `docs/`, not a description of how you should use git while developing this repo.

## Before implementing any skill or subagent action

Read [docs/architecture.md](docs/architecture.md) and the matching page in [docs/skills/](docs/skills/) first. They hold the binding design decisions — call shapes between a skill and the subagent, which side owns which rule, the safety-hook mechanics, config ownership — and code that doesn't match them will build the wrong thing even if it works. In particular:

- The subagent is the only thing that ever runs git/`gh` commands, and only via the Claude Agent SDK's own tool-use loop — never a bypassing direct process call, or the no-force-push hook silently stops firing. Skills never run git/`gh` directly.
- The subagent has no code path for reading or writing `.git-agent/config.json` — skills own all config I/O directly.
- A subagent call never spans a user decision — see `docs/architecture.md` for the two-call flows (`plan-commit`/`execute-commit`, `draft-pr`/`create-pr`) and why.

## Where things are

- [docs/architecture.md](docs/architecture.md) — the full design: skill/subagent split, every hard invariant, conventions, stack.
- [docs/skills/](docs/skills/) — one page per skill: what it does, its rules, its done-when criteria.
- [docs/initial-guidelines.md](docs/initial-guidelines.md) — the author's original hand-written rules this project is built from.
- Planned (not yet scaffolded) layout: `skills/<name>/`, `subagent/src/actions/<action>.ts`, `subagent/src/hooks/no-force-push.ts` — see `docs/architecture.md`.

## Running and verifying

- No code exists yet — no `package.json`, no build/test/lint commands. TODO once `subagent/` is scaffolded: pin these commands here, and set up ESLint + strict `tsconfig.json` (`strict: true`) as the actual enforcement point for TypeScript conventions, rather than relying on prose in this file.
- Requires the `@anthropic-ai/claude-code` CLI installed locally as the subagent's execution backend and auth source. The installer should detect an existing `claude` CLI rather than `npm install` it — that install path is deprecated upstream as of 2026-09-27.
- `@anthropic-ai/claude-agent-sdk` is a fast-moving package (multiple releases a day) — re-check the current version at install time rather than trusting any version pinned in a doc.

## Conventions that differ from defaults

- Subcommand naming is verb-first kebab-case (`plan-commit`, `execute-commit`, `draft-pr`, ...).
- The subagent takes input via stdin only, never CLI flags — a large commit plan can exceed Windows' argv-length limit.
- The subagent's final stdout line is exactly one JSON object, `{ ok: boolean, ... }`; failure `reason` is a closed enum (`conflict`, `non-fast-forward`, `branch-exists`, `no-changes`, `invalid-target`, `unexpected-error`) — never treat it as illustrative. A commit plan's local-only file candidates travel inside a successful (`ok:true`) result — they're never themselves a stop condition.

## Known pitfalls

- Keep `docs/` in sync with what's actually built — update the relevant doc alongside the code whenever an implementation decision changes or diverges from what's written there, not after the fact.

<!-- /bmad:context -->
