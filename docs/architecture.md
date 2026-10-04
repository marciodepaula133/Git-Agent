# Architecture

## Shape of the system

Git-Agent has two halves:

- **Skills** — six Claude Code skills (`git-agent-create-branch`, `git-agent-commit`, `git-agent-push`, `git-agent-create-pr`, `git-agent-update-branch`, `git-agent-configure`), installed and invoked with a `git-agent-` prefix to avoid collisions with other installed skills (`docs/initial-guidelines.md`), that run inside the user's normal interactive Claude Code session. Skills own the whole conversation: every question asked of the user, every decision the user makes, and any state that needs to survive across more than one step of a flow (e.g. holding a commit plan while the user reviews it). The subagent's own subcommands stay unprefixed and verb-first (`create-branch`, `plan-commit`, ...) — the prefix is a skill-naming concern only.
- **One shared subagent** — a standalone TypeScript program built on the Claude Agent SDK. It's invoked fresh as a subprocess for each action, does one thing, and returns. It never asks the user anything, never remembers a previous call, and carries its own git/GitHub tool access and safety rules in its own code.

A skill talks to the subagent by running it as a subprocess and exchanging JSON: it writes the input to the subagent's stdin, and the subagent's last line of stdout is a single JSON object with the result. The subagent talks to git, GitHub, and the local repo directly; skills never do.

The subagent binary isn't a published npm package the skill reaches via `npx` — it's bundled (via esbuild, SDK and all dependencies inlined into one self-contained file) directly into each skill folder that needs it, so installing the skill (via the generic `skills` CLI, see Stack below) brings the subagent along with it. No npm publish, no `npm link`, no separate install step.

```
skills/git-agent-<name>/              Claude Code skill definitions (installed/invoked name is prefixed)
skills/git-agent-<name>/subagent/cli.mjs   bundled subagent, built by `npm run bundle` — ships with the skill
subagent/src/cli.ts                   single binary source, routes to one handler per action
subagent/src/actions/*.ts             one file per subagent action (create-branch, plan-commit, push, ...)
subagent/src/hooks/*.ts               safety rules shared by every action (e.g. no-force-push)
scripts/bundle-skill-subagents.mjs    bundles subagent/src/cli.ts and copies it into every skill that needs it
install/setup.ts                      first-run and re-run config flow
<installed repo>/.git-agent/config.json   per-repo settings (task types, default PR target)
```

The `create-branch` action, the `no-force-push` hook, and the `git-agent-create-branch` skill (with its bundled subagent) are built; `install/setup.ts` and the remaining actions/skills are still target, not built.

## Why split this way

The whole point of Git-Agent is that certain rules — never force-push, never lose uncommitted work, never rebase — have to be *guarantees*, not habits a prompt might forget under pressure. A prompt instruction can be argued past or simply missed; a hook that runs before every git command cannot be.

Putting the subagent in charge of every git/GitHub call, and putting the safety hook inside the subagent's own SDK session, means the guarantee only has to be correct in one place, and it's a place that's exercised on every single git-mutating call, no matter which skill triggered it.

## Rules that shape every skill

These are the hard invariants. Nothing about how a skill is built should be able to violate them.

1. **A subagent call never spans a user decision.** If a flow needs the user to review something mid-way (approve a commit plan, edit a PR draft), it's split into two subagent calls: the first returns a self-contained result, the skill does all the back-and-forth with the user, and the second call gets the *original result plus the user's raw, unedited decisions* — never something the skill parsed or rewrote itself.
2. **The subagent is real code, not a declarative Claude Code subagent file.** It's a TypeScript program that calls the Claude Agent SDK's `query()`/`ClaudeSDKClient` itself, launched as a subprocess. This is what lets it carry its own safety hook — a `.claude/agents/*.md` definition invoked via the `Task` tool can't scope a hook to just itself.
3. **No force-push, ever, structurally.** The subagent registers a `PreToolUse` hook on its own SDK session's `Bash` tool matcher. The hook is deny-by-default for anything push-shaped: it parses the actual argument tokens (not one regex over the raw command string), and only lets through a recognized plain `git push` / `gh` push-equivalent with no force-indicating flag anywhere — covering `--force`, `-f`, `--force-with-lease=<ref>`, and combined short flags like `-uf`. Anything it doesn't recognize as a safe plain push is denied, not allowed through. This hook lives only inside the subagent's own SDK session — never in `settings.json`, never affecting the user's manual terminal, never affecting any other Claude Code session.
4. **Every git-mutating action must run git through the SDK's own tool-use loop.** If an action shelled out to git directly (e.g. `child_process.exec`) instead of issuing it as a `Bash` tool call inside the same `query()` session that registered the hook, the hook would simply never fire. This is the condition that makes rule 3 actually work.
5. **One subagent binary, subcommand-routed.** Like `git` itself: `subagent/src/cli.ts` is the single source routing on the first argument to one handler per action. New actions are new routed handlers, not new binaries — `npm run bundle` then copies the same compiled binary into every skill folder that needs it.
6. **Call count follows whether a plan needs approval:**

   | Flow | Calls | Shape |
   | --- | --- | --- |
   | create-branch | 1 | `create-branch` — nothing to approve, everything's already resolved in conversation |
   | commit | 2 | `plan-commit` → user reviews/decides → `execute-commit` |
   | push | 1 | `push` — hook-enforced, never force |
   | create-pr | 2 | `draft-pr` → user edits → `create-pr` |
   | update-branch | 1 or 2 | `merge` (clean = done; conflict = report and hand off) → `finish-merge` only if there was a conflict |
   | configure | 0 | direct file I/O in the skill; no subagent involved |

