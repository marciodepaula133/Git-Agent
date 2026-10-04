import { query, type HookCallback, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { noForcePushHookMatcher } from '../hooks/no-force-push.js';

export type PushInput = {
  branchName: string;
};

export type PushResult =
  | { ok: true; branchName: string }
  | { ok: false; reason: 'non-fast-forward' | 'unexpected-error' };

/** Injectable to keep this action unit-testable without a live SDK session. */
export type QueryFn = typeof query;

type Outcome = 'pushed' | 'non-fast-forward' | 'wrong-branch' | 'error';

const RESULT_LINE = /^RESULT:\s*(pushed|non-fast-forward|wrong-branch|error)\s*$/im;

function buildPrompt(branchName: string): string {
  return [
    `You are pushing the local branch named exactly "${branchName}" to its remote.`,
    'Follow these steps exactly, in order, and do nothing else:',
    '1. Run: git rev-parse --abbrev-ref HEAD',
    `2. If its output is not exactly "${branchName}", do not push anything. Reply with`,
    '   exactly one line: "RESULT: wrong-branch" and stop.',
    `3. Run: git rev-parse --abbrev-ref --symbolic-full-name ${branchName}@{upstream}`,
    '4. If that command exits with status 0, the branch already has an upstream.',
    '   Run: git push',
    `5. If that command exits with a non-zero status, the branch has no upstream yet.`,
    `   Run: git push -u origin ${branchName}`,
    '6. If the push (from step 4 or step 5) succeeds, reply with exactly one line:',
    '   "RESULT: pushed" and stop.',
    '7. If the push is rejected because the remote has commits this branch does not',
    '   (a non-fast-forward / "updates were rejected" rejection), do not retry, do not',
    '   force, and do not run any other command. Reply with exactly one line:',
    '   "RESULT: non-fast-forward" and stop.',
    '8. If the push fails for any other reason, reply with exactly one line:',
    '   "RESULT: error" followed by the error text on the next line, and stop.',
    'Never pass --force, -f, --force-with-lease, or any other force-shaped flag, under',
    'any circumstance. Never run git commit, git add, git reset, git rebase, git stash,',
    'or any command other than the ones listed above. Never modify, stage, or drop any file.',
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
 * Builds a `PreToolUse` hook scoped to one `push` call: this action's prompt
 * only ever needs the upstream check and exactly one of the two push forms,
 * so anything else — even something that isn't push-shaped, like `git add`
 * or `git rebase` — is denied here rather than relying solely on the
 * prompt's natural-language instructions. No force flag is ever in this
 * allow-list; the shared `noForcePushHookMatcher` is defense in depth on top
 * of this, not the only guard (see docs/skills/push.md).
 */
export function createOnlyIntendedCommandsHook(branchName: string): HookCallback {
  const escapedName = escapeRegExp(branchName);
  const allowedCommands = [
    /^git rev-parse --abbrev-ref HEAD$/,
    new RegExp(`^git rev-parse --abbrev-ref --symbolic-full-name ${escapedName}@\\{upstream\\}$`),
    /^git push$/,
    new RegExp(`^git push -u origin ${escapedName}$`),
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
        permissionDecisionReason: `Denied: push may only check for an upstream and then run a plain "git push" or "git push -u origin ${branchName}" (got: ${command}).`,
      },
    };
  };
}

/**
 * Runs the `push` subagent action: pushes the current local branch
 * (`input.branchName`) to its remote via a `query()` session whose only tool
 * is `Bash`, with the shared `no-force-push` hook wired into that same
 * session (AD-3/AD-4) plus a scoped allow-list hook restricting the session
 * to the exact commands this action needs.
 *
 * `deps.queryFn` is an injection point for tests; production code always
 * gets the real SDK `query`.
 */
export async function push(
  input: PushInput,
  deps: { queryFn?: QueryFn } = {},
): Promise<PushResult> {
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
        // Use the user's own locally installed `claude` CLI (resolved via
        // PATH) as the execution backend, rather than the SDK's bundled
        // platform-native binary — that binary ships as a sibling package
        // in the SDK's own node_modules, which doesn't exist once this
        // file is bundled and installed standalone inside another repo's
        // skill folder (no node_modules tree for it to be found in).
        pathToClaudeCodeExecutable: 'claude',
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
              `git-agent push: model's final reply did not contain a recognized RESULT line. Full reply:\n${message.result}\n`,
            );
          }
        } else {
          outcome = 'error';
          process.stderr.write(
            `git-agent push: session ended with subtype "${message.subtype}" (is_error=${message.is_error}, stop_reason=${String(message.stop_reason)}). errors: ${JSON.stringify(message.errors)}\n`,
          );
        }
      }
    }

    if (outcome === 'pushed') return { ok: true, branchName };
    if (outcome === 'non-fast-forward') return { ok: false, reason: 'non-fast-forward' };
    if (outcome === 'wrong-branch') {
      process.stderr.write(
        `git-agent push: refusing to push — checked-out branch did not match requested branchName "${branchName}".\n`,
      );
    }
    return { ok: false, reason: 'unexpected-error' };
  } catch (error) {
    process.stderr.write(`git-agent push: unexpected exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return { ok: false, reason: 'unexpected-error' };
  }
}
