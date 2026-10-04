import { query, type HookCallback, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { noForcePushHookMatcher } from '../hooks/no-force-push.js';

export type MergeInput = {
  from: string;
};

export type MergeOutcome = 'up-to-date' | 'fast-forward' | 'merged';

export type MergeResult =
  | { ok: true; result: MergeOutcome }
  | { ok: false; reason: 'conflict'; files: string[] }
  | { ok: false; reason: 'invalid-target' }
  | { ok: false; reason: 'unexpected-error' };

/** Injectable to keep this action unit-testable without a live SDK session. */
export type QueryFn = typeof query;

type Outcome = MergeOutcome | 'invalid-target' | 'conflict' | 'error';

const RESULT_LINE = /^RESULT:\s*(up-to-date|fast-forward|merged|invalid-target|conflict|error)\s*$/im;
const FILE_LINE = /^FILE:\s*(.+)$/im;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splits a merge source on its first "/" into a candidate remote and branch
 * name. This is a pure string operation — whether that candidate remote is
 * an actually-configured remote is decided live, inside the SDK session, by
 * the model reading `git remote` output (AD-10: never assumed ahead of time).
 */
function splitRemoteQualified(from: string): { remote: string; branch: string } | null {
  const slashIndex = from.indexOf('/');
  if (slashIndex <= 0 || slashIndex === from.length - 1) return null;
  return { remote: from.slice(0, slashIndex), branch: from.slice(slashIndex + 1) };
}

function buildPrompt(from: string): string {
  const remoteSplit = splitRemoteQualified(from);

  const lines = [
    `You are merging "${from}" into the current branch in the current repository, using a plain merge — never a rebase.`,
    'Follow these steps exactly, in order, and do nothing else:',
    '1. Run: git remote',
    `2. Look at that output. If "${from}" contains a "/", take everything before the FIRST "/" as a candidate remote name and everything after it as a candidate branch name. If that candidate remote name appears as one of the exact lines printed by step 1, treat "${from}" as remote-qualified with that remote and branch; otherwise treat "${from}" as a plain local ref and skip step 3 entirely.`,
  ];

  if (remoteSplit) {
    lines.push(
      `3. If (and only if) "${from}" was determined to be remote-qualified in step 2, run: git fetch ${remoteSplit.remote} ${remoteSplit.branch}`,
      '   If that fetch fails, do not run any other command. Reply with exactly one line: "RESULT: error" followed by the error text on the next line, and stop.',
    );
  } else {
    lines.push(`3. "${from}" has no "/", so it cannot be remote-qualified — skip any fetch.`);
  }

  lines.push(
    `4. Run: git rev-parse --verify --quiet ${from}^{commit}`,
    '   If that command exits with a non-zero status, do not run any other command. Reply with exactly one line: "RESULT: invalid-target" and stop.',
    '5. Run: git rev-parse HEAD',
    '   Remember this output exactly as PRE_HEAD.',
    `6. Run: git merge --no-edit ${from}`,
    '   Never pass -X ours, -X theirs, --squash, or any other flag beyond --no-edit. Never run git merge --abort, git rebase, or git reset, no matter what happens next or afterward.',
    '7. If step 6 exited with a non-zero status (a conflict):',
    '   Run: git status --porcelain=v1',
    '   Identify every line whose two-letter status code has "U" in either position, or is exactly "AA" or "DD" — these are the conflicting files.',
    '   Leave the working tree exactly as git left it — do not stage, commit, or abort anything.',
    '   Reply with "RESULT: conflict" on its own line, followed by one "FILE: <path>" line per conflicting file (using the exact path from the status output), and stop.',
    '8. If step 6 exited with status 0 (no conflict):',
    '   Run: git rev-parse HEAD',
    '   If this output is character-for-character identical to PRE_HEAD, reply with exactly one line: "RESULT: up-to-date" and stop.',
    '   Otherwise, run: git log -1 --format=%P HEAD',
    '   If that output contains exactly one commit hash, reply with exactly one line: "RESULT: fast-forward" and stop.',
    '   If that output contains exactly two commit hashes, reply with exactly one line: "RESULT: merged" and stop.',
    '   If it contains any other number of hashes, reply with "RESULT: error" followed by that output on the next line, and stop.',
    'Never run git push, git rebase, git merge --abort, git reset, git stash, git commit, or any command with a force flag.',
  );

  return lines.join('\n');
}

function parseOutcome(resultText: string): { outcome: Outcome; tail: string } {
  let lastMatch: RegExpExecArray | null = null;
  for (const match of resultText.matchAll(new RegExp(RESULT_LINE, 'gim'))) {
    lastMatch = match as RegExpExecArray;
  }
  if (!lastMatch) return { outcome: 'error', tail: '' };
  return {
    outcome: lastMatch[1] as Outcome,
    tail: resultText.slice((lastMatch.index ?? 0) + lastMatch[0].length),
  };
}

function parseConflictFiles(tail: string): string[] {
  const files: string[] = [];
  for (const match of tail.matchAll(new RegExp(FILE_LINE, 'gim'))) {
    files.push(match[1].trim());
  }
  return files;
}

/**
 * Builds a `PreToolUse` hook scoped to one `merge` call: this action's
 * prompt only ever needs to run its fixed sequence of read-only checks, the
 * optional fetch, and the merge itself, so anything else — including
 * `git merge --abort`, `git rebase`, or any push — is denied here rather
 * than relying solely on the prompt's natural-language instructions.
 */
export function mergeOnlyIntendedCommandsHook(from: string): HookCallback {
  const escapedFrom = escapeRegExp(from);
  const remoteSplit = splitRemoteQualified(from);

  const allowedCommands = [
    /^git remote$/,
    new RegExp(`^git rev-parse --verify --quiet ${escapedFrom}\\^\\{commit\\}$`),
    /^git rev-parse HEAD$/,
    new RegExp(`^git merge --no-edit ${escapedFrom}$`),
    /^git status --porcelain=v1$/,
    /^git log -1 --format=%P HEAD$/,
  ];
  if (remoteSplit) {
    allowedCommands.push(
      new RegExp(`^git fetch ${escapeRegExp(remoteSplit.remote)} ${escapeRegExp(remoteSplit.branch)}$`),
    );
  }

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
        permissionDecisionReason: `Denied: merge may only run its fixed sequence of git commands for "${from}" (got: ${command}).`,
      },
    };
  };
}

