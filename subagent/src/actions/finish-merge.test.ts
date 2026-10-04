import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HookCallbackMatcher, Options, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { finishMerge, finishMergeOnlyIntendedCommandsHook, type QueryFn } from './finish-merge.js';

/** Builds a fake `query()` that yields a single success result with `resultText`. */
function fakeQuery(resultText: string, capturedOptions: { value?: Options } = {}): QueryFn {
  return ((params: { prompt: string; options?: Options }) => {
    capturedOptions.value = params.options;
    async function* generator() {
      yield {
        type: 'result',
        subtype: 'success',
        result: resultText,
      };
    }
    return generator();
  }) as unknown as QueryFn;
}

test('maps "completed" to ok:true', async () => {
  const result = await finishMerge({}, { queryFn: fakeQuery('RESULT: completed') });
  assert.deepEqual(result, { ok: true });
});

test('maps "conflict" to ok:false with the remaining files', async () => {
  const result = await finishMerge(
    {},
    { queryFn: fakeQuery('RESULT: conflict\nFILE: src/a.ts\nFILE: src/b.ts') },
  );
  assert.deepEqual(result, { ok: false, reason: 'conflict', files: ['src/a.ts', 'src/b.ts'] });
});

test('maps "conflict" with no FILE lines to an empty files array', async () => {
  const result = await finishMerge({}, { queryFn: fakeQuery('RESULT: conflict') });
  assert.deepEqual(result, { ok: false, reason: 'conflict', files: [] });
});

test('maps "no-merge-in-progress" to ok:false with an unexpected-error reason (caller misuse)', async () => {
  const result = await finishMerge({}, { queryFn: fakeQuery('RESULT: no-merge-in-progress') });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('maps an "error" outcome to ok:false with an unexpected-error reason', async () => {
  const result = await finishMerge({}, { queryFn: fakeQuery('RESULT: error\ncommit failed') });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('treats an unparsable final result as unexpected-error rather than throwing', async () => {
  const result = await finishMerge({}, { queryFn: fakeQuery('all resolved, looks good!') });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('maps a non-success result subtype to ok:false with an unexpected-error reason', async () => {
  const queryFn = (() => {
    async function* generator() {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        stop_reason: 'api_error',
        errors: ['something went wrong talking to the model'],
      };
    }
    return generator();
  }) as unknown as QueryFn;

  const result = await finishMerge({}, { queryFn });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('maps a thrown session error to ok:false with an unexpected-error reason', async () => {
  const throwingQueryFn = (() => {
    throw new Error('subprocess failed to spawn');
  }) as QueryFn;

  const result = await finishMerge({}, { queryFn: throwingQueryFn });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('parses the LAST RESULT line when the model output contains more than one', async () => {
  const result = await finishMerge(
    {},
    { queryFn: fakeQuery('RESULT: conflict\nFILE: src/a.ts\nsome extra reasoning\nRESULT: completed') },
  );
  assert.deepEqual(result, { ok: true });
});

test('restricts the session to the Bash tool, wires the no-force-push PreToolUse hook, and points at the local claude CLI', async () => {
  const captured: { value?: Options } = {};
  await finishMerge({}, { queryFn: fakeQuery('RESULT: completed', captured) });

  assert.deepEqual(captured.value?.tools, ['Bash']);
  const preToolUse = captured.value?.hooks?.PreToolUse as HookCallbackMatcher[] | undefined;
  assert.ok(preToolUse && preToolUse.length > 0, 'expected a PreToolUse hook to be registered');
  assert.equal(captured.value?.pathToClaudeCodeExecutable, 'claude');
});

function bashHookInput(command: string) {
  return {
    hook_event_name: 'PreToolUse' as const,
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'tool-1',
    session_id: 'session-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/repo',
  };
}

function decisionOf(output: unknown): string | undefined {
  const typed = output as SyncHookJSONOutput;
  return typed.hookSpecificOutput && 'permissionDecision' in typed.hookSpecificOutput
    ? typed.hookSpecificOutput.permissionDecision
    : undefined;
}

test('finishMergeOnlyIntendedCommandsHook allows the fixed checks, single-path add, diff --check, and --no-edit commit', async () => {
  const hook = finishMergeOnlyIntendedCommandsHook();
  const signal = new AbortController().signal;

  for (const command of [
    'git rev-parse -q --verify MERGE_HEAD',
    'git status --porcelain=v1',
    'git diff --check',
    'git diff --check -- src/a.ts',
    'git add src/a.ts',
    'git add "src/a file.ts"',
    "git add 'src/b.ts'",
    'git commit --no-edit',
  ]) {
    const allowed = await hook(bashHookInput(command), 'tool-1', { signal });
    assert.equal(decisionOf(allowed), 'allow', `expected "${command}" to be allowed`);
  }
});

test('finishMergeOnlyIntendedCommandsHook denies broad-staging, abort, rebase, force, and custom-message commands', async () => {
  const hook = finishMergeOnlyIntendedCommandsHook();
  const signal = new AbortController().signal;

  for (const command of [
    'git add -A',
    'git add -u',
    'git add .',
    'git add src/a.ts src/b.ts',
    'git merge --abort',
    'git rebase main',
    'git reset --hard',
    'git push --force origin main',
    'git commit -m "custom message"',
    'git commit --amend',
    'rm -rf .git',
  ]) {
    const denied = await hook(bashHookInput(command), 'tool-1', { signal });
    assert.equal(decisionOf(denied), 'deny', `expected "${command}" to be denied`);
  }
});
