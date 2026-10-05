import { query, type HookCallback, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { noForcePushHookMatcher, splitIntoSegments } from '../hooks/no-force-push.js';

export type Hunk = {
  file: string;
  startLine: number;
  endLine: number;
};

export type PlannedCommit = {
  id: number;
  message: string;
  hunks: Hunk[];
};

export type LocalOnlyCandidate = {
  file: string;
};

export type PlanCommitResult =
  | { ok: true; commits: PlannedCommit[]; localOnlyCandidates: LocalOnlyCandidate[] }
  | { ok: false; reason: 'no-changes' | 'unexpected-error' };

/** Injectable to keep this action unit-testable without a live SDK session. */
export type QueryFn = typeof query;

/**
 * Fixed, extensible filename-pattern heuristic for "this file is probably a
 * local secret, not something that should ever be committed" — the only
 * place local-only detection happens (docs/architecture.md rule 9). Glob-style,
 * matched against a file's basename or its full repo-relative path.
 */
export const LOCAL_ONLY_PATTERNS = ['.env', '.env.*', '*.pem', '*.key', 'credentials*', 'secrets*', '*.local'];

type Outcome = 'ok' | 'no-changes' | 'error';

const RESULT_LINE = /^RESULT:\s*(ok|no-changes|error)\s*$/im;

function buildPrompt(): string {
  return [
    'You are planning a split, reviewable commit history for the CURRENT working tree of the git',
    'repository in the current directory. This is a read-only planning pass: you must not stage,',
    'commit, stash, reset, or otherwise modify the working tree, the index, or history.',
    '',
    'Follow these steps, in order:',
    '1. Run: git status --porcelain=v1',
    '   to see every tracked and untracked change.',
    '2. If that shows no changes at all (a clean working tree), reply with exactly one line:',
    '   "RESULT: no-changes" and stop. Do not run any other command.',
    '3. For every tracked, modified file, run `git diff -- <file>` (and `git diff --cached -- <file>`',
    '   if it also has staged changes) to see its exact hunks and line numbers.',
    '4. Classify every untracked or modified file against this fixed list of local-only filename',
    `   patterns (glob-style, matched against the file's basename or full relative path): ${LOCAL_ONLY_PATTERNS.join(', ')}.`,
    '   Any file matching one of these patterns is a "local-only candidate": it must never appear in',
    '   any proposed commit\'s hunks — leave it out of every commit entirely, and list it only under',
    '   localOnlyCandidates.',
    '5. Group the remaining changes into one or more topic-coherent commits. Split unrelated changes',
    '   into separate commits, including splitting a single file\'s hunks by line range across',
    '   different commits when that one file holds two unrelated topics.',
    '6. Work out the commit message format: run `git config --get commit.template`. If it prints a',
    '   path, read that file with the Read tool and shape every commit message to follow its',
    '   structure. If the command prints nothing (no template configured), run',
    '   `git branch --show-current` and use the default format "<type>: <summary>" when the current',
    '   branch name has a `<type>/...` shape; otherwise use a plain one-line summary.',
    '7. Reply with exactly one line "RESULT: ok" followed immediately, on the next lines, by exactly',
    '   one JSON object and nothing else (no markdown fences, no trailing commentary), of this exact',
    '   shape:',
    '   {"commits": [{"id": 0, "message": "...", "hunks": [{"file": "...", "startLine": 1, "endLine": 10}]}], "localOnlyCandidates": [{"file": "..."}]}',
    '   - "id" is a zero-based integer, unique per commit, in the order the commits should be made.',
    '   - "startLine"/"endLine" are 1-based, inclusive line numbers in the file\'s new (working-tree)',
    '     version, describing exactly the span of this commit\'s hunk.',
    '   - Every changed, non-local-only file must be fully covered by the hunks across the commits it',
    '     appears in.',
    '   - localOnlyCandidates lists every file matched in step 4, and nothing else.',
    '8. If anything prevents you from producing a valid plan (an unexpected git error, an unreadable',
    '   file, etc.), reply with exactly one line "RESULT: error" followed by the error text on the',
    '   next line, and stop.',
    '',
    'Never run git add, git commit, git push, git reset, git stash, git rebase, git checkout, git',
    'apply, git clean, or any other command that mutates the working tree, the index, or history.',
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

function isHunk(value: unknown): value is Hunk {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.file === 'string' && typeof v.startLine === 'number' && typeof v.endLine === 'number';
}

function isPlannedCommit(value: unknown): value is PlannedCommit {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'number' &&
    typeof v.message === 'string' &&
    Array.isArray(v.hunks) &&
    v.hunks.every(isHunk)
  );
}

function isLocalOnlyCandidate(value: unknown): value is LocalOnlyCandidate {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>).file === 'string';
}

function parsePlanJson(jsonText: string): { commits: PlannedCommit[]; localOnlyCandidates: LocalOnlyCandidate[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (!Array.isArray(v.commits) || !v.commits.every(isPlannedCommit)) return null;
  if (!Array.isArray(v.localOnlyCandidates) || !v.localOnlyCandidates.every(isLocalOnlyCandidate)) return null;
  return { commits: v.commits, localOnlyCandidates: v.localOnlyCandidates };
}

/**
 * Restricts the planning session's Bash tool to a fixed set of read-only git
 * inspection commands. Planning never needs to stage, commit, or otherwise
 * mutate anything, so everything else is denied here rather than relying
 * solely on the prompt's natural-language instructions (mirrors
 * create-branch.ts's createOnlyIntendedCommandsHook).
 */
export function planCommitReadOnlyHook(): HookCallback {
  const allowedPatterns = [
    /^git status(\s+--porcelain(=v1)?)?$/,
    /^git diff(\s+--cached)?\s+--\s+\S+$/,
    /^git config --get commit\.template$/,
    /^git branch --show-current$/,
  ];

  return async (input): Promise<SyncHookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
      return {};
    }

    const toolInput = input.tool_input as { command?: unknown } | undefined;
    const command = typeof toolInput?.command === 'string' ? toolInput.command.trim() : '';

    // Segment on &&/||/;/| first (as no-force-push.ts does) so a chained
    // command like "git diff -- file.txt && rm -rf /" can't ride through on
    // the allowlisted first segment alone — every segment must independently
    // match one of the allowed, fully end-anchored command shapes.
    const segments = splitIntoSegments(command);
    const allAllowed =
      segments.length > 0 &&
      segments.every((tokens) => allowedPatterns.some((pattern) => pattern.test(tokens.join(' '))));

    if (allAllowed) {
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Denied: plan-commit is a read-only planning pass and may only run git status/diff/config/branch inspection commands (got: ${command}).`,
      },
    };
  };
}

/**
 * Runs the `plan-commit` subagent action: inspects the current working tree
 * via a `query()` session (tools: Bash, Read; `no-force-push` hook wired in,
 * plus a read-only command allowlist) and returns a structured commit split
 * plan. Always `ok:true` unless the tree is clean (`no-changes`) or the
 * session itself failed (`unexpected-error`) — per docs/architecture.md rule 9,
 * `localOnlyCandidates` is never a stop condition.
 *
 * `deps.queryFn` is an injection point for tests; production code always gets
 * the real SDK `query`.
 */
export async function planCommit(deps: { queryFn?: QueryFn } = {}): Promise<PlanCommitResult> {
  const runQuery = deps.queryFn ?? query;

  try {
    let outcome: Outcome = 'error';
    let resultText = '';

    const stream = runQuery({
      prompt: buildPrompt(),
      options: {
        tools: ['Bash', 'Read'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // See create-branch.ts for why this must point at the locally
        // installed `claude` CLI rather than the SDK's bundled native binary.
        pathToClaudeCodeExecutable: 'claude',
        hooks: {
          PreToolUse: [
            noForcePushHookMatcher,
            { matcher: 'Bash', hooks: [planCommitReadOnlyHook()] },
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
              `git-agent plan-commit: model's final reply did not contain a recognized RESULT line. Full reply:\n${resultText}\n`,
            );
          }
        } else {
          outcome = 'error';
          process.stderr.write(
            `git-agent plan-commit: session ended with subtype "${message.subtype}" (is_error=${message.is_error}, stop_reason=${String(message.stop_reason)}). errors: ${JSON.stringify(message.errors)}\n`,
          );
        }
      }
    }

    if (outcome === 'no-changes') return { ok: false, reason: 'no-changes' };
    if (outcome === 'ok') {
      const plan = parsePlanJson(textAfterResultLine(resultText));
      if (!plan) {
        process.stderr.write(`git-agent plan-commit: could not parse plan JSON from model reply:\n${resultText}\n`);
        return { ok: false, reason: 'unexpected-error' };
      }
      return { ok: true, commits: plan.commits, localOnlyCandidates: plan.localOnlyCandidates };
    }
    return { ok: false, reason: 'unexpected-error' };
  } catch (error) {
    process.stderr.write(
      `git-agent plan-commit: unexpected exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return { ok: false, reason: 'unexpected-error' };
  }
}
