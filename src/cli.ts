import process from 'node:process';
import { createRequire } from 'node:module';
import { parseArgs } from './args.js';
import { loadConfig, requireConfig } from './config.js';
import { createContext } from './context.js';
import * as host from './host.js';
import { setLevel, c, gradient, P, badge, pad, width, bold, fg } from './ui/colors.js';
import { banner } from './ui/box.js';
import { S } from './ui/symbols.js';
import { log, setQuiet, setVerbose } from './ui/log.js';
import { commands, findCommand } from './commands/index.js';
import { levenshtein } from './util.js';

/**
 * Read from package.json rather than written here twice. An update check that
 * compares against a stale constant would offer upgrades you already have, or
 * miss ones you do not.
 */
export const VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return String(require('../../package.json').version || '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

const GLOBAL_VALUE_FLAGS = ['config', 'projectsDir', 'host', 'stack', 'env'];
const GLOBAL_ALIASES = {
  c: 'config', v: 'verbose', q: 'quiet', h: 'help', V: 'version',
  y: 'yes', s: 'stack', a: 'all', f: 'follow', n: 'dryRun',
};

export async function main(argv) {
  // Parse twice: the first pass only needs to reveal which command was asked
  // for, the second uses that command's own flags so short aliases like -l can
  // mean different things in different commands.
  const firstPass = parseArgs(argv, { valueFlags: GLOBAL_VALUE_FLAGS, aliases: GLOBAL_ALIASES });
  const requested = findCommand(firstPass.positional[0]);

  const { flags, positional, passthrough } = parseArgs(argv, {
    valueFlags: [...GLOBAL_VALUE_FLAGS, ...(requested?.valueFlags || [])],
    aliases: { ...GLOBAL_ALIASES, ...(requested?.flagAliases || {}) },
  });

  if (flags.color === false || flags.noColor) setLevel(0);
  if (flags.color === true) setLevel(3);
  if (flags.json) setLevel(0);
  setVerbose(Boolean(flags.verbose));
  setQuiet(Boolean(flags.quiet));

  if (flags.version) {
    process.stdout.write(`blankey ${VERSION}\n`);
    return 0;
  }

  const name = positional[0];

  // Bare `blankey` opens the interactive program. Piped or redirected, there is
  // no terminal to drive, so fall back to the help text.
  if (!name && !flags.help) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const cfg = await loadConfig({ file: flags.config });
      if (cfg?.ssh?.host) host.useRemote(cfg.ssh);
      const { runApp } = await import('./tui/app.js');
      return runApp({ cfg });
    }
    printHelp();
    return 0;
  }
  if (!name) {
    printHelp();
    return 0;
  }

  const command = requested;
  if (!command) {
    suggest(name);
    return 127;
  }
  if (flags.help) {
    printCommandHelp(command);
    return 0;
  }

  let cfg = await loadConfig({ file: flags.config });
  if (cfg && flags.projectsDir) cfg.projectsDir = String(flags.projectsDir);
  if (cfg && flags.host) cfg.ssh = { ...(cfg.ssh || {}), host: String(flags.host) };
  if (!cfg && flags.projectsDir) {
    const { normalize, DEFAULTS, deepMerge } = await import('./config.js');
    cfg = normalize(deepMerge(DEFAULTS, { projectsDir: String(flags.projectsDir) }));
    cfg.__file = '(from --projects-dir)';
  }
  if (command.needsConfig !== false) requireConfig(cfg);
  if (cfg?.ssh?.host) host.useRemote(cfg.ssh);

  const ctx = createContext({ cfg, flags, positional: positional.slice(1), passthrough });
  const code = await command.run(ctx);

  // After the work, never before it: the check reads a cache written by a
  // previous run, and any refresh it starts outlives this process.
  if (command.name !== 'update') await announceUpdate(cfg, flags);

  return typeof code === 'number' ? code : 0;
}

async function announceUpdate(cfg, flags): Promise<void> {
  try {
    const { noticeUpdate } = await import('./update.js');
    const release = await noticeUpdate(cfg, VERSION, {
      json: Boolean(flags.json),
      quiet: Boolean(flags.quiet),
    });
    if (!release) return;
    log.blank();
    log.raw(`  ${fg(P.info, S.up)} ${c.muted('blankey')} ${bold(release.version)} ${c.muted('is available')}` +
      c.faint(`  you have v${VERSION}`));
    log.raw(`  ${c.faint(S.arrow)} ${c.muted('blankey update')}${release.url ? c.faint('   ' + release.url) : ''}`);
    log.blank();
  } catch {
    // Telling someone about a new version must never break the command they ran.
  }
}


function suggest(name) {
  const all = commands.flatMap((cmd) => [cmd.name, ...(cmd.aliases || [])]);
  const near = all
    .map((n) => ({ n, d: levenshtein(name, n) }))
    .sort((a, b) => a.d - b.d)
    .filter((x) => x.d <= 3)
    .slice(0, 3);
  process.stderr.write(`\n${badge(' ERROR ', P.err)} Unknown command ${c.bold(name)}\n`);
  if (near.length) {
    process.stderr.write(`${c.faint(S.arrow)} ${c.muted('Did you mean ' + near.map((x) => c.bold(x.n)).join(', ') + '?')}\n`);
  }
  process.stderr.write(`${c.faint(S.arrow)} ${c.muted('Run `blankey --help` to see every command.')}\n\n`);
}

