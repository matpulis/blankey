import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { log, cancelled } from '../ui/log.js';
import { c, P, fg, bold } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { confirm } from '../ui/prompt.js';
import { box, rule } from '../ui/box.js';

/**
 * Opening blankey automatically when someone logs in.
 *
 * This edits the file that runs on login, which is the one piece of a server
 * you can genuinely lock yourself out of: a login script that fails, or a
 * program that will not exit, is reached before you have a shell to fix it
 * with. Everything here is built around that.
 *
 * The escape hatch is structural rather than a setting. Login scripts run for
 * interactive login shells only, so `ssh user@host bash` never reaches this
 * snippet and always lands you in a plain shell, no matter how broken blankey
 * is. The guards below add the same protection for the cases a shell alone
 * does not cover: a non-interactive session, a missing binary, a nested shell
 * opened from inside blankey itself.
 *
 * Nothing here goes through `host`: autostart configures the machine blankey
 * runs on, which is not the Docker host when one is reached over SSH.
 */

const BEGIN = '# >>> blankey autostart >>>';
const END = '# <<< blankey autostart <<<';

const SYSTEM_POSIX = '/etc/profile.d/blankey-autostart.sh';
const SYSTEM_FISH = '/etc/fish/conf.d/blankey-autostart.fish';

export type ShellFamily = 'posix' | 'fish';

export interface SnippetOptions {
  family?: ShellFamily;
  /** End the session when blankey exits, instead of dropping to a shell. */
  kiosk?: boolean;
  /** Only open for SSH logins, not on the physical console. */
  sshOnly?: boolean;
  /** What to run. A bare name is resolved from PATH at login time. */
  command?: string;
}

/** fish is the one common login shell that cannot read a POSIX profile. */
export function shellFamily(shell: string = process.env.SHELL || ''): ShellFamily {
  return path.basename(shell) === 'fish' ? 'fish' : 'posix';
}

/**
 * The login snippet.
 *
 * Written as one block between markers so it can be recognised, replaced and
 * removed exactly, without disturbing anything else in the file.
 */
export function renderSnippet({
  family = 'posix', kiosk = false, sshOnly = false, command = 'blankey',
}: SnippetOptions = {}): string {
  const escape = family === 'fish' ? 'ssh user@host fish -c true' : 'ssh user@host bash';
  const notes = [
    '# Managed by blankey. Change it with `blankey autostart`, not by hand.',
    '#',
    '# Locked out? You cannot be. This runs for interactive login shells only,',
    `# so \`${escape}\` always gets you a plain shell, even if blankey is`,
    '# broken. Setting BLANKEY_NO_AUTOSTART=1 skips it too.',
  ];

  if (family === 'fish') {
    const conditions = [
      'status is-interactive', 'status is-login',
      'not set -q BLANKEY_NO_AUTOSTART', 'not set -q BLANKEY_ACTIVE',
      ...(sshOnly ? ['set -q SSH_CONNECTION'] : []),
      'isatty stdin', 'isatty stdout',
      `command -q ${command}`,
    ];
    return [
      BEGIN,
      ...notes,
      `if ${conditions.join('; and ')}`,
      `    ${command}`,
      ...(kiosk ? ['    exit'] : []),
      'end',
      END,
    ].join('\n');
  }

  const conditions = [
    '[ -t 0 ]', '[ -t 1 ]',
    ...(sshOnly ? ['[ -n "${SSH_CONNECTION:-}" ]'] : []),
    `command -v ${command} >/dev/null 2>&1`,
  ];
  return [
    BEGIN,
    ...notes,
    'if [ -z "${BLANKEY_NO_AUTOSTART:-}" ] && [ -z "${BLANKEY_ACTIVE:-}" ]; then',
    '  case $- in',
    '    *i*)',
    `      if ${conditions.join(' && ')}; then`,
    `        ${command}`,
    // `exit` rather than `exec`: a shell that cannot exec the replacement dies
    // on the spot, which is exactly the failure this must not have.
    ...(kiosk ? ['        exit'] : []),
    '      fi',
    '      ;;',
    '  esac',
    'fi',
    END,
  ].join('\n');
}

