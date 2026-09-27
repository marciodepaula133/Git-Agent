import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { noForcePushHook } from './no-force-push.js';

function bashCall(command: string): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'tool-1',
    session_id: 'session-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/repo',
  };
}

async function decisionFor(command: string): Promise<string | undefined> {
  const output = (await noForcePushHook(bashCall(command), 'tool-1', {
    signal: new AbortController().signal,
  })) as SyncHookJSONOutput;
  return output.hookSpecificOutput && 'permissionDecision' in output.hookSpecificOutput
    ? output.hookSpecificOutput.permissionDecision
    : undefined;
}

test('allows a plain git push', async () => {
  assert.equal(await decisionFor('git push origin main'), 'allow');
});

test('allows a plain git push with safe flags', async () => {
  assert.equal(await decisionFor('git push --set-upstream origin feature/1-x'), 'allow');
  assert.equal(await decisionFor('git push -u origin feature/1-x'), 'allow');
});

test('denies git push --force', async () => {
  assert.equal(await decisionFor('git push --force origin main'), 'deny');
});

test('denies git push -f', async () => {
  assert.equal(await decisionFor('git push -f origin main'), 'deny');
});

test('denies git push --force-with-lease and its =<ref> form', async () => {
  assert.equal(await decisionFor('git push --force-with-lease origin main'), 'deny');
  assert.equal(await decisionFor('git push --force-with-lease=main:abc123 origin main'), 'deny');
});

test('denies combined short flags carrying force, e.g. -uf', async () => {
  assert.equal(await decisionFor('git push -uf origin main'), 'deny');
  assert.equal(await decisionFor('git push -fu origin main'), 'deny');
});

test('denies a push with an unrecognized flag, even without force', async () => {
  assert.equal(await decisionFor('git push --mirror origin main'), 'deny');
});

test('denies a force-push hidden after a chained command', async () => {
  assert.equal(await decisionFor('git checkout -b x && git push --force'), 'deny');
  assert.equal(await decisionFor('git status; git push -f'), 'deny');
});

test('allows unrelated git commands untouched', async () => {
  assert.equal(await decisionFor('git show-ref --verify --quiet refs/heads/feature/1-x'), 'allow');
  assert.equal(await decisionFor('git checkout -b feature/1-x'), 'allow');
  assert.equal(await decisionFor('git status'), 'allow');
});

test('ignores non-Bash tool calls', async () => {
  const input: PreToolUseHookInput = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/repo/README.md' },
    tool_use_id: 'tool-2',
    session_id: 'session-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/repo',
  };
  const output = await noForcePushHook(input, 'tool-2', { signal: new AbortController().signal });
  assert.deepEqual(output, {});
});

test('quoted force flag text inside an unrelated argument does not trigger a deny', async () => {
  assert.equal(await decisionFor('git commit -m "add --force flag docs"'), 'allow');
});

test('denies a force push hidden behind a value-taking global option', async () => {
  assert.equal(await decisionFor('git -C /tmp push --force'), 'deny');
  assert.equal(await decisionFor('git -c x=y push -f'), 'deny');
});

test('allows an unrelated gh command whose argument value happens to be "push"', async () => {
  assert.equal(await decisionFor('gh issue create --title push'), 'allow');
});

test('denies a gh push-equivalent in the subcommand position', async () => {
  assert.equal(await decisionFor('gh push origin main'), 'deny');
});