const GROUP_ORDER = ['Monitor', 'Lifecycle', 'Deployments', 'Traefik', 'Maintenance', 'Setup'];

export function printHelp() {
  log.raw(banner(`v${VERSION}  ${S.bullet}  docker compose fleet manager`));
  log.raw('');
  log.raw(`  ${c.muted('USAGE')}  ${c.bold('blankey')} ${c.faint('<command> [project[:stack]] [options]')}`);
  log.raw(`  ${c.muted('     ')}  ${c.bold('blankey')} ${c.faint('with no arguments opens the interactive menu')}`);
  log.raw('');

  const groups = new Map();
  for (const cmd of commands) {
    if (cmd.hidden) continue;
    const g = cmd.group || 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(cmd);
  }
  // Anything not in GROUP_ORDER sorts to the end rather than to the front.
  const rank = (g: string) => {
    const at = GROUP_ORDER.indexOf(g);
    return at === -1 ? GROUP_ORDER.length : at;
  };
  const names = [...groups.keys()].sort((a, b) => rank(a) - rank(b));
  const labelWidth = Math.max(
    ...commands.filter((x) => !x.hidden).map((x) => width(commandLabel(x))),
  );

  for (const g of names) {
    log.raw(`  ${c.bold(gradient(g.toUpperCase(), [P.brand, P.accent]))}`);
    for (const cmd of groups.get(g)) {
      log.raw(`    ${c.bold(pad(commandLabel(cmd), labelWidth))}  ${c.muted(cmd.describe)}`);
    }
    log.raw('');
  }

  log.raw(`  ${c.bold(gradient('GLOBAL FLAGS', [P.brand, P.accent]))}`);
  const globals = [
    ['-c, --config <file>', 'use a specific config file'],
    ['    --projects-dir <dir>', 'override the configured projects directory'],
    ['    --host <user@host>', 'run against a remote Docker host over SSH'],
    ['-s, --stack <name>', 'target a named stack (staging, prod, ...)'],
    ['-y, --yes', 'skip confirmation prompts'],
    ['    --json', 'machine-readable output'],
    ['-v, --verbose', 'show the commands being run'],
    ['-q, --quiet', 'suppress non-essential output'],
    ['    --no-color', 'disable colour'],
  ];
  const gw = Math.max(...globals.map(([k]) => width(k)));
  for (const [k, d] of globals) log.raw(`    ${c.bold(pad(k, gw))}  ${c.muted(d)}`);
  log.raw('');
  log.raw(`  ${c.faint('Examples')}`);
  for (const ex of [
    'blankey status                     live view of every stack',
    'blankey sh                         pick a container and shell into it',
    'blankey logs                       pick a container and watch it live',
    'blankey clean                      what disk you would get back, no changes',
    'blankey backup --all               archive every volume to S3',
    'blankey pull --all                 update every repo, restart nothing',
    'blankey deploy --all --changed     redeploy only repos with new commits',
    'blankey deploy shop-api --at v1.4  run one commit, then put the repo back',
  ]) {
    const [cmdPart, desc] = [ex.slice(0, 34).trimEnd(), ex.slice(34)];
    log.raw(`    ${c.info(cmdPart)}${c.faint(' '.repeat(Math.max(1, 36 - width(cmdPart))) + desc)}`);
  }
  log.raw('');
}

function commandLabel(cmd) {
  const alias = cmd.aliases?.length ? c.faint(', ' + cmd.aliases[0]) : '';
  return cmd.name + alias;
}

export function printCommandHelp(cmd) {
  log.raw('');
  log.raw(`  ${c.bold(gradient('blankey ' + cmd.name))}  ${c.muted(cmd.describe)}`);
  log.raw('');
  log.raw(`  ${c.muted('USAGE')}  ${c.bold('blankey ' + (cmd.usage || cmd.name))}`);
  if (cmd.aliases?.length) log.raw(`  ${c.muted('ALIAS')}  ${cmd.aliases.join(', ')}`);
  log.raw('');
  if (cmd.options?.length) {
    const w = Math.max(...cmd.options.map(([k]) => width(k)));
    log.raw(`  ${c.bold('OPTIONS')}`);
    for (const [k, d] of cmd.options) log.raw(`    ${c.bold(pad(k, w))}  ${c.muted(d)}`);
    log.raw('');
  }
  if (cmd.details) {
    log.raw(cmd.details.split('\n').map((l) => '  ' + c.muted(l)).join('\n'));
    log.raw('');
  }
  if (cmd.examples?.length) {
    log.raw(`  ${c.bold('EXAMPLES')}`);
    for (const ex of cmd.examples) log.raw(`    ${c.info(ex[0])}\n      ${c.faint(ex[1])}`);
    log.raw('');
  }
}