export const hasSnippet = (text: string): boolean => text.includes(BEGIN);

/** Add the snippet, or replace the one already there. */
export function withSnippet(existing: string, snippet: string): string {
  const begin = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (begin !== -1 && end !== -1 && end > begin) {
    return existing.slice(0, begin) + snippet + existing.slice(end + END.length);
  }
  const before = existing.replace(/\s*$/, '');
  return (before ? before + '\n\n' : '') + snippet + '\n';
}

/** Take the snippet back out, leaving the rest of the file as it was. */
export function withoutSnippet(existing: string): string {
  const begin = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) return existing;
  const before = existing.slice(0, begin).replace(/\s*$/, '');
  const after = existing.slice(end + END.length).replace(/^\s*/, '');
  if (!before) return after;
  if (!after) return before + '\n';
  return `${before}\n\n${after}`;
}

const readOr = async (file: string, fallback = ''): Promise<string> => {
  try { return await fs.readFile(file, 'utf8'); } catch { return fallback; }
};

const fileExists = async (file: string): Promise<boolean> => {
  try { await fs.access(file); return true; } catch { return false; }
};

/**
 * Which file a login shell actually reads.
 *
 * bash sources the first of .bash_profile, .bash_login and .profile that
 * exists and stops there, so writing to the wrong one is a snippet that never
 * runs. zsh reads .zprofile regardless.
 */
export async function userProfilePath(family: ShellFamily = shellFamily()): Promise<string> {
  const home = os.homedir();
  if (family === 'fish') return path.join(home, '.config', 'fish', 'conf.d', 'blankey-autostart.fish');
  if (path.basename(process.env.SHELL || '') === 'zsh') return path.join(home, '.zprofile');
  for (const name of ['.bash_profile', '.bash_login', '.profile']) {
    if (await fileExists(path.join(home, name))) return path.join(home, name);
  }
  return path.join(home, '.profile');
}

async function targetPath(system: boolean, family: ShellFamily): Promise<string> {
  if (!system) return userProfilePath(family);
  return family === 'fish' ? SYSTEM_FISH : SYSTEM_POSIX;
}

/** Every place the snippet could be, so `status` reports the whole picture. */
async function installedAt(): Promise<string[]> {
  const candidates = [
    SYSTEM_POSIX,
    SYSTEM_FISH,
    await userProfilePath('posix'),
    await userProfilePath('fish'),
    path.join(os.homedir(), '.bash_profile'),
    path.join(os.homedir(), '.bash_login'),
    path.join(os.homedir(), '.profile'),
    path.join(os.homedir(), '.zprofile'),
  ];
  const found: string[] = [];
  for (const file of [...new Set(candidates)]) {
    if (hasSnippet(await readOr(file))) found.push(file);
  }
  return found;
}