7. **There is no branch-parent tracking, anywhere.** `create-pr` never tries to detect what a branch was created from. The target branch always defaults to the repo's configured `defaultPrTarget`, shown to the user to confirm or override before the PR is actually created. A parent-tracking mechanism was considered and deliberately dropped — its failure modes (a stale record after a rename or delete) outweighed the convenience.
8. **The subagent never touches the config file.** `.git-agent/config.json` (task/branch types, default PR target) is read and written directly by skills. The `configure` skill writes it; every other skill reads it when it needs those values. The subagent has no config code path at all — config isn't git/GitHub work.
9. **The commit plan has one fixed shape, and "local-only" detection belongs to the subagent, not the skill.** `plan-commit` is the only thing that decides a file looks local-only (things like `.env`, `.env.*`, `*.pem`, `*.key`, `credentials*`, `secrets*`, `*.local` — a seed list meant to grow). The skill never scans the working tree itself. `plan-commit` always succeeds (`ok: true`) and returns:

   ```json
   {
     "ok": true,
     "commits": [{ "id": 0, "message": "...", "hunks": [{ "file": "...", "startLine": 1, "endLine": 10 }] }],
     "localOnlyCandidates": [{ "file": "..." }]
   }
   ```

   The skill relays this to the user (approve/adjust the split, decide each local-only candidate), then calls `execute-commit` with exactly the original plan plus the user's raw decisions:

   ```json
   {
     "plan": { "...verbatim plan-commit output, unmodified..." },
     "decisions": {
       "localOnly": { "<file>": "include | exclude" },
       "commitEdits": { "merge": [[0, 1]], "exclude": [2] }
     }
   }
   ```

   `execute-commit` commits using the exact hunks from the original plan — never a fresh re-diff — so what the user approved is exactly what gets committed, even if the working tree changed in between. A local-only candidate is never treated as a stop condition; it travels inside a normal successful result.

10. **`update-branch` fetches first when merging a remote-qualified ref.** If the merge source is something like `origin/main`, the subagent runs `git fetch <remote> <branch>` immediately before merging, so it's never merging against a stale local view of the remote. If the source is a local branch, no fetch happens — there's nothing remote to reconcile against.

## Conventions

- Subcommands are named verb-first, kebab-case: `plan-commit`, `execute-commit`, `create-branch`, `push`, `draft-pr`, `create-pr`, `merge`, `finish-merge`.
- The subagent takes input on **stdin only**, never as a CLI argument — a large commit plan can exceed Windows' argv-length limit.
- The subagent's output is exactly one JSON object as its last line of stdout: `{ "ok": boolean, ... }`. On failure, `reason` is one of a closed set: `"conflict"`, `"non-fast-forward"`, `"branch-exists"`, `"no-changes"`, `"invalid-target"`, `"unexpected-error"` — plus whatever extra detail that failure needs (e.g. a `files` list for a conflict). A non-zero process exit code is reserved for genuinely unexpected failures, never for one of these ordinary `ok:false` results.
- The subagent reuses the `claude` CLI's existing authentication (the SDK's default transport) — there's no separate credential store. `defaultPrTarget` is stored as a bare branch name (e.g. `"main"`) and passed straight to `gh pr create --base <name>`.

## Stack

| Piece | Notes |
| --- | --- |
| TypeScript / Node.js | current LTS |
| `@anthropic-ai/claude-agent-sdk` | releases multiple times a day — treat any pinned version as a snapshot to re-check at install time, not a fixed fact |
| `@anthropic-ai/claude-code` (CLI) | required locally — it's the SDK's execution backend and auth source. As of this writing, installing it via `npm install` is deprecated upstream in favor of the curl/Homebrew/native installers; the installer should detect an existing `claude` CLI rather than assume or perform an npm install of it |
| `esbuild` | bundles `subagent/src/cli.ts` (SDK and all dependencies inlined) into one self-contained file per skill that needs it — `npm run bundle` |
| Distribution | installed via the generic `skills` CLI (`npx skills add <repo> --skill <name>`, the same tool used for this repo's own BMad skills), not a published npm package — the subagent is bundled into the skill folder itself (see above), so there is nothing to `npm publish`. `@marciodepaula133/git-agent` remains this repo's own (private, unpublished) `package.json` name for local dev/build tooling only. |

## Known open items

- How a subagent's git-planning quality (e.g. "is this a good commit split") gets verified is still an open question — left for implementation time, not a structural decision.
- Exactly how `plan-commit` detects a repo's commit template (reading `commit.template` from git config vs. a hardcoded `.gitmessage` path) is left to its own implementation — this is internal to one action, so there's no risk of two parts of the system disagreeing about it.
- Test-repo fixtures for exercising each skill haven't been designed yet.
- There's no CI, hosting, or server-side component of any kind — Git-Agent is entirely local, installed per-repo.
