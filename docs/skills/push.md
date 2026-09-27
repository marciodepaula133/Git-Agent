# push

## What it's for

Making "never force push" a structural guarantee instead of a prompt suggestion that can be forgotten or argued past under time pressure.

## What it does

- Pushes committed work to the remote through the ordinary path — this is unaffected by the safety hook and just works.
- Makes force-pushing structurally impossible, no matter what invokes it. A direct attempt to run `git push --force` or `--force-with-lease` through the agent's tool path is blocked *before* it executes — this covers long form (`--force`), short form (`-f`), value-attached (`--force-with-lease=<ref>`), and combined short flags (`-uf`).

## Rules

- Enforced by a `PreToolUse` hook registered inside the subagent's own SDK session, on its `Bash` tool calls — deny-by-default for anything push-shaped. It parses the actual argument tokens rather than matching one regex against the raw command string.
- That hook lives only inside the subagent's own SDK session. It's never written to `settings.json` or `settings.local.json`, and it never affects the user's manual terminal use or any other Claude Code session.
- Every git-mutating action has to run its git/GitHub commands through the SDK's own tool-use loop — a bypassing direct process call would mean the hook simply never fires. See [architecture.md](../architecture.md) for why this matters.

## Out of scope

- No exception path or override flag for force-push, ever, under any circumstance.
- Doesn't manage its own GitHub account or credentials — uses whichever account the repo's `gh` CLI is already authenticated as.

## Done when

Across ordinary use, Git-Agent never force-pushes and never loses uncommitted local changes. A deliberately induced force-push attempt during testing is blocked by the hook, while a normal push through the same path succeeds unaffected.
