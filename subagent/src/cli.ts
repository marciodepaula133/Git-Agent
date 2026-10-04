#!/usr/bin/env node
import { createBranch, type CreateBranchInput } from './actions/create-branch.js';
import { push, type PushInput } from './actions/push.js';

type ActionHandler = (input: unknown) => Promise<unknown>;

const actions: Record<string, ActionHandler> = {
  'create-branch': (input) => createBranch(input as CreateBranchInput),
  push: (input) => push(input as PushInput),
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Single binary, subcommand-routed (docs/architecture.md rule 5). Input comes
 * in on stdin only, never argv (a large commit plan can exceed Windows' argv
 * limit). The last line of stdout is always exactly one JSON object,
 * `{ ok: boolean, ... }`. A non-zero exit is reserved for a genuinely
 * unexpected top-level failure — never for an ordinary `ok:false` result.
 */
async function main(): Promise<void> {
  const action = process.argv[2];
  const handler = action ? actions[action] : undefined;

  if (!handler) {
    console.log(JSON.stringify({ ok: false, reason: 'unexpected-error' }));
    return;
  }

  const raw = await readStdin();
  let input: unknown;
  try {
    input = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch {
    console.log(JSON.stringify({ ok: false, reason: 'unexpected-error' }));
    return;
  }

  const result = await handler(input);
  console.log(JSON.stringify(result));
}

main().catch((error: unknown) => {
  process.stderr.write(`git-agent subagent: unexpected top-level failure: ${String(error)}\n`);
  process.exitCode = 1;
});
