import { query, type HookCallback, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { noForcePushHookMatcher } from '../hooks/no-force-push.js';

export type DraftPrInput = {
  targetBranch: string;
};

export type DraftPrResult =
  | { ok: true; title: string; body: string; targetBranch: string }
  | { ok: false; reason: 'invalid-target' | 'no-changes' | 'unexpected-error' };

/** Injectable to keep this action unit-testable without a live SDK session. */
export type QueryFn = typeof query;

type Outcome = 'ok' | 'invalid-target' | 'no-changes' | 'error';

const RESULT_LINE = /^RESULT:\s*(ok|invalid-target|no-changes|error)\s*$/im;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPrompt(targetBranch: string): string {
  return [
    `You are drafting a pull request for the current branch of the git repository in the current`,
    `directory, targeting "${targetBranch}". This is a read-only pass: you must not stage, commit,`,
    'push, create a PR, or otherwise modify the working tree, the index, history, or anything remote.',
    '',
    'Follow these steps, in order:',
    `1. Run: git show-ref --verify --quiet refs/heads/${targetBranch}`,
    '   to check whether the target branch exists locally.',
    '2. If step 1 exited non-zero (the branch does not exist locally), also run:',
    `   git ls-remote --exit-code --heads origin ${targetBranch}`,
    '   to check whether it exists on origin.',
    '3. If the target branch exists in neither place, reply with exactly one line:',
    '   "RESULT: invalid-target" and stop. Do not run any other command.',
    `4. Run: git log ${targetBranch}..HEAD --format=%s`,
    '   to list the subject line of every commit the current branch is ahead of the target by.',
    '5. If that list is empty (the current branch has no commits ahead of the target), reply with',
    '   exactly one line: "RESULT: no-changes" and stop. Do not run any other command.',
    '6. Run: git branch --show-current',
    '   to get the current branch name. Parse it by splitting on the FIRST "/" into `type` and',
    '   `rest`. If `rest` matches the pattern `^(\\d+)-(.+)$`, the first group is `task` and the',
    '   second is `description`; otherwise `description` is all of `rest` and there is no `task`.',
    '7. Build `title` as `"${type}: ${description with every "-" replaced by a single space}"`, then',
    '   append `" (#${task})"` at the end when a `task` was found in step 6. For example, branch',
    '   "feature/42-digest-delivery" against any target yields title',
    '   "feature: digest delivery (#42)"; branch "fix/typo-cleanup" yields title "fix: typo cleanup"',
    '   (no "(#...)" suffix, since there is no task number).',
    `8. Run: git diff ${targetBranch}...HEAD --name-only`,
    '   to list every changed file path relative to the target. Group these paths by "concern": the',
    '   first two `/`-separated path segments (e.g. `subagent/src/actions/draft-pr.ts` and',
    '   `subagent/src/actions/create-pr.ts` are both the same concern, `subagent/src`; a file with',
    '   only one path segment is its own concern by that one segment alone). Keep the concerns in the',
    '   order their files first appear in the `git diff` output.',
    '9. Build `body` as exactly two Markdown sections, in this order, with one blank line between',
    '   them and nothing before or after:',
    '   - `## Summary` followed by one `- ` bullet per commit subject line from step 4, in the order',
    '     `git log` printed them (newest commit last, i.e. the same order the command printed).',
    '   - `## Test plan` followed by one `- [ ] ` checklist item per distinct concern from step 8,',
    '     each naming that concern in a short human sentence (e.g. "- [ ] Verify subagent/src/actions',
    '     changes" or "- [ ] Verify skills/git-agent-create-pr changes"). If there is only one',
    '     concern, that section still has exactly one checklist item.',
    '10. Reply with exactly one line "RESULT: ok" followed immediately, on the next lines, by exactly',
    '    one JSON object and nothing else (no markdown fences, no trailing commentary), of this exact',
    '    shape:',
    '    {"title": "...", "body": "..."}',
    '    where "body" is the full Markdown string built in step 9, with real newline characters',
    '    encoded as JSON string escapes ("\\n").',
    '11. If anything prevents you from completing the steps above (an unexpected git error, etc.),',
    '    reply with exactly one line "RESULT: error" followed by the error text on the next line, and',
    '    stop.',
    '',
    'Never run git push, git commit, git add, git reset, git rebase, git stash, gh pr create, or any',
    'command with a force flag. Never modify, stage, or drop any file, and never contact anything',
    'remote except the read-only `git ls-remote` check in step 2.',
  ].join('\n');
}

function parseOutcomeLine(resultText: string): Outcome {
  let lastMatch: RegExpExecArray | null = null;
  for (const match of resultText.matchAll(new RegExp(RESULT_LINE, 'gim'))) {
    lastMatch = match as RegExpExecArray;
  }
  return lastMatch ? (lastMatch[1] as Outcome) : 'error';
}

/** Text after the last "RESULT: ok" line, expected to be exactly one JSON object. */
function textAfterResultLine(resultText: string): string {
  const lines = resultText.split('\n');
  let lastIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^RESULT:\s*ok\s*$/im.test(lines[i])) lastIndex = i;
  }
  if (lastIndex === -1) return '';
  return lines.slice(lastIndex + 1).join('\n').trim();
}

