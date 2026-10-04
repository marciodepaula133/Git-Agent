import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HookCallbackMatcher, Options, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { merge, mergeOnlyIntendedCommandsHook, type QueryFn } from './merge.js';

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

test('maps "fast-forward" to ok:true with that result', async () => {
  const result = await merge({ from: 'main' }, { queryFn: fakeQuery('RESULT: fast-forward') });
  assert.deepEqual(result, { ok: true, result: 'fast-forward' });
});

test('maps "merged" to ok:true with that result', async () => {
  const result = await merge({ from: 'main' }, { queryFn: fakeQuery('RESULT: merged') });
  assert.deepEqual(result, { ok: true, result: 'merged' });
});

test('maps "up-to-date" to ok:true with that result', async () => {
  const result = await merge({ from: 'main' }, { queryFn: fakeQuery('RESULT: up-to-date') });
  assert.deepEqual(result, { ok: true, result: 'up-to-date' });
});

test('maps "invalid-target" to ok:false with that reason, no files', async () => {
  const result = await merge({ from: 'does-not-exist' }, { queryFn: fakeQuery('RESULT: invalid-target') });
  assert.deepEqual(result, { ok: false, reason: 'invalid-target' });
});

test('maps "conflict" to ok:false with the reported files', async () => {
  const result = await merge(
    { from: 'main' },
    { queryFn: fakeQuery('RESULT: conflict\nFILE: src/a.ts\nFILE: src/b.ts') },
  );
  assert.deepEqual(result, { ok: false, reason: 'conflict', files: ['src/a.ts', 'src/b.ts'] });
});

test('maps "conflict" with no FILE lines to an empty files array', async () => {
  const result = await merge({ from: 'main' }, { queryFn: fakeQuery('RESULT: conflict') });
  assert.deepEqual(result, { ok: false, reason: 'conflict', files: [] });
});

test('maps an "error" outcome to ok:false with an unexpected-error reason', async () => {
  const result = await merge({ from: 'main' }, { queryFn: fakeQuery('RESULT: error\nfetch failed') });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('treats an unparsable final result as unexpected-error rather than throwing', async () => {
  const result = await merge({ from: 'main' }, { queryFn: fakeQuery('all done, looks fine!') });
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

  const result = await merge({ from: 'main' }, { queryFn });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('maps a thrown session error to ok:false with an unexpected-error reason', async () => {
  const throwingQueryFn = (() => {
    throw new Error('subprocess failed to spawn');
  }) as QueryFn;

  const result = await merge({ from: 'main' }, { queryFn: throwingQueryFn });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('rejects malformed input shapes without throwing or invoking the session', async () => {
  const queryFn = (() => {
    throw new Error('query() should never be called for malformed input');
  }) as QueryFn;

  for (const bad of [null, 42, [], {}, { from: '' }, { from: 42 }] as unknown[]) {
    const result = await merge(bad as never, { queryFn });
    assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
  }
});

test('parses the LAST RESULT line when the model output contains more than one', async () => {
  const result = await merge(
    { from: 'main' },
    { queryFn: fakeQuery('RESULT: invalid-target\nsome extra reasoning\nRESULT: fast-forward') },
  );
  assert.deepEqual(result, { ok: true, result: 'fast-forward' });
});

test('restricts the session to the Bash tool, wires the no-force-push PreToolUse hook, and points at the local claude CLI', async () => {
  const captured: { value?: Options } = {};
  await merge({ from: 'main' }, { queryFn: fakeQuery('RESULT: fast-forward', captured) });

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

test('mergeOnlyIntendedCommandsHook allows exactly the fixed sequence for a local "from" (no fetch)', async () => {
  const hook = mergeOnlyIntendedCommandsHook('main');
  const signal = new AbortController().signal;

  for (const command of [
    'git remote',
    'git rev-parse --verify --quiet main^{commit}',
    'git rev-parse HEAD',
    'git merge --no-edit main',
    'git status --porcelain=v1',
    'git log -1 --format=%P HEAD',
  ]) {
    const allowed = await hook(bashHookInput(command), 'tool-1', { signal });
    assert.equal(decisionOf(allowed), 'allow', `expected "${command}" to be allowed`);
  }

  for (const command of [
    'git fetch origin main',
    'git merge --abort',
    'git rebase main',
    'git reset --hard',
    'git push origin main',
    'git merge --no-edit other-branch',
    'rm -rf .git',
  ]) {
    const denied = await hook(bashHookInput(command), 'tool-1', { signal });
    assert.equal(decisionOf(denied), 'deny', `expected "${command}" to be denied`);
  }
});

test('mergeOnlyIntendedCommandsHook allows the derived fetch for a remote-qualified "from"', async () => {
  const hook = mergeOnlyIntendedCommandsHook('origin/main');
  const signal = new AbortController().signal;

  const fetch = await hook(bashHookInput('git fetch origin main'), 'tool-1', { signal });
  assert.equal(decisionOf(fetch), 'allow');

  const mergeCmd = await hook(bashHookInput('git merge --no-edit origin/main'), 'tool-1', { signal });
  assert.equal(decisionOf(mergeCmd), 'allow');

  const wrongFetch = await hook(bashHookInput('git fetch upstream main'), 'tool-1', { signal });
  assert.equal(decisionOf(wrongFetch), 'deny');
});

test('mergeOnlyIntendedCommandsHook denies any force-flagged or rebase variant regardless of "from"', async () => {
  const hook = mergeOnlyIntendedCommandsHook('origin/main');
  const signal = new AbortController().signal;

  for (const command of ['git push --force origin main', 'git rebase origin/main', 'git merge --abort']) {
    const denied = await hook(bashHookInput(command), 'tool-1', { signal });
    assert.equal(decisionOf(denied), 'deny', `expected "${command}" to be denied`);
  }
});
