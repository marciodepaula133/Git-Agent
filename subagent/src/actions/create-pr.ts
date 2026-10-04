import { query, type HookCallback, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { noForcePushHookMatcher } from '../hooks/no-force-push.js';

export type CreatePrInput = {
  title: string;
  body: string;
  targetBranch: string;
};

export type CreatePrResult =
  | { ok: true; url: string; number: number }
  | { ok: false; reason: 'branch-exists' | 'unexpected-error' };

/** Injectable to keep this action unit-testable without a live SDK session. */
export type QueryFn = typeof query;

type Outcome = 'ok' | 'branch-exists' | 'error';

const RESULT_LINE = /^RESULT:\s*(ok|branch-exists|error)\s*$/im;

/**
 * Builds the exact, single Bash command this action is allowed to run — the
 * title/body/target branch travel in only ever through this one `gh pr
 * create --body-file -` heredoc invocation (mirrors execute-commit.ts's
 * inline-heredoc `git apply --cached` pattern: the body is always delivered
 * inline, never piped in from a separate command).
 */
function buildGhPrCreateCommand(input: CreatePrInput): string {
  return [`gh pr create --base "${input.targetBranch}" --title "${input.title}" --body-file - <<'EOF'`, input.body, 'EOF'].join('\n');
}

function buildPrompt(input: CreatePrInput): string {
  const command = buildGhPrCreateCommand(input);
  return [
    'You are opening a pull request for the current branch of the git repository in the current',
    'directory. The title, body, and target branch below were already composed and approved by the',
    'user in an earlier step — do not re-derive, edit, or second-guess them.',
    '',
    'Run EXACTLY this single Bash command, verbatim, and nothing else:',
    '```',
    command,
    '```',
    '',
    'If that command succeeds, its stdout contains the created pull request\'s URL (gh prints this on',
    'success), typically ending in "/pull/<number>". Reply with exactly one line "RESULT: ok" followed',
    'immediately, on the next lines, by exactly one JSON object and nothing else (no markdown fences,',
    'no trailing commentary), of this exact shape:',
    '{"url": "<the exact URL gh printed>", "number": <the integer after the final "/pull/" in that URL>}',
    '',
    'If the command fails because a pull request already exists for this branch (gh\'s error output',
    'says something to the effect of a pull request for this branch already existing, usually with the',
    'existing PR\'s own URL), reply with exactly one line "RESULT: branch-exists" and stop.',
    '',
    'If the command fails for any other reason, reply with exactly one line "RESULT: error" followed',
    'by the error text on the next line, and stop.',
    '',
    'Never run git push, git commit, git add, git reset, git rebase, git stash, or any command with a',
    'force flag. Never run any command other than the single `gh pr create` command above.',
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

function parseCreatedPr(jsonText: string): { url: string; number: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v.url !== 'string' || typeof v.number !== 'number') return null;
  return { url: v.url, number: v.number };
}

function isValidInput(input: unknown): input is CreatePrInput {
  if (typeof input !== 'object' || input === null) return false;
  const v = input as Record<string, unknown>;
  return (
    typeof v.title === 'string' &&
    v.title.length > 0 &&
    typeof v.body === 'string' &&
    typeof v.targetBranch === 'string' &&
    v.targetBranch.length > 0
  );
}

/**
 * Restricts the create session's Bash tool to exactly the one `gh pr create`
 * command this action is meant to run, built from the exact
 * title/body/targetBranch given to it — never a value the model re-derived
 * (mirrors create-branch.ts's createOnlyIntendedCommandsHook). Compared by
 * exact string match rather than a regex: the title/body are arbitrary,
 * user-approved text that would otherwise need careful escaping to turn into
 * a safe pattern, and an exact match is both simpler and strictly tighter.
 */
export function createPrOnlyIntendedCommandHook(input: CreatePrInput): HookCallback {
  const expectedCommand = buildGhPrCreateCommand(input);

  return async (hookInput): Promise<SyncHookJSONOutput> => {
    if (hookInput.hook_event_name !== 'PreToolUse' || hookInput.tool_name !== 'Bash') {
      return {};
    }

    const toolInput = hookInput.tool_input as { command?: unknown } | undefined;
    const command = typeof toolInput?.command === 'string' ? toolInput.command.trim() : '';

    if (command === expectedCommand.trim()) {
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Denied: create-pr may only run the single approved "gh pr create" command built from its exact input.',
      },
    };
  };
}

/**
 * Runs the `create-pr` subagent action: opens a pull request for the current
 * branch using exactly the user-approved `title`/`body`/`targetBranch` via a
 * `query()` session (tools: Bash; `no-force-push` hook wired in, plus a
 * dedicated single-command allowlist hook). This is the mutating half of the
 * `draft-pr`/`create-pr` pair (docs/architecture.md rule 1) — it never
 * re-derives anything from the branch itself.
 *
 * `deps.queryFn` is an injection point for tests; production code always
 * gets the real SDK `query`.
 */
export async function createPr(
  input: unknown,
  deps: { queryFn?: QueryFn } = {},
): Promise<CreatePrResult> {
  const runQuery = deps.queryFn ?? query;

  try {
    if (!isValidInput(input)) {
      return { ok: false, reason: 'unexpected-error' };
    }

    let outcome: Outcome = 'error';
    let resultText = '';

    const stream = runQuery({
      prompt: buildPrompt(input),
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
            { matcher: 'Bash', hooks: [createPrOnlyIntendedCommandHook(input)] },
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
              `git-agent create-pr: model's final reply did not contain a recognized RESULT line. Full reply:\n${resultText}\n`,
            );
          }
        } else {
          outcome = 'error';
          process.stderr.write(
            `git-agent create-pr: session ended with subtype "${message.subtype}" (is_error=${message.is_error}, stop_reason=${String(message.stop_reason)}). errors: ${JSON.stringify(message.errors)}\n`,
          );
        }
      }
    }

    if (outcome === 'branch-exists') return { ok: false, reason: 'branch-exists' };
    if (outcome === 'ok') {
      const created = parseCreatedPr(textAfterResultLine(resultText));
      if (!created) {
        process.stderr.write(`git-agent create-pr: could not parse created-PR JSON from model reply:\n${resultText}\n`);
        return { ok: false, reason: 'unexpected-error' };
      }
      return { ok: true, url: created.url, number: created.number };
    }
    return { ok: false, reason: 'unexpected-error' };
  } catch (error) {
    process.stderr.write(
      `git-agent create-pr: unexpected exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return { ok: false, reason: 'unexpected-error' };
  }
}
