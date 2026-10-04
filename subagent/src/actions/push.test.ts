import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HookCallbackMatcher, Options, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { push, createOnlyIntendedCommandsHook, type QueryFn } from './push.js';

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

test('maps a "pushed" outcome to ok:true with the branch name', async () => {
  const result = await push(
    { branchName: 'feature/42-digest-delivery' },
    { queryFn: fakeQuery('RESULT: pushed') },
  );
  assert.deepEqual(result, { ok: true, branchName: 'feature/42-digest-delivery' });
});

test('maps a "non-fast-forward" outcome to ok:false with a non-fast-forward reason', async () => {
  const result = await push(
    { branchName: 'fix/typo' },
    { queryFn: fakeQuery('RESULT: non-fast-forward') },
  );
  assert.deepEqual(result, { ok: false, reason: 'non-fast-forward' });
});

test('maps an "error" outcome to ok:false with an unexpected-error reason', async () => {
  const result = await push(
    { branchName: 'fix/typo' },
    { queryFn: fakeQuery('RESULT: error\nsomething went wrong') },
  );
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('treats an unparsable final result as unexpected-error rather than throwing', async () => {
  const result = await push(
    { branchName: 'fix/typo' },
    { queryFn: fakeQuery('the push went through, all good!') },
  );
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('maps a non-success result subtype (e.g. error_during_execution) to ok:false with an unexpected-error reason', async () => {
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

  const result = await push({ branchName: 'fix/typo' }, { queryFn });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('maps a thrown session error to ok:false with an unexpected-error reason', async () => {
  const throwingQueryFn = (() => {
    throw new Error('subprocess failed to spawn');
  }) as QueryFn;

  const result = await push({ branchName: 'fix/typo' }, { queryFn: throwingQueryFn });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('restricts the session to the Bash tool, wires the no-force-push PreToolUse hook, and points at the local claude CLI', async () => {
  const captured: { value?: Options } = {};
  await push({ branchName: 'feature/1-x' }, { queryFn: fakeQuery('RESULT: pushed', captured) });

  assert.deepEqual(captured.value?.tools, ['Bash']);
  const preToolUse = captured.value?.hooks?.PreToolUse as HookCallbackMatcher[] | undefined;
  assert.ok(preToolUse && preToolUse.length > 0, 'expected a PreToolUse hook to be registered');
  // Must use the user's own locally installed claude CLI, not the SDK's
  // bundled native binary - that binary isn't reachable once this file is
  // bundled standalone into another repo's skill folder.
  assert.equal(captured.value?.pathToClaudeCodeExecutable, 'claude');
});

test('rejects malformed input shapes without throwing or invoking the session', async () => {
  const queryFn = (() => {
    throw new Error('query() should never be called for malformed input');
  }) as QueryFn;

  for (const bad of [null, 42, [], {}] as unknown[]) {
    const result = await push(bad as never, { queryFn });
    assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
  }
});

test('maps a "wrong-branch" outcome to ok:false with an unexpected-error reason', async () => {
  const result = await push(
    { branchName: 'feature/42-digest-delivery' },
    { queryFn: fakeQuery('RESULT: wrong-branch') },
  );
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('parses the LAST RESULT line when the model output contains more than one', async () => {
  const result = await push(
    { branchName: 'fix/typo' },
    { queryFn: fakeQuery('RESULT: non-fast-forward\nsome extra reasoning\nRESULT: pushed') },
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

test('createOnlyIntendedCommandsHook allows only the upstream check and the two push forms push actually runs', async () => {
  const hook = createOnlyIntendedCommandsHook('feature/1-x');
  const signal = new AbortController().signal;

  const branchCheck = await hook(bashHookInput('git rev-parse --abbrev-ref HEAD'), 'tool-1', {
    signal,
  });
  assert.equal(decisionOf(branchCheck), 'allow');

  const upstreamCheck = await hook(
    bashHookInput('git rev-parse --abbrev-ref --symbolic-full-name feature/1-x@{upstream}'),
    'tool-1',
    { signal },
  );
  assert.equal(decisionOf(upstreamCheck), 'allow');

  const plainPush = await hook(bashHookInput('git push'), 'tool-1', { signal });
  assert.equal(decisionOf(plainPush), 'allow');

  const setUpstreamPush = await hook(bashHookInput('git push -u origin feature/1-x'), 'tool-1', {
    signal,
  });
  assert.equal(decisionOf(setUpstreamPush), 'allow');

  for (const command of [
    'git push --force',
    'git push -f',
    'git push --force-with-lease',
    'git push -uf',
    'git push -u origin some-other-branch',
    'git add .',
    'git commit -m "oops"',
    'git rebase main',
    'git stash',
    'git reset --hard',
    'rm -rf .git',
  ]) {
    const denied = await hook(bashHookInput(command), 'tool-1', { signal });
    assert.equal(decisionOf(denied), 'deny', `expected "${command}" to be denied`);
  }
});

test('the shared no-force-push hook independently denies a force push even if the allow-list hook were bypassed', async () => {
  // Defense in depth: the allow-list hook above already denies every force
  // variant, but docs/skills/push.md requires the shared hook to be wired in
  // as well, not relied on as the only guard. Import it directly to confirm
  // it's exercised against push-shaped commands independently of push.ts's
  // own allow-list.
  const { noForcePushHookMatcher } = await import('../hooks/no-force-push.js');
  const hook = noForcePushHookMatcher.hooks[0];
  const signal = new AbortController().signal;

  const denied = await hook(bashHookInput('git push --force'), 'tool-1', { signal });
  assert.equal(decisionOf(denied), 'deny');

  const allowed = await hook(bashHookInput('git push'), 'tool-1', { signal });
  assert.equal(decisionOf(allowed), 'allow');
});
