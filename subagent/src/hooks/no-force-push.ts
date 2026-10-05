import type { HookCallback, HookCallbackMatcher, HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

/**
 * Splits a shell command string into top-level segments (on `&&`, `||`, `;`, `|`,
 * and — unless `splitOnNewline` is set to `false` — bare newlines) and
 * tokenizes each segment into words, respecting single/double quotes.
 *
 * This is deliberately not a full shell parser — it's just enough to reason
 * about argument tokens rather than pattern-matching the raw string, per
 * docs/architecture.md rule 3. `splitOnNewline: false` is for callers whose
 * allowed commands legitimately span multiple lines (e.g. a heredoc-based
 * `git apply`) and must not have each line treated as its own segment.
 */
export function splitIntoSegments(command: string, options: { splitOnNewline?: boolean } = {}): string[][] {
  const splitOnNewline = options.splitOnNewline ?? true;
  const segments: string[][] = [];
  let current: string[] = [];
  let word = '';
  let inSingle = false;
  let inDouble = false;
  let hasWord = false;

  const pushWord = () => {
    if (hasWord) {
      current.push(word);
      word = '';
      hasWord = false;
    }
  };

  const pushSegment = () => {
    pushWord();
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else word += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else word += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasWord = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      hasWord = true;
      continue;
    }

    if (ch === '&' && command[i + 1] === '&') {
      pushSegment();
      i++;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      pushSegment();
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || (splitOnNewline && ch === '\n')) {
      pushSegment();
      continue;
    }

    if (/\s/.test(ch)) {
      pushWord();
      continue;
    }

    word += ch;
    hasWord = true;
  }
  pushSegment();

  return segments;
}

/** Long-option or exact-flag forms that always mean "force". */
const FORCE_LONG_FLAGS = new Set(['--force']);

function isForceLongFlag(token: string): boolean {
  if (FORCE_LONG_FLAGS.has(token)) return true;
  // --force-with-lease and --force-with-lease=<ref>
  return token === '--force-with-lease' || token.startsWith('--force-with-lease=');
}

/**
 * A short-option cluster like `-f`, `-uf`, `-fu` carries force if any letter
 * in the cluster is `f`. `-` alone or a bare negative number is not a cluster.
 */
function isForceShortCluster(token: string): boolean {
  if (!token.startsWith('-') || token.startsWith('--')) return false;
  const letters = token.slice(1);
  if (letters.length === 0) return false;
  return letters.includes('f');
}

function hasForceFlag(tokens: string[]): boolean {
  return tokens.some((token) => isForceLongFlag(token) || isForceShortCluster(token));
}

/** Flags a plain, non-force `git push` is allowed to carry. */
const SAFE_PUSH_FLAGS = new Set([
  '--set-upstream',
  '-u',
  '--tags',
  '--follow-tags',
  '--dry-run',
  '--verbose',
  '-v',
  '--quiet',
  '-q',
  '--no-verify',
  '--porcelain',
]);

function isRecognizedPlainPush(tokens: string[], subcommandIndex: number): boolean {
  // tokens[subcommandIndex] === 'push'; everything after it is either a safe
  // flag or a bare positional (remote/refspec) — anything else is unrecognized.
  for (let i = subcommandIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('-')) continue; // positional arg (remote, refspec, ...)
    if (SAFE_PUSH_FLAGS.has(token)) continue;
    return false; // unrecognized flag on a push — don't guess, deny
  }
  return true;
}

/**
 * Global `git` options that take a separate value argument (`-C <path>`,
 * `-c <name>=<value>`, ...). Their value must be skipped when scanning for
 * the subcommand, or the value itself (e.g. `/tmp` in `git -C /tmp push`)
 * gets mistaken for the subcommand and the real subcommand (`push`) is
 * missed entirely.
 */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

/** Finds the index of the first non-flag token after `git`, if any. */
function findSubcommandIndex(tokens: string[]): number {
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token.startsWith('-')) return i;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      i += 2; // skip the option and its separate value
      continue;
    }
    if (token.includes('=') && GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token.slice(0, token.indexOf('=')))) {
      i += 1; // --opt=value form, value is inline
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * True if this tokenized segment is a push (or push-equivalent) command,
 * whether or not it turns out to be safe.
 */
function isPushShaped(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const program = tokens[0];
  if (program === 'git') {
    const subcommandIndex = findSubcommandIndex(tokens);
    return subcommandIndex !== -1 && tokens[subcommandIndex] === 'push';
  }
  if (program === 'gh') {
    // `gh` has no native `push` subcommand today, but treat the literal word
    // in the subcommand position conservatively as push-shaped so a
    // future/unexpected gh push-equivalent is still deny-by-default rather
    // than silently allowed. Only the subcommand position is checked — an
    // unrelated flag/argument value elsewhere (e.g. `gh issue create --title
    // push`) must not trigger this.
    return tokens[1] === 'push';
  }
  return false;
}

/**
 * Evaluates a single tokenized command segment. Returns a deny reason if the
 * segment is push-shaped and either force-flagged or not a recognized plain
 * push; returns null if the segment should be allowed through.
 */
function evaluateSegment(tokens: string[]): string | null {
  if (!isPushShaped(tokens)) return null;

  if (hasForceFlag(tokens)) {
    return `Denied: force-push-shaped command detected (${tokens.join(' ')}).`;
  }

  if (tokens[0] === 'git') {
    const subcommandIndex = findSubcommandIndex(tokens);
    if (subcommandIndex === -1 || !isRecognizedPlainPush(tokens, subcommandIndex)) {
      return `Denied: push command not recognized as a safe plain push (${tokens.join(' ')}).`;
    }
    return null;
  }

  // Any gh push-equivalent we can't positively recognize as safe is denied.
  return `Denied: unrecognized push-equivalent command (${tokens.join(' ')}).`;
}

/**
 * PreToolUse hook: deny-by-default for anything push-shaped that is
 * force-flagged or not a recognized plain push. Everything else (including
 * every non-push git/gh command) is allowed through untouched.
 *
 * Lives only inside the subagent's own SDK session — never registered in
 * settings.json — per docs/architecture.md rule 3.
 */
export const noForcePushHook: HookCallback = async (input: HookInput): Promise<SyncHookJSONOutput> => {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
    return {};
  }

  const toolInput = input.tool_input as { command?: unknown } | undefined;
  const command = typeof toolInput?.command === 'string' ? toolInput.command : '';

  const segments = splitIntoSegments(command);
  for (const tokens of segments) {
    const denyReason = evaluateSegment(tokens);
    if (denyReason) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: denyReason,
        },
      };
    }
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  };
};

/** Ready-to-use `PreToolUse` matcher for `Options.hooks`. */
export const noForcePushHookMatcher: HookCallbackMatcher = {
  matcher: 'Bash',
  hooks: [noForcePushHook],
};
