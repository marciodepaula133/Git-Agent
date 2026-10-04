import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HookCallbackMatcher, Options, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { draftPr, draftPrReadOnlyHook, type QueryFn } from './draft-pr.js';

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

const DRAFT_JSON = '{"title": "feature: digest delivery (#42)", "body": "## Summary\\n- do thing\\n\\n## Test plan\\n- [ ] Verify subagent/src changes"}';

test('maps an "ok" outcome to ok:true with the parsed title/body/targetBranch', async () => {
  const result = await draftPr(
    { targetBranch: 'main' },
    { queryFn: fakeQuery(`RESULT: ok\n${DRAFT_JSON}`) },
  );
  assert.deepEqual(result, {
    ok: true,
    title: 'feature: digest delivery (#42)',
    body: '## Summary\n- do thing\n\n## Test plan\n- [ ] Verify subagent/src changes',
    targetBranch: 'main',
  });
});

test('maps an "invalid-target" outcome to ok:false with an invalid-target reason', async () => {
  const result = await draftPr(
    { targetBranch: 'ghost-branch' },
    { queryFn: fakeQuery('RESULT: invalid-target') },
  );
  assert.deepEqual(result, { ok: false, reason: 'invalid-target' });
});

test('maps a "no-changes" outcome to ok:false with a no-changes reason', async () => {
  const result = await draftPr(
    { targetBranch: 'main' },
    { queryFn: fakeQuery('RESULT: no-changes') },
  );
  assert.deepEqual(result, { ok: false, reason: 'no-changes' });
});

test('maps an "error" outcome to ok:false with an unexpected-error reason', async () => {
  const result = await draftPr(
    { targetBranch: 'main' },
    { queryFn: fakeQuery('RESULT: error\nsomething went wrong') },
  );
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('treats an unparsable final result as unexpected-error rather than throwing', async () => {
  const result = await draftPr(
    { targetBranch: 'main' },
    { queryFn: fakeQuery('all done, looks good!') },
  );
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('treats a RESULT: ok with unparsable JSON as unexpected-error', async () => {
  const result = await draftPr(
    { targetBranch: 'main' },
    { queryFn: fakeQuery('RESULT: ok\nnot json') },
  );
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

  const result = await draftPr({ targetBranch: 'main' }, { queryFn });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('maps a thrown session error to ok:false with an unexpected-error reason', async () => {
  const throwingQueryFn = (() => {
    throw new Error('subprocess failed to spawn');
  }) as QueryFn;

  const result = await draftPr({ targetBranch: 'main' }, { queryFn: throwingQueryFn });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('restricts the session to the Bash tool, wires the no-force-push PreToolUse hook, and points at the local claude CLI', async () => {
  const captured: { value?: Options } = {};
  await draftPr({ targetBranch: 'main' }, { queryFn: fakeQuery(`RESULT: ok\n${DRAFT_JSON}`, captured) });

  assert.deepEqual(captured.value?.tools, ['Bash']);
  const preToolUse = captured.value?.hooks?.PreToolUse as HookCallbackMatcher[] | undefined;
  assert.ok(preToolUse && preToolUse.length > 0, 'expected a PreToolUse hook to be registered');
  assert.equal(captured.value?.pathToClaudeCodeExecutable, 'claude');
});

test('rejects malformed input shapes without throwing or invoking the session', async () => {
  const queryFn = (() => {
    throw new Error('query() should never be called for malformed input');
  }) as QueryFn;

  for (const bad of [null, 42, [], {}, { targetBranch: '' }] as unknown[]) {
    const result = await draftPr(bad as never, { queryFn });
    assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
  }
});

test('parses the LAST RESULT line when the model output contains more than one', async () => {
  const result = await draftPr(
    { targetBranch: 'main' },
    { queryFn: fakeQuery(`RESULT: invalid-target\nsome extra reasoning\nRESULT: ok\n${DRAFT_JSON}`) },
  );
  assert.deepEqual(result, {
    ok: true,
    title: 'feature: digest delivery (#42)',
    body: '## Summary\n- do thing\n\n## Test plan\n- [ ] Verify subagent/src changes',
    targetBranch: 'main',
  });
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

test('draftPrReadOnlyHook allows only the fixed read-only commands draft-pr actually runs', async () => {
  const hook = draftPrReadOnlyHook('main');
  const signal = new AbortController().signal;

  for (const allowed of [
    'git show-ref --verify --quiet refs/heads/main',
    'git ls-remote --exit-code --heads origin main',
    'git log main..HEAD --format=%s',
    'git branch --show-current',
    'git diff main...HEAD --name-only',
  ]) {
    const result = await hook(bashHookInput(allowed), 'tool-1', { signal });
    assert.equal(decisionOf(result), 'allow', `expected "${allowed}" to be allowed`);
  }

  for (const denied of [
    'git add .',
    'git commit -m "oops"',
    'gh pr create --base main --title x --body y',
    'git push origin main',
    'git log other-branch..HEAD --format=%s',
    'rm -rf .git',
  ]) {
    const result = await hook(bashHookInput(denied), 'tool-1', { signal });
    assert.equal(decisionOf(result), 'deny', `expected "${denied}" to be denied`);
  }
});