/** Is the name in the snippet going to resolve on PATH at login? */
async function onPath(command: string): Promise<string | null> {
  if (command.includes('/')) return (await fileExists(command)) ? command : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

const SUBCOMMANDS = ['status', 'enable', 'disable', 'print'];

export default {
  name: 'autostart',
  aliases: ['login'],
  group: 'Setup',
  describe: 'Open blankey automatically when you log in over SSH',
  usage: 'autostart [status|enable|disable|print] [--system] [--kiosk]',
  needsConfig: false,
  valueFlags: ['command'],
  options: [
    ['    --system', 'install for every user (/etc/profile.d), needs root'],
    ['    --kiosk', 'end the session when blankey exits, instead of dropping to a shell'],
    ['    --ssh-only', 'only open for SSH logins, not on the physical console'],
    ['    --command <path>', 'what to run (default: blankey, found on PATH)'],
    ['-y, --yes', 'skip the confirmation'],
  ],
  details:
    'Adds a small guarded block to the file your login shell reads, so opening a\n' +
    'session drops you straight into blankey.\n' +
    '\n' +
    'You cannot lock yourself out with this. Login scripts run for interactive\n' +
    'login shells only, so `ssh user@host bash` bypasses the block entirely and\n' +
    'always gives you a plain shell, which is how you would undo it if blankey\n' +
    'ever failed to start. BLANKEY_NO_AUTOSTART=1 skips it as well.\n' +
    '\n' +
    'Without --kiosk, quitting blankey leaves you at your normal shell. With it,\n' +
    'quitting ends the session, which is what you want for an operator account\n' +
    'that should only ever see blankey.',
  examples: [
    ['blankey autostart enable', 'just for you'],
    ['sudo blankey autostart enable --system', 'for everyone who logs in'],
    ['blankey autostart enable --kiosk --ssh-only', 'an operator account that only runs blankey'],
    ['blankey autostart disable', 'put the login file back'],
  ],
  async run(ctx) {
    const sub = ctx.positional[0] || 'status';
    if (!SUBCOMMANDS.includes(sub)) {
      log.fail(`Unknown autostart subcommand: ${c.bold(sub)}`);
      log.hint(SUBCOMMANDS.join(', '));
      return 127;
    }

    const family = shellFamily();
    const options: SnippetOptions = {
      family,
      kiosk: Boolean(ctx.flags.kiosk),
      sshOnly: Boolean(ctx.flags.sshOnly),
      command: ctx.flags.command ? String(ctx.flags.command) : 'blankey',
    };

    if (sub === 'print') {
      log.raw(renderSnippet(options));
      return 0;
    }
    if (sub === 'status') return statusCmd(ctx);
    if (sub === 'disable') return disableCmd(ctx, family);
    return enableCmd(ctx, options);
  },
};

async function statusCmd(ctx): Promise<number> {
  const found = await installedAt();

  if (ctx.json) {
    log.raw(JSON.stringify({ enabled: found.length > 0, files: found, host: os.hostname() }, null, 2));
    return 0;
  }

  log.blank();
  log.raw(rule('open on login'));
  log.blank();
  log.raw(`  ${c.muted('machine')}  ${bold(os.hostname())} ${c.faint('(where blankey itself runs)')}`);
  log.raw(`  ${c.muted('shell')}    ${c.faint(process.env.SHELL || 'unknown')}`);
  log.blank();

  if (!found.length) {
    log.raw(`  ${c.faint(S.ring)} ${c.muted('Not enabled. Logging in gives you a normal shell.')}`);
    log.blank();
    log.hint('blankey autostart enable          just for you');
    log.hint('sudo blankey autostart enable --system   for everyone');
    log.blank();
    return 0;
  }

  for (const file of found) {
    log.raw(`  ${c.ok(S.tick)} ${bold(file)}`);
  }
  log.blank();
  log.raw(box([
    `${c.muted('Getting a plain shell anyway:')}`,
    `${c.bold('ssh user@host bash')}          ${c.muted('skips it entirely')}`,
    `${c.bold('BLANKEY_NO_AUTOSTART=1')}      ${c.muted('skips it for one session')}`,
    '',
    `${c.bold('blankey autostart disable')}   ${c.muted('remove it again')}`,
  ], { title: 'escape hatches' }));
  log.blank();
  return 0;
}

async function enableCmd(ctx, options: SnippetOptions): Promise<number> {
  const system = Boolean(ctx.flags.system);
  const family = options.family ?? 'posix';
  const target = await targetPath(system, family);
  const snippet = renderSnippet(options);
  const command = options.command ?? 'blankey';

  const resolved = await onPath(command);

  log.blank();
  log.raw(rule('open on login'));
  log.blank();
  log.raw(`  ${c.muted('file')}     ${bold(target)}`);
  log.raw(`  ${c.muted('scope')}    ${c.muted(system ? 'every user on this machine' : 'just ' + (process.env.USER || os.userInfo().username))}`);
  log.raw(`  ${c.muted('runs')}     ${resolved ? c.faint(resolved) : fg(P.warn, command + '  (not on PATH right now)')}`);
  log.raw(`  ${c.muted('on quit')}  ${c.muted(options.kiosk ? 'the session ends' : 'you land in your normal shell')}`);
  if (options.sshOnly) log.raw(`  ${c.muted('only for')} ${c.muted('SSH logins')}`);
  log.blank();

  if (!resolved) {
    log.warn(`${bold(command)} is not on PATH in this shell, so the snippet may never fire.`);
    log.hint('Install it globally, or pass --command with an absolute path.');
    log.blank();
  }

  log.raw(box([
    `${c.muted('This edits the file your login shell reads. You cannot lock yourself out:')}`,
    `${c.bold('ssh user@host bash')} ${c.muted('bypasses it and always gives you a plain shell.')}`,
    '',
    fg(P.warn, `${S.warn} Test it from a second session before closing this one.`),
  ], { title: 'before you say yes', color: P.warn }));
  log.blank();

  if (!ctx.yes && !(await confirm('  Add it?', { def: true }))) return cancelled();

  const existing = await readOr(target);
  const next = withSnippet(existing, snippet);
  if (next === existing) {
    log.ok('Already set up exactly like that, nothing to change.');
    log.blank();
    return 0;
  }

  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, next, 'utf8');
    // profile.d entries are sourced, not executed, but a non-readable one is
    // silently skipped, so make sure everyone can read it.
    if (system) await fs.chmod(target, 0o644);
  } catch (e: any) {
    log.blank();
    log.fail(`Could not write ${target}: ${e?.message || e}`);
    if (e?.code === 'EACCES' || e?.code === 'EPERM') {
      log.hint(`Re-run it with sudo: sudo blankey autostart enable${system ? ' --system' : ''}`);
    }
    log.blank();
    return 1;
  }

  log.blank();
  log.ok(`Written to ${bold(target)}`);
  log.blank();
  log.raw(box([
    `${c.bold('1.')} ${c.muted('Leave this session open.')}`,
    `${c.bold('2.')} ${c.muted('Open a second one:')} ${c.bold('ssh user@host')}`,
    `${c.bold('3.')} ${c.muted('blankey should appear. If it does not, you still have this session.')}`,
    '',
    `${c.muted('Undo:')} ${c.bold('blankey autostart disable' + (system ? ' --system' : ''))}`,
  ], { title: 'check it worked' }));
  log.blank();
  return 0;
}