/**
 * Runs the `merge` subagent action: merges `input.from` into the current
 * branch via a `query()` session whose only tool is `Bash`, with the shared
 * `no-force-push` hook plus a scoped intended-commands hook wired into that
 * same session (AD-3/AD-4). Never rebases, never force-flags, never aborts a
 * conflicted merge.
 *
 * `deps.queryFn` is an injection point for tests; production code always
 * gets the real SDK `query`.
 */
export async function merge(
  input: MergeInput,
  deps: { queryFn?: QueryFn } = {},
): Promise<MergeResult> {
  const runQuery = deps.queryFn ?? query;

  try {
    const from = (input as { from?: unknown } | null | undefined)?.from;
    if (typeof from !== 'string' || from.length === 0) {
      return { ok: false, reason: 'unexpected-error' };
    }

    let outcome: Outcome = 'error';
    let tail = '';

    const stream = runQuery({
      prompt: buildPrompt(from),
      options: {
        tools: ['Bash'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // Use the user's own locally installed `claude` CLI (resolved via
        // PATH) as the execution backend — see create-branch.ts for why.
        pathToClaudeCodeExecutable: 'claude',
        hooks: {
          PreToolUse: [
            noForcePushHookMatcher,
            { matcher: 'Bash', hooks: [mergeOnlyIntendedCommandsHook(from)] },
          ],
        },
      },
    });

    for await (const message of stream) {
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          ({ outcome, tail } = parseOutcome(message.result));
          if (outcome === 'error') {
            process.stderr.write(
              `git-agent merge: model's final reply did not contain a recognized RESULT line. Full reply:\n${message.result}\n`,
            );
          }
        } else {
          outcome = 'error';
          process.stderr.write(
            `git-agent merge: session ended with subtype "${message.subtype}" (is_error=${message.is_error}, stop_reason=${String(message.stop_reason)}). errors: ${JSON.stringify(message.errors)}\n`,
          );
        }
      }
    }

    if (outcome === 'up-to-date' || outcome === 'fast-forward' || outcome === 'merged') {
      return { ok: true, result: outcome };
    }
    if (outcome === 'invalid-target') return { ok: false, reason: 'invalid-target' };
    if (outcome === 'conflict') return { ok: false, reason: 'conflict', files: parseConflictFiles(tail) };
    return { ok: false, reason: 'unexpected-error' };
  } catch (error) {
    process.stderr.write(`git-agent merge: unexpected exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return { ok: false, reason: 'unexpected-error' };
  }
}
