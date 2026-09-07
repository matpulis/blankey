import process from 'node:process';
import { c, badge, gradient, P, strip } from './colors.js';
import { S } from './symbols.js';
import { emit } from './output.js';

let quiet = false;
let verbose = false;
export function setQuiet(v: boolean): void { quiet = v; }
export function setVerbose(v: boolean): void { verbose = v; }
export const isVerbose = (): boolean => verbose;

const out = (s: string = ''): void => {
  if (quiet) return;
  if (emit(s + '\n', 'out')) return;
  process.stdout.write(s + '\n');
};
const err = (s: string = ''): void => {
  if (emit(s + '\n', 'err')) return;
  process.stderr.write(s + '\n');
};

export const log = {
  raw: out,
  blank: () => out(''),
  ok: (m) => out(`${c.ok(S.tick)} ${m}`),
  fail: (m) => err(`${c.err(S.cross)} ${m}`),
  warn: (m) => out(`${c.warn(S.warn)} ${m}`),
  info: (m) => out(`${c.info(S.info)} ${m}`),
  step: (m) => out(`${c.brand(S.chevron)} ${c.bold(m)}`),
  item: (m) => out(`  ${c.faint(S.bullet)} ${m}`),
  note: (m) => out(`  ${c.muted(m)}`),
  debug: (m) => { if (verbose) err(`${c.faint('debug')} ${c.faint(strip(m))}`); },
  title: (m, sub) => out(`\n${c.bold(gradient(m))}${sub ? '  ' + c.muted(sub) : ''}`),
  hint: (m) => out(`${c.faint(S.arrow + ' ' + m)}`),
};

/**
 * A bulleted list of commit lines, capped so a large pull does not bury the
 * summary it belongs to. Every place that shows "what came in" wants this.
 */
export function commitList(commits: string[], { limit = 5, indent = '    ' }: { limit?: number; indent?: string } = {}): void {
  for (const line of commits.slice(0, limit)) out(`${indent}${c.faint(S.bullet)} ${c.muted(line)}`);
  if (commits.length > limit) out(`${indent}${c.faint(`+${commits.length - limit} more`)}`);
}

/**
 * Say a prompt was declined, and give back the exit code for it.
 *
 * 130 is what a shell reports for "interrupted by the operator", which is what
 * answering no to a confirmation is. Returning it from the call site keeps the
 * two halves, the message and the code, from drifting apart.
 */
export function cancelled(): number {
  out(c.faint('  cancelled'));
  return 130;
}

export function fatal(message: string, { code = 1, hint }: { code?: number; hint?: string } = {}): never {
  err(`\n${badge(' ERROR ', P.err)} ${message}`);
  if (hint) err(`${c.faint(S.arrow)} ${c.muted(hint)}`);
  err('');
  const e = new Error(strip(message)) as Error & { __handled?: boolean; exitCode?: number };
  e.__handled = true;
  e.exitCode = code;
  throw e;
}

