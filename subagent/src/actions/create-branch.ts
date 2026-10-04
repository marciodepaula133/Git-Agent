import { query, type HookCallback, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { noForcePushHookMatcher } from '../hooks/no-force-push.js';

export type CreateBranchInput = {
  branchName: string;
};

export type CreateBranchResult =
  | { ok: true; branchName: string }
  | { ok: false; reason: 'branch-exists' | 'unexpected-error' };

/** Injectable to keep this action unit-testable without a live SDK session. */
export type QueryFn = typeof query;

type Outcome = 'created' | 'branch-exists' | 'error';

const RESULT_LINE = /^RESULT:\s*(created|branch-exists|error)\s*$/im;

function buildPrompt(branchName: string): string {
  return [
    `You are creating a git branch named exactly "${branchName}" in the current repository.`,
    'Follow these steps exactly, in order, and do nothing else:',
    `1. Run: git show-ref --verify --quiet refs/heads/${branchName}`,
    '2. If that command exits with status 0, the branch already exists.',
    '   Do not run any other command. Reply with exactly one line: "RESULT: branch-exists" and stop.',
    `3. If that command exits with a non-zero status, run: git checkout -b ${branchName}`,
    '   This must run from the current HEAD, carrying over any uncommitted, unstaged',
    '   modifications untouched — never stage, commit, stash, or discard anything.',
    '4. If the checkout succeeds, reply with exactly one line: "RESULT: created" and stop.',
    '5. If the checkout fails for any reason, reply with exactly one line: "RESULT: error"',
    '   followed by the error text on the next line, and stop.',
    'Never run git push, git commit, git add, git reset, git rebase, git stash, or any command',
    'with a force flag. Never modify, stage, or drop any file.',
  ].join('\n');
}

function parseOutcome(resultText: string): Outcome {
  let lastMatch: RegExpExecArray | null = null;
  for (const match of resultText.matchAll(new RegExp(RESULT_LINE, 'gim'))) {
    lastMatch = match as RegExpExecArray;
  }
  return lastMatch ? (lastMatch[1] as Outcome) : 'error';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a `PreToolUse` hook scoped to one `createBranch` call: this action's
 * prompt only ever needs to run the existence check and the checkout, so
 * anything else — even something that isn't push-shaped, like `git add` or
 * `git stash` — is denied here rather than relying solely on the prompt's
 * natural-language instructions to keep the "never lose uncommitted work"
 * guarantee.
 */
export function createOnlyIntendedCommandsHook(branchName: string): HookCallback {
  const escapedName = escapeRegExp(branchName);
  const allowedCommands = [
    new RegExp(`^git show-ref --verify --quiet refs/heads/${escapedName}$`),
    new RegExp(`^git checkout -b ${escapedName}$`),
  ];

  return async (input): Promise<SyncHookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
      return {};
    }

    const toolInput = input.tool_input as { command?: unknown } | undefined;
    const command = typeof toolInput?.command === 'string' ? toolInput.command.trim() : '';

    if (allowedCommands.some((pattern) => pattern.test(command))) {
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Denied: create-branch may only run the show-ref existence check and "git checkout -b ${branchName}" (got: ${command}).`,
      },
    };
  };
}

/**
 * Runs the `create-branch` subagent action: creates `input.branchName` from
 * the current HEAD via a `query()` session whose only tool is `Bash`, with
 * the shared `no-force-push` hook wired into that same session (AD-3/AD-4).
 *
 * `deps.queryFn` is an injection point for tests; production code always
 * gets the real SDK `query`.
 */
export async function createBranch(
  input: CreateBranchInput,
  deps: { queryFn?: QueryFn } = {},
): Promise<CreateBranchResult> {
  const runQuery = deps.queryFn ?? query;

  try {
    const branchName = (input as { branchName?: unknown } | null | undefined)?.branchName;
    if (typeof branchName !== 'string' || branchName.length === 0) {
      return { ok: false, reason: 'unexpected-error' };
    }

    let outcome: Outcome = 'error';

    const stream = runQuery({
      prompt: buildPrompt(branchName),
      options: {
        tools: ['Bash'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        hooks: {
          PreToolUse: [
            noForcePushHookMatcher,
            { matcher: 'Bash', hooks: [createOnlyIntendedCommandsHook(branchName)] },
          ],
        },
      },
    });

    for await (const message of stream) {
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          outcome = parseOutcome(message.result);
          if (outcome === 'error') {
            process.stderr.write(
              `git-agent create-branch: model's final reply did not contain a recognized RESULT line. Full reply:\n${message.result}\n`,
            );
          }
        } else {
          outcome = 'error';
          process.stderr.write(
            `git-agent create-branch: session ended with subtype "${message.subtype}" (is_error=${message.is_error}, stop_reason=${String(message.stop_reason)}). errors: ${JSON.stringify(message.errors)}\n`,
          );
        }
      }
    }

    if (outcome === 'created') return { ok: true, branchName };
    if (outcome === 'branch-exists') return { ok: false, reason: 'branch-exists' };
    return { ok: false, reason: 'unexpected-error' };
  } catch (error) {
    process.stderr.write(`git-agent create-branch: unexpected exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return { ok: false, reason: 'unexpected-error' };
  }
}
