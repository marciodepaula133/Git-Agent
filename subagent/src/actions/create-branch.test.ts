import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HookCallbackMatcher, Options, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { createBranch, createOnlyIntendedCommandsHook, type QueryFn } from './create-branch.js';

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

test('maps a "created" outcome to ok:true with the branch name', async () => {
  const result = await createBranch(
    { branchName: 'feature/42-digest-delivery' },
    { queryFn: fakeQuery('RESULT: created') },
  );
  assert.deepEqual(result, { ok: true, branchName: 'feature/42-digest-delivery' });
});

test('maps a "branch-exists" outcome to ok:false with a branch-exists reason', async () => {
  const result = await createBranch(
    { branchName: 'fix/typo' },
    { queryFn: fakeQuery('RESULT: branch-exists') },
  );
  assert.deepEqual(result, { ok: false, reason: 'branch-exists' });
});

test('maps an "error" outcome to ok:false with an unexpected-error reason', async () => {
  const result = await createBranch(
    { branchName: 'fix/typo' },
    { queryFn: fakeQuery('RESULT: error\nsomething went wrong') },
  );
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('treats an unparsable final result as unexpected-error rather than throwing', async () => {
  const result = await createBranch(
    { branchName: 'fix/typo' },
    { queryFn: fakeQuery('the branch was made, all good!') },
  );
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('maps a thrown session error to ok:false with an unexpected-error reason', async () => {
  const throwingQueryFn = (() => {
    throw new Error('subprocess failed to spawn');
  }) as QueryFn;

  const result = await createBranch({ branchName: 'fix/typo' }, { queryFn: throwingQueryFn });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('restricts the session to the Bash tool and wires the no-force-push PreToolUse hook', async () => {
  const captured: { value?: Options } = {};
  await createBranch({ branchName: 'feature/1-x' }, { queryFn: fakeQuery('RESULT: created', captured) });

  assert.deepEqual(captured.value?.tools, ['Bash']);
  const preToolUse = captured.value?.hooks?.PreToolUse as HookCallbackMatcher[] | undefined;
  assert.ok(preToolUse && preToolUse.length > 0, 'expected a PreToolUse hook to be registered');
});

test('rejects malformed input shapes without throwing or invoking the session', async () => {
  const queryFn = (() => {
    throw new Error('query() should never be called for malformed input');
  }) as QueryFn;

  for (const bad of [null, 42, [], {}] as unknown[]) {
    const result = await createBranch(bad as never, { queryFn });
    assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
  }
});

test('parses the LAST RESULT line when the model output contains more than one', async () => {
  const result = await createBranch(
    { branchName: 'fix/typo' },
    { queryFn: fakeQuery('RESULT: branch-exists\nsome extra reasoning\nRESULT: created') },
  );
  assert.deepEqual(result, { ok: true, branchName: 'fix/typo' });
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

test('createOnlyIntendedCommandsHook allows only the two commands create-branch actually runs', async () => {
  const hook = createOnlyIntendedCommandsHook('feature/1-x');
  const signal = new AbortController().signal;

  const showRef = await hook(
    bashHookInput('git show-ref --verify --quiet refs/heads/feature/1-x'),
    'tool-1',
    { signal },
  );
  assert.equal(decisionOf(showRef), 'allow');

  const checkout = await hook(bashHookInput('git checkout -b feature/1-x'), 'tool-1', { signal });
  assert.equal(decisionOf(checkout), 'allow');

  for (const command of [
    'git add .',
    'git commit -m "oops"',
    'git stash',
    'git reset --hard',
    'git checkout -b some-other-branch',
    'rm -rf .git',
  ]) {
    const denied = await hook(bashHookInput(command), 'tool-1', { signal });
    assert.equal(decisionOf(denied), 'deny', `expected "${command}" to be denied`);
  }
});
