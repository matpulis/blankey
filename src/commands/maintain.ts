import { log } from '../ui/log.js';
import { c, P, fg, bold } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { table } from '../ui/table.js';
import { box } from '../ui/box.js';
import { stackLabel } from '../context.js';
import * as host from '../host.js';

import { toYaml } from '../yaml.js';
import { renderConfig } from '../config.js';

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-?][^}]*)?\}/g;
const SECRET_RE = /(PASS|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE|DSN|AUTH)/i;

function parseEnvFile(text) {
  const out = new Map();
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

const mask = (key, value) => {
  if (!value) return c.faint('(empty)');
  if (SECRET_RE.test(key)) return c.faint(value.slice(0, 2) + '•'.repeat(Math.min(10, Math.max(3, value.length - 2))));
  return c.muted(value.length > 48 ? value.slice(0, 45) + '…' : value);
};

export const env = {
  name: 'env',
  group: 'Maintenance',
  describe: 'Inspect .env files and find variables a stack needs but does not have',
  usage: 'env <project[:stack]> [--show] [--set KEY=VALUE]',
  valueFlags: ['stack', 'set', 'file'],
  options: [
    ['-s, --stack <name>', 'target a specific stack'],
    ['    --show', 'print values instead of masking secrets'],
    ['    --set <k=v>', 'set a variable in the env file (creates it if needed)'],
    ['    --file <name>', 'use a specific env file (default .env)'],
  ],
  examples: [
    ['blankey env shop-api', 'see which variables are set and which are missing'],
    ['blankey env shop-api --set SENTRY_DSN=https://...', 'write one variable'],
  ],
  async run(ctx) {
    const { project, stack } = await ctx.target(ctx.positional[0], { stackFlag: ctx.flags.stack });
    const fileName = ctx.flags.file || stack.envFile || '.env';
    const envPath = host.join(stack.dir, fileName);

    if (ctx.flags.set) {
      const raw = String(ctx.flags.set);
      const eq = raw.indexOf('=');
      if (eq < 0) {
        log.fail('Use --set KEY=VALUE');
        return 1;
      }
      const key = raw.slice(0, eq).trim();
      const value = raw.slice(eq + 1);
      const existing = (await host.readFile(envPath)) || '';
      const lines = existing.split('\n');
      const idx = lines.findIndex((l) => l.trim().startsWith(key + '='));
      if (idx >= 0) lines[idx] = `${key}=${value}`;
      else {
        if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
        lines[lines.length - 1] = `${key}=${value}`;
        lines.push('');
      }
      await host.writeFile(envPath, lines.join('\n'));
      log.blank();
      log.ok(`${key} written to ${c.faint(envPath)}`);
      log.hint(`blankey deploy ${project.name} to apply it`);
      log.blank();
      return 0;
    }

    // Variables the compose files interpolate.
    const referenced = new Set();
    for (const f of stack.files) {
      const text = await host.readFile(host.join(stack.dir, f));
      for (const m of String(text || '').matchAll(VAR_RE)) referenced.add(m[1]);
    }

    const text = await host.readFile(envPath);
    const values = parseEnvFile(text);
    const missing = [...referenced].filter((k) => !values.has(k)).sort();
    const unused = [...values.keys()].filter((k) => !referenced.has(k)).sort();

    if (ctx.json) {
      log.raw(JSON.stringify({
        file: envPath, exists: text !== null,
        set: [...values.keys()], referenced: [...referenced], missing, unused,
      }, null, 2));
      return missing.length ? 1 : 0;
    }

    log.blank();
    log.raw(`  ${bold(stackLabel(project, stack))}  ${c.faint(envPath)}${text === null ? ' ' + c.warn('(missing)') : ''}`);
    log.blank();

    if (values.size) {
      log.raw(table([...values.entries()].map(([k, v]) => ({
        icon: referenced.has(k) ? c.ok(S.tick) : c.faint(S.ring),
        key: bold(k),
        value: ctx.flags.show ? c.muted(v) : mask(k, v),
        note: referenced.has(k) ? c.faint('used') : c.faint('not referenced'),
      })), [
        { key: 'icon', label: '', grow: false },
        { key: 'key', label: 'variable', min: 12 },
        { key: 'value', label: 'value', min: 10 },
        { key: 'note', label: '', grow: false },
      ]));
      log.blank();
    } else {
      log.raw(`  ${c.faint('no variables set')}`);
      log.blank();
    }

    if (missing.length) {
      log.raw(box(missing.map((k) => `${c.err(S.cross)} ${bold(k)} ${c.faint('referenced by ' + stack.files.join(', '))}`), {
        title: `${missing.length} missing variable(s)`, color: P.err,
      }));
      log.blank();
      log.hint(`blankey env ${project.name} --set ${missing[0]}=...`);
      log.blank();
      return 1;
    }
    if (referenced.size) log.raw(`  ${c.ok(S.tick)} ${c.muted('every interpolated variable is set')}`);
    if (unused.length) log.raw(`  ${c.faint(S.ring)} ${c.faint(unused.length + ' variable(s) not referenced by compose')}`);
    log.blank();
    return 0;
  },
};

export const configCmd = {
  name: 'config',
  group: 'Maintenance',
  describe: 'Show the resolved configuration and where it came from',
  usage: 'config [--json] [--path]',
  options: [
    ['    --path', 'print only the config file path'],
    ['    --json', 'emit the resolved config as JSON'],
  ],
  async run(ctx) {
    if (ctx.flags.path) {
      log.raw(ctx.cfg.__file);
      return 0;
    }
    const resolved = renderConfig(ctx.cfg);
    if (ctx.json) {
      log.raw(JSON.stringify(resolved, null, 2));
      return 0;
    }
    log.blank();
    log.raw(`  ${c.muted('loaded from')} ${bold(ctx.cfg.__file)}`);
    if (ctx.cfg.ssh?.host) log.raw(`  ${c.muted('target host')} ${fg(P.brand2, ctx.cfg.ssh.host)} ${c.faint('(over ssh)')}`);
    log.blank();
    for (const line of toYaml(resolved).split('\n')) {
      const m = /^(\s*)([A-Za-z0-9_.-]+):(.*)$/.exec(line);
      if (m) log.raw('  ' + m[1] + fg(P.brand2, m[2]) + c.faint(':') + c.muted(m[3]));
      else log.raw('  ' + c.muted(line));
    }
    log.blank();
    return 0;
  },
};

export const completion = {
  name: 'completion',
  group: 'Setup',
  describe: 'Print a shell completion script (bash, zsh or fish)',
  usage: 'completion [bash|zsh|fish]',
  needsConfig: false,
  details: 'Install with:  blankey completion bash > /etc/bash_completion.d/blankey',
  async run(ctx) {
    const shell = ctx.positional[0] || 'bash';
    const { commands } = await import('./index.js');
    const names = commands.filter((x) => !x.hidden).flatMap((x) => [x.name, ...(x.aliases || [])]).join(' ');
    if (shell === 'fish') {
      log.raw(`complete -c blankey -f -n "__fish_use_subcommand" -a "${names}"`);
      log.raw('complete -c blankey -f -n "not __fish_use_subcommand" -a "(blankey ls --json 2>/dev/null | grep -o \'\\"name\\": \\"[^\\"]*\\"\' | cut -d\'\\"\' -f4)"');
      return 0;
    }
    if (shell === 'zsh') {
      log.raw('#compdef blankey');
      log.raw('_blankey() {');
      log.raw(`  local -a cmds; cmds=(${names})`);
      log.raw('  if (( CURRENT == 2 )); then compadd -- $cmds; else');
      log.raw('    compadd -- ${(f)"$(blankey ls --json 2>/dev/null | sed -n \'s/.*"name": "\\([^"]*\\)".*/\\1/p\')"}');
      log.raw('  fi');
      log.raw('}');
      log.raw('compdef _blankey blankey');
      return 0;
    }
    log.raw('_blankey_complete() {');
    log.raw('  local cur prev');
    log.raw('  cur="${COMP_WORDS[COMP_CWORD]}"');
    log.raw(`  local cmds="${names}"`);
    log.raw('  if [ "$COMP_CWORD" -eq 1 ]; then');
    log.raw('    COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )');
    log.raw('  else');
    log.raw('    local projects="$(blankey ls --json 2>/dev/null | sed -n \'s/.*"name": "\\([^"]*\\)".*/\\1/p\' | sort -u)"');
    log.raw('    COMPREPLY=( $(compgen -W "$projects" -- "$cur") )');
    log.raw('  fi');
    log.raw('}');
    log.raw('complete -F _blankey_complete blankey bk');
    return 0;
  },
};

