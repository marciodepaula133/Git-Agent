import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HookCallbackMatcher, Options, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { planCommit, planCommitReadOnlyHook, type QueryFn } from './plan-commit.js';

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

test('maps a "no-changes" outcome to ok:false with a no-changes reason', async () => {
  const result = await planCommit({ queryFn: fakeQuery('RESULT: no-changes') });
  assert.deepEqual(result, { ok: false, reason: 'no-changes' });
});

test('parses a valid plan into ok:true with commits and localOnlyCandidates', async () => {
  const plan = {
    commits: [
      { id: 0, message: 'feat: add widget', hunks: [{ file: 'src/widget.ts', startLine: 1, endLine: 10 }] },
      { id: 1, message: 'fix: typo', hunks: [{ file: 'src/widget.ts', startLine: 20, endLine: 22 }] },
    ],
    localOnlyCandidates: [{ file: '.env.local' }],
  };
  const result = await planCommit({ queryFn: fakeQuery(`RESULT: ok\n${JSON.stringify(plan)}`) });
  assert.deepEqual(result, { ok: true, ...plan });
});

test('treats an unparsable JSON body after RESULT: ok as unexpected-error', async () => {
  const result = await planCommit({ queryFn: fakeQuery('RESULT: ok\nnot valid json{') });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('treats a well-formed-JSON-but-wrong-shape body as unexpected-error', async () => {
  const result = await planCommit({ queryFn: fakeQuery('RESULT: ok\n{"commits": "nope"}') });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('maps an "error" outcome to ok:false with an unexpected-error reason', async () => {
  const result = await planCommit({ queryFn: fakeQuery('RESULT: error\nsomething went wrong') });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('treats an unparsable final result as unexpected-error rather than throwing', async () => {
  const result = await planCommit({ queryFn: fakeQuery('I made a plan, trust me') });
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

  const result = await planCommit({ queryFn });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('maps a thrown session error to ok:false with an unexpected-error reason', async () => {
  const throwingQueryFn = (() => {
    throw new Error('subprocess failed to spawn');
  }) as QueryFn;

  const result = await planCommit({ queryFn: throwingQueryFn });
  assert.deepEqual(result, { ok: false, reason: 'unexpected-error' });
});

test('restricts the session to Bash and Read, wires the no-force-push hook, and points at the local claude CLI', async () => {
  const captured: { value?: Options } = {};
  await planCommit({ queryFn: fakeQuery('RESULT: no-changes', captured) });

  assert.deepEqual(captured.value?.tools, ['Bash', 'Read']);
  const preToolUse = captured.value?.hooks?.PreToolUse as HookCallbackMatcher[] | undefined;
  assert.ok(preToolUse && preToolUse.length >= 2, 'expected the no-force-push hook plus a read-only command hook');
  assert.equal(captured.value?.pathToClaudeCodeExecutable, 'claude');
});

test('parses the LAST RESULT line when the model output contains more than one', async () => {
  const plan = { commits: [], localOnlyCandidates: [] };
  const result = await planCommit({
    queryFn: fakeQuery(`RESULT: no-changes\nactually wait\nRESULT: ok\n${JSON.stringify(plan)}`),
  });
  assert.deepEqual(result, { ok: true, ...plan });
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

test('planCommitReadOnlyHook allows only git inspection commands, denying anything that mutates', async () => {
  const hook = planCommitReadOnlyHook();
  const signal = new AbortController().signal;

  for (const command of [
    'git status --porcelain=v1',
    'git status',
    'git diff -- src/widget.ts',
    'git diff --cached -- src/widget.ts',
    'git config --get commit.template',
    'git branch --show-current',
  ]) {
    const allowed = await hook(bashHookInput(command), 'tool-1', { signal });
    assert.equal(decisionOf(allowed), 'allow', `expected "${command}" to be allowed`);
  }

  for (const command of [
    'git add .',
    'git commit -m "oops"',
    'git stash',
    'git reset --hard',
    'git apply patch.diff',
    'git checkout -b x',
    'rm -rf .git',
  ]) {
    const denied = await hook(bashHookInput(command), 'tool-1', { signal });
    assert.equal(decisionOf(denied), 'deny', `expected "${command}" to be denied`);
  }
});
