import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, 'cli.js');

type SpawnResult = { stdout: string; stderr: string; exitCode: number | null };

function runCli(args: string[], stdin: string, cwd?: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** Asserts stdout is exactly one line and that it parses as JSON with `ok` set. */
function assertSingleJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  assert.equal(lines.length, 1, `expected exactly one non-empty stdout line, got: ${JSON.stringify(stdout)}`);
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(typeof parsed.ok, 'boolean');
  return parsed;
}

test('unknown action produces exactly one ok:false JSON line', async () => {
  const { stdout, exitCode } = await runCli(['not-a-real-action'], '{}');
  const result = assertSingleJsonLine(stdout);
  assert.equal(result.ok, false);
  assert.equal(exitCode, 0);
});

test('malformed JSON on stdin produces exactly one ok:false JSON line', async () => {
  const { stdout, exitCode } = await runCli(['create-branch'], 'not json{');
  const result = assertSingleJsonLine(stdout);
  assert.equal(result.ok, false);
  assert.equal(exitCode, 0);
});

test('empty stdin produces exactly one ok:false JSON line (missing branchName)', async () => {
  const { stdout, exitCode } = await runCli(['create-branch'], '');
  const result = assertSingleJsonLine(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unexpected-error');
  assert.equal(exitCode, 0);
});

for (const [label, body] of [
  ['null', 'null'],
  ['a number', '42'],
  ['an array', '[]'],
  ['an object with no branchName', '{}'],
] as const) {
  test(`non-object-with-branchName JSON on stdin (${label}) produces exactly one ok:false JSON line`, async () => {
    const { stdout, exitCode } = await runCli(['create-branch'], body);
    const result = assertSingleJsonLine(stdout);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unexpected-error');
    assert.equal(exitCode, 0);
  });
}

test('valid create-branch input produces exactly one JSON line, ok true, in a real repo', { timeout: 120_000 }, async () => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), 'git-agent-cli-test-'));
  try {
    await runGit(['init', '-q'], scratchDir);
    await runGit(['config', 'user.email', 'test@example.com'], scratchDir);
    await runGit(['config', 'user.name', 'Test'], scratchDir);
    writeFileSync(path.join(scratchDir, 'file.txt'), 'hello\n');
    await runGit(['add', 'file.txt'], scratchDir);
    await runGit(['commit', '-q', '-m', 'initial'], scratchDir);

    const { stdout, exitCode } = await runCli(
      ['create-branch'],
      JSON.stringify({ branchName: 'feature/1-cli-test' }),
      scratchDir,
    );
    const result = assertSingleJsonLine(stdout);
    assert.equal(exitCode, 0);
    assert.equal(result.ok, true);
    assert.equal(result.branchName, 'feature/1-cli-test');
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited ${code}`))));
  });
}