async function disableCmd(ctx, family: ShellFamily): Promise<number> {
  const found = await installedAt();
  if (!found.length) {
    log.blank();
    log.raw(`  ${c.faint(S.ring)} ${c.muted('It was not enabled anywhere.')}`);
    log.blank();
    return 0;
  }

  log.blank();
  log.raw(`  ${c.muted('Removing the blankey block from:')}`);
  for (const file of found) log.item(file);
  log.blank();
  if (!ctx.yes && !(await confirm('  Remove it?', { def: true }))) return cancelled();

  let failed = 0;
  for (const file of found) {
    const existing = await readOr(file);
    const next = withoutSnippet(existing);
    try {
      // A file that exists only to hold the snippet is removed outright rather
      // than left behind empty.
      if (!next.trim() && (file === SYSTEM_POSIX || file === SYSTEM_FISH || file.includes('conf.d'))) {
        await fs.rm(file, { force: true });
      } else {
        await fs.writeFile(file, next, 'utf8');
      }
      log.ok(`Cleaned ${file}`);
    } catch (e: any) {
      failed++;
      log.fail(`Could not edit ${file}: ${e?.message || e}`);
      if (e?.code === 'EACCES' || e?.code === 'EPERM') {
        log.hint('Re-run it with sudo: sudo blankey autostart disable');
      }
    }
  }
  log.blank();
  if (!failed) log.raw(`  ${c.muted('Logging in gives you a normal shell again.')}`);
  log.blank();
  return failed ? 1 : 0;
}
