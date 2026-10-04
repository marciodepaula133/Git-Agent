import { query, type HookCallback, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { noForcePushHookMatcher } from '../hooks/no-force-push.js';

// Nothing travels from the skill into this action: it discovers everything
// it needs (whether a merge is in progress, which files were unmerged) live
// from the repository itself, rather than trusting a caller-supplied list.
export type FinishMergeInput = Record<string, never>;

export type FinishMergeResult =
  | { ok: true }
  | { ok: false; reason: 'conflict'; files: string[] }
  | { ok: false; reason: 'unexpected-error' };

/** Injectable to keep this action unit-testable without a live SDK session. */
export type QueryFn = typeof query;

type Outcome = 'completed' | 'conflict' | 'no-merge-in-progress' | 'error';

const RESULT_LINE = /^RESULT:\s*(completed|conflict|no-merge-in-progress|error)\s*$/im;
const FILE_LINE = /^FILE:\s*(.+)$/im;

function buildPrompt(): string {
  return [
    'You are completing an in-progress git merge in the current repository, after the user has resolved its conflicts by hand.',
    'Follow these steps exactly, in order, and do nothing else:',
    '1. Run: git rev-parse -q --verify MERGE_HEAD',
    '   If that command exits with a non-zero status (or prints nothing), there is no merge in progress.',
    '   Do not run any other command. Reply with exactly one line: "RESULT: no-merge-in-progress" and stop.',
    '2. Run: git status --porcelain=v1',
    '   Identify every line whose two-letter status code has "U" in either position, or is exactly "AA" or "DD" — these are the unmerged files. Remember this exact list of paths; it never changes for the rest of these steps.',
    '3. For each unmerged file from step 2, run: git diff --check -- <that file>',
    '   If any of them still shows a leftover conflict marker, or you otherwise see "<<<<<<<", "=======", or ">>>>>>>" still present in any of these files, do not stage or commit anything.',
    '   Reply with "RESULT: conflict" on its own line, followed by one "FILE: <path>" line per unmerged file that still has markers, and stop.',
    '4. If none of the unmerged files from step 2 have any markers left, stage exactly those files, one at a time: run "git add <path>" once per file, using its exact path from step 2. Never run "git add -A", "git add -u", "git add .", or add any file not in that list.',
    '5. Run: git commit --no-edit',
    '   This must use the default merge commit message already set from MERGE_HEAD — never pass -m or any other message override, and never --amend.',
    '6. If the commit in step 5 succeeds, reply with exactly one line: "RESULT: completed" and stop.',
    '7. If the commit in step 5 fails for any reason, reply with "RESULT: error" followed by the error text on the next line, and stop.',
    'Never run git merge --abort, git rebase, git reset, git stash, or any command with a force flag.',
  ].join('\n');
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
 * Builds a `PreToolUse` hook scoped to one `finish-merge` call. The exact
 * file paths this action will touch aren't known ahead of time (they're
 * discovered live from `git status`), so this hook allows by command
 * *shape* rather than by exact string match: a single-path `git add`, a
 * `git diff --check` diagnostic, and nothing else that mutates the repo
 * besides the one final `git commit --no-edit`.
 */
export function finishMergeOnlyIntendedCommandsHook(): HookCallback {
  const allowedExact = [/^git rev-parse -q --verify MERGE_HEAD$/, /^git status --porcelain=v1$/, /^git commit --no-edit$/];
  const diffCheck = /^git diff --check( -- .+)?$/;
  // A single positional argument only — a bare path, or one quoted to carry
  // spaces. No flags (which would include "-A", "-u"), and never the bare
  // "." (which means "everything in this directory", not one exact path).
  const singlePathAdd = /^git add (?:"[^"]+"|'[^']+'|(?!\.{1,2}$)[^\s"'-][^\s]*)$/;

  return async (input): Promise<SyncHookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
      return {};
    }

    const toolInput = input.tool_input as { command?: unknown } | undefined;
    const command = typeof toolInput?.command === 'string' ? toolInput.command.trim() : '';

    const allowed =
      allowedExact.some((pattern) => pattern.test(command)) ||
      diffCheck.test(command) ||
      singlePathAdd.test(command);

    if (allowed) {
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Denied: finish-merge may only check merge/conflict state, add one exact unmerged path at a time, and commit with --no-edit (got: ${command}).`,
      },
    };
  };
}

/**
 * Runs the `finish-merge` subagent action: completes a previously-conflicted
 * merge via a `query()` session whose only tool is `Bash`, with the shared
 * `no-force-push` hook plus a scoped intended-commands hook wired into that
 * same session (AD-3/AD-4). Re-checks for unmerged paths and leftover
 * conflict markers before ever staging or committing anything.
 *
 * `deps.queryFn` is an injection point for tests; production code always
 * gets the real SDK `query`.
 */
export async function finishMerge(
  _input: FinishMergeInput,
  deps: { queryFn?: QueryFn } = {},
): Promise<FinishMergeResult> {
  const runQuery = deps.queryFn ?? query;

  try {
    let outcome: Outcome = 'error';
    let tail = '';

    const stream = runQuery({
      prompt: buildPrompt(),
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
            { matcher: 'Bash', hooks: [finishMergeOnlyIntendedCommandsHook()] },
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
              `git-agent finish-merge: model's final reply did not contain a recognized RESULT line. Full reply:\n${message.result}\n`,
            );
          }
        } else {
          outcome = 'error';
          process.stderr.write(
            `git-agent finish-merge: session ended with subtype "${message.subtype}" (is_error=${message.is_error}, stop_reason=${String(message.stop_reason)}). errors: ${JSON.stringify(message.errors)}\n`,
          );
        }
      }
    }

    if (outcome === 'completed') return { ok: true };
    if (outcome === 'conflict') return { ok: false, reason: 'conflict', files: parseConflictFiles(tail) };
    // "no-merge-in-progress" is caller misuse, not a modeled outcome of its
    // own — folded into the generic unexpected-error reason (per the plan).
    return { ok: false, reason: 'unexpected-error' };
  } catch (error) {
    process.stderr.write(`git-agent finish-merge: unexpected exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return { ok: false, reason: 'unexpected-error' };
  }
}