function parseDraftJson(jsonText: string): { title: string; body: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v.title !== 'string' || typeof v.body !== 'string') return null;
  return { title: v.title, body: v.body };
}

/**
 * Restricts the draft session's Bash tool to the fixed set of read-only
 * inspection commands drafting a PR actually needs. Drafting never needs to
 * push, commit, or call `gh`, so everything else is denied here rather than
 * relying solely on the prompt's natural-language instructions (mirrors
 * create-branch.ts's createOnlyIntendedCommandsHook).
 */
export function draftPrReadOnlyHook(targetBranch: string): HookCallback {
  const escapedTarget = escapeRegExp(targetBranch);
  const allowedPatterns = [
    new RegExp(`^git show-ref --verify --quiet refs/heads/${escapedTarget}$`),
    new RegExp(`^git ls-remote --exit-code --heads origin ${escapedTarget}$`),
    new RegExp(`^git log ${escapedTarget}\\.\\.HEAD --format=%s$`),
    /^git branch --show-current$/,
    new RegExp(`^git diff ${escapedTarget}\\.\\.\\.HEAD --name-only$`),
  ];

  return async (input): Promise<SyncHookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
      return {};
    }

    const toolInput = input.tool_input as { command?: unknown } | undefined;
    const command = typeof toolInput?.command === 'string' ? toolInput.command.trim() : '';

    if (allowedPatterns.some((pattern) => pattern.test(command))) {
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Denied: draft-pr is a read-only drafting pass and may only run the fixed set of git inspection commands it needs (got: ${command}).`,
      },
    };
  };
}

/**
 * Runs the `draft-pr` subagent action: produces a self-contained PR title and
 * body for the current branch against `input.targetBranch` via a read-only
 * `query()` session (tools: Bash; `no-force-push` hook wired in, plus a
 * read-only command allowlist). Never calls `gh` and never mutates anything
 * — the two-call shape (docs/architecture.md rule 1) means the user reviews
 * this draft before `create-pr` ever runs.
 *
 * `deps.queryFn` is an injection point for tests; production code always
 * gets the real SDK `query`.
 */
export async function draftPr(
  input: DraftPrInput,
  deps: { queryFn?: QueryFn } = {},
): Promise<DraftPrResult> {
  const runQuery = deps.queryFn ?? query;

  try {
    const targetBranch = (input as { targetBranch?: unknown } | null | undefined)?.targetBranch;
    if (typeof targetBranch !== 'string' || targetBranch.length === 0) {
      return { ok: false, reason: 'unexpected-error' };
    }

    let outcome: Outcome = 'error';
    let resultText = '';

    const stream = runQuery({
      prompt: buildPrompt(targetBranch),
      options: {
        tools: ['Bash'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // See create-branch.ts for why this must point at the locally
        // installed `claude` CLI rather than the SDK's bundled native binary.
        pathToClaudeCodeExecutable: 'claude',
        hooks: {
          PreToolUse: [
            noForcePushHookMatcher,
            { matcher: 'Bash', hooks: [draftPrReadOnlyHook(targetBranch)] },
          ],
        },
      },
    });

    for await (const message of stream) {
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          resultText = message.result;
          outcome = parseOutcomeLine(resultText);
          if (outcome === 'error') {
            process.stderr.write(
              `git-agent draft-pr: model's final reply did not contain a recognized RESULT line. Full reply:\n${resultText}\n`,
            );
          }
        } else {
          outcome = 'error';
          process.stderr.write(
            `git-agent draft-pr: session ended with subtype "${message.subtype}" (is_error=${message.is_error}, stop_reason=${String(message.stop_reason)}). errors: ${JSON.stringify(message.errors)}\n`,
          );
        }
      }
    }

    if (outcome === 'invalid-target') return { ok: false, reason: 'invalid-target' };
    if (outcome === 'no-changes') return { ok: false, reason: 'no-changes' };
    if (outcome === 'ok') {
      const draft = parseDraftJson(textAfterResultLine(resultText));
      if (!draft) {
        process.stderr.write(`git-agent draft-pr: could not parse draft JSON from model reply:\n${resultText}\n`);
        return { ok: false, reason: 'unexpected-error' };
      }
      return { ok: true, title: draft.title, body: draft.body, targetBranch };
    }
    return { ok: false, reason: 'unexpected-error' };
  } catch (error) {
    process.stderr.write(
      `git-agent draft-pr: unexpected exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return { ok: false, reason: 'unexpected-error' };
  }
}
