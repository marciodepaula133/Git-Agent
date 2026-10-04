import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HookCallbackMatcher, Options, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { createPr, createPrOnlyIntendedCommandHook, type QueryFn } from './create-pr.js';

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

const VALID_INPUT = { title: 'feature: digest delivery (#42)', body: '## Summary\n- do thing', targetBranch: 'main' };
const CREATED_JSON = '{"url": "https://github.com/acme/widgets/pull/7", "number": 7}';

test('maps an "ok" outcome to ok:true with the parsed url/number', async () => {
  const result = await createPr(VALID_INPUT, { queryFn: fakeQuery(`RESULT: ok\n${CREATED_JSON}`) });
  assert.deepEqual(result, { ok: true, url: 'https://github.com/acme/widgets/pull/7', number: 7 });
});

test('maps a "branch-exists" outcome to ok:false with a branch-exists reason', async () => {
  const result = await createPr(VALID_INPUT, { queryFn: fakeQuery('RESULT: branch-exists') });
  assert.deepEqual(result, { ok: false, reason: 'branch-exists' });
});

test('maps an "error" outcome to ok:false with an unexpected-error reason', async () => {
  const result = await createPr(VALID_INPUT, { queryFn: fakeQuery('RESULT: error\nsomething went wrong') });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('treats an unparsable final result as unexpected-error rather than throwing', async () => {
  const result = await createPr(VALID_INPUT, { queryFn: fakeQuery('all done, pr is up!') });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('treats a RESULT: ok with unparsable JSON as unexpected-error', async () => {
  const result = await createPr(VALID_INPUT, { queryFn: fakeQuery('RESULT: ok\nnot json') });
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

  const result = await createPr(VALID_INPUT, { queryFn });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('maps a thrown session error to ok:false with an unexpected-error reason', async () => {
  const throwingQueryFn = (() => {
    throw new Error('subprocess failed to spawn');
  }) as QueryFn;

  const result = await createPr(VALID_INPUT, { queryFn: throwingQueryFn });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('restricts the session to the Bash tool, wires the no-force-push PreToolUse hook, and points at the local claude CLI', async () => {
  const captured: { value?: Options } = {};
  await createPr(VALID_INPUT, { queryFn: fakeQuery(`RESULT: ok\n${CREATED_JSON}`, captured) });

  assert.deepEqual(captured.value?.tools, ['Bash']);
  const preToolUse = captured.value?.hooks?.PreToolUse as HookCallbackMatcher[] | undefined;
  assert.ok(preToolUse && preToolUse.length > 0, 'expected a PreToolUse hook to be registered');
  assert.equal(captured.value?.pathToClaudeCodeExecutable, 'claude');
});

test('rejects malformed input shapes without throwing or invoking the session', async () => {
  const queryFn = (() => {
    throw new Error('query() should never be called for malformed input');
  }) as QueryFn;

  for (const bad of [
    null,
    42,
    [],
    {},
    { title: 'x', body: 'y' },
    { title: '', body: 'y', targetBranch: 'main' },
    { title: 'x', body: 'y', targetBranch: '' },
  ] as unknown[]) {
    const result = await createPr(bad as never, { queryFn });
    assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
  }
});

test('parses the LAST RESULT line when the model output contains more than one', async () => {
  const result = await createPr(
    VALID_INPUT,
    { queryFn: fakeQuery(`RESULT: branch-exists\nsome extra reasoning\nRESULT: ok\n${CREATED_JSON}`) },
  );
  assert.deepEqual(result, { ok: true, url: 'https://github.com/acme/widgets/pull/7', number: 7 });
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

test('createPrOnlyIntendedCommandHook allows only the exact gh pr create command built from this input', async () => {
  const hook = createPrOnlyIntendedCommandHook(VALID_INPUT);
  const signal = new AbortController().signal;

  const expectedCommand = [
    `gh pr create --base "${VALID_INPUT.targetBranch}" --title "${VALID_INPUT.title}" --body-file - <<'EOF'`,
    VALID_INPUT.body,
    'EOF',
  ].join('\n');

  const allowed = await hook(bashHookInput(expectedCommand), 'tool-1', { signal });
  assert.equal(decisionOf(allowed), 'allow');

  for (const command of [
    'git push origin main',
    'gh pr create --base develop --title x --body y',
    `gh pr create --base "${VALID_INPUT.targetBranch}" --title "something else" --body-file - <<'EOF'\n${VALID_INPUT.body}\nEOF`,
    'rm -rf .git',
  ]) {
    const denied = await hook(bashHookInput(command), 'tool-1', { signal });
    assert.equal(decisionOf(denied), 'deny', `expected "${command}" to be denied`);
  }
});
