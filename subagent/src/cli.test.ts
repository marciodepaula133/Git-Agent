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

test('valid plan-commit input on a clean working tree produces exactly one JSON line, ok:false no-changes, in a real repo', { timeout: 180_000 }, async () => {
  const scratchDir = mkdtempSync(path.join(tmpdir(), 'git-agent-cli-plan-commit-test-'));
  try {
    await runGit(['init', '-q'], scratchDir);
    await runGit(['config', 'user.email', 'test@example.com'], scratchDir);
    await runGit(['config', 'user.name', 'Test'], scratchDir);
    writeFileSync(path.join(scratchDir, 'file.txt'), 'hello\n');
    await runGit(['add', 'file.txt'], scratchDir);
    await runGit(['commit', '-q', '-m', 'initial'], scratchDir);

    const { stdout, exitCode } = await runCli(['plan-commit'], '{}', scratchDir);
    const result = assertSingleJsonLine(stdout);
    assert.equal(exitCode, 0);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-changes');
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test(
  'valid execute-commit input stages exactly the planned hunk, commits it, and leaves an excluded local-only file untouched, in a real repo',
  { timeout: 180_000 },
  async () => {
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'git-agent-cli-execute-commit-test-'));
    try {
      await runGit(['init', '-q'], scratchDir);
      await runGit(['config', 'user.email', 'test@example.com'], scratchDir);
      await runGit(['config', 'user.name', 'Test'], scratchDir);
      writeFileSync(path.join(scratchDir, 'file.txt'), 'a\nb\nc\n');
      await runGit(['add', 'file.txt'], scratchDir);
      await runGit(['commit', '-q', '-m', 'initial'], scratchDir);

      // One tracked change (the whole diff is exactly one hunk: line 3) plus
      // an untracked local-only-looking file the plan flags but the decision
      // excludes.
      writeFileSync(path.join(scratchDir, 'file.txt'), 'a\nb\nX\n');
      writeFileSync(path.join(scratchDir, '.env.local'), 'SECRET=1\n');

      const input = {
        plan: {
          commits: [{ id: 0, message: 'fix: change line 3', hunks: [{ file: 'file.txt', startLine: 3, endLine: 3 }] }],
          localOnlyCandidates: [{ file: '.env.local' }],
        },
        decisions: { localOnly: { '.env.local': 'exclude' } },
      };

      const { stdout, exitCode } = await runCli(['execute-commit'], JSON.stringify(input), scratchDir);
      const result = assertSingleJsonLine(stdout);
      assert.equal(exitCode, 0);
      assert.equal(result.ok, true);
      const commits = result.commits as { id: number; sha: string; message: string }[];
      assert.equal(commits.length, 1);
      assert.equal(commits[0].message, 'fix: change line 3');
      assert.match(commits[0].sha, /^[0-9a-f]{40}$/);

      const { stdout: logOut } = await runGitCapture(['log', '--format=%H'], scratchDir);
      assert.ok(logOut.split('\n').filter((l) => l.trim().length > 0).includes(commits[0].sha));

      const { stdout: showOut } = await runGitCapture(['show', `${commits[0].sha}:file.txt`], scratchDir);
      assert.equal(showOut, 'a\nb\nX'); // runGitCapture trims trailing whitespace/newline

      const { stdout: statusOut } = await runGitCapture(['status', '--porcelain=v1'], scratchDir);
      assert.ok(statusOut.includes('.env.local'), 'expected .env.local to remain untracked');
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  },
);

function runGitCapture(args: string[], cwd: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ stdout: stdout.trim() }) : reject(new Error(`git ${args.join(' ')} exited ${code}`))));
  });
}

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited ${code}`))));
  });
}
