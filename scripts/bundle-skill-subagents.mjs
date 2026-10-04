#!/usr/bin/env node
// Bundles the subagent (SDK and all dependencies inlined) into a single
// self-contained file and copies it into every skill folder that calls it,
// so `npx skills add --skill <name>` ships the subagent along with the
// skill itself — no npm publish, no npx package resolution, no separate
// install step for the subagent.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Skills that bundle the shared subagent into their own folder. Every entry
// here gets the exact same bundled file at `<skillDir>/subagent/cli.mjs` —
// duplicated per skill folder (not symlinked), since each skill can be
// installed independently of the others.
const SKILLS_NEEDING_SUBAGENT = ['git-agent-create-branch', 'git-agent-commit'];

for (const skillName of SKILLS_NEEDING_SUBAGENT) {
  const outfile = path.join(repoRoot, 'skills', skillName, 'subagent', 'cli.mjs');
  await build({
    entryPoints: [path.join(repoRoot, 'subagent', 'src', 'cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
  });
  console.log(`bundled subagent -> ${path.relative(repoRoot, outfile)}`);
}
