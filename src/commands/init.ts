
import path from 'node:path';
import fs from 'node:fs/promises';
import process from 'node:process';
import { log } from '../ui/log.js';
import { c, bold } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { ask, confirm, select, isTTY } from '../ui/prompt.js';
import { box, banner, rule } from '../ui/box.js';
import { Spinner } from '../ui/spinner.js';
import * as host from '../host.js';
import * as docker from '../docker.js';
import { mainConfig, repoConfig, exampleService } from '../templates.js';
import { DEFAULTS, expandHome, defaultConfigPath, findExistingConfig } from '../config.js';

export const init = {
  name: 'init',
  group: 'Setup',
  describe: 'Create a blankey config, and optionally scaffold Traefik',
  usage: 'init [--projects-dir <dir>] [--domain <domain>] [--force]',
  needsConfig: false,
  valueFlags: ['projectsDir', 'domain', 'email', 'network', 'output'],
  options: [
    ['    --projects-dir <dir>', 'folder that holds one directory per repo'],
    ['    --domain <domain>', 'base domain for routes and the dashboard'],
    ['    --email <address>', 'ACME email, enables Let\'s Encrypt certificates'],
    ['    --network <name>', 'shared proxy network name (default proxy)'],
    ['    --output <file>', 'where to write the config'],
    ['    --force', 'overwrite an existing config'],
  ],
  examples: [
    ['blankey init', 'interactive setup'],
    ['blankey init --projects-dir /srv/apps --domain example.com --email me@example.com -y', 'unattended'],
  ],
  async run(ctx) {
    const interactive = isTTY() && !ctx.yes;
    log.raw(banner('first-time setup'));
    log.blank();

    const existing = await findExistingConfig();
    if (existing && !ctx.flags.force) {
      log.warn(`A config already exists at ${bold(existing)}`);
      if (!interactive) {
        log.hint('Re-run with --force to overwrite it.');
        return 1;
      }
      if (!(await confirm('Overwrite it?', { def: false }))) {
        log.raw(c.faint('  keeping the existing config'));
        return 0;
      }
    }

    const answers: Record<string, any> = {
      projectsDir: String(ctx.flags.projectsDir || DEFAULTS.projectsDir),
      domain: String(ctx.flags.domain || ''),
      acmeEmail: String(ctx.flags.email || ''),
      network: String(ctx.flags.network || 'proxy'),
      image: DEFAULTS.traefik.image,
      dashboard: true,
      sshHost: ctx.flags.host ? String(ctx.flags.host) : '',
    };

    if (interactive) {
      answers.projectsDir = await ask('Where do your repos live?', { def: answers.projectsDir });
      answers.domain = await ask('Base domain (blank to skip)', { def: answers.domain });
      answers.acmeEmail = await ask('Email for Let\'s Encrypt certificates (blank to skip)', { def: answers.acmeEmail });
      answers.network = await ask('Shared proxy network name', { def: answers.network });
      answers.dashboard = await confirm('Expose the Traefik dashboard?', { def: true });
    }

    answers.projectsDir = expandHome(answers.projectsDir);
    answers.traefikDir = host.join(answers.projectsDir, '.blankey', 'traefik');
    if (answers.dashboard && answers.domain) answers.dashboardHost = `traefik.${answers.domain}`;

    const outPath = ctx.flags.output
      ? expandHome(String(ctx.flags.output))
      : interactive
        ? await select('Where should the config live?', [
            { label: `${defaultConfigPath()}`, value: defaultConfigPath(), hint: 'per-user, works from anywhere' },
            { label: path.resolve(process.cwd(), 'blankey.yml'), value: path.resolve(process.cwd(), 'blankey.yml'), hint: 'this directory only' },
            { label: '/etc/blankey/config.yml', value: '/etc/blankey/config.yml', hint: 'system wide, needs root' },
          ])
        : defaultConfigPath();

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, mainConfig(answers), 'utf8');
    log.blank();
    log.ok(`Config written to ${bold(outPath)}`);

    // Everything below touches the Docker host, so honour --host / ssh config.
    if (answers.sshHost) host.useRemote({ host: answers.sshHost });

    const dirExists = await host.exists(answers.projectsDir);
    if (!dirExists) {
      const make = ctx.yes || !interactive
        ? true
        : await confirm(`${answers.projectsDir} does not exist. Create it?`, { def: true });
      if (make) {
        await host.mkdirp(answers.projectsDir);
        log.ok(`Created ${answers.projectsDir}`);
      }
    }

    const info = await docker.dockerInfo();
    if (!info.ok) {
      log.blank();
      log.warn('Docker is not reachable from here, so the proxy was not set up.');
      log.hint('Fix Docker access, then run: blankey traefik init');
    } else {
      const setupProxy = ctx.yes || !interactive
        ? true
        : await confirm('Scaffold the Traefik proxy now?', { def: true });
      if (setupProxy) {
        const { loadConfig } = await import('../config.js');
        const cfg = await loadConfig({ file: outPath });
        const traefik: any = (await import('./traefik.js')).default;
        await traefik.run({ ...ctx, cfg, positional: ['init'], flags: { ...ctx.flags } });
      }
    }

    log.raw(rule('you are set up'));
    log.blank();
    log.raw(box([
      `${c.bold('blankey status')}          ${c.muted('see every stack at a glance')}`,
      `${c.bold('blankey ls -l')}           ${c.muted('what was discovered, in detail')}`,
      `${c.bold('blankey deploy <name>')}   ${c.muted('pull, rebuild, restart, verify')}`,
      `${c.bold('blankey doctor')}          ${c.muted('check for problems before they bite')}`,
    ], { title: 'try next' }));
    log.blank();
    return 0;
  },
};

export const adopt = {
  name: 'adopt',
  group: 'Setup',
  describe: 'Write a .blankey.yml into a repo to pin its stacks and hooks',
  usage: 'adopt <project> [--force]',
  options: [['    --force', 'overwrite an existing .blankey.yml']],
  async run(ctx) {
    const project = await ctx.project(ctx.positional[0]);
    const target = host.join(project.dir, '.blankey.yml');
    if ((await host.exists(target)) && !ctx.flags.force) {
      log.warn(`${target} already exists. Use --force to replace it.`);
      return 1;
    }
    await host.writeFile(target, repoConfig(project));
    log.blank();
    log.ok(`Wrote ${bold(target)}`);
    log.raw(`  ${c.muted('Stacks detected:')} ${project.stacks.map((s) => c.bold(s.name)).join(', ')}`);
    log.hint('Edit it to set a healthcheck URL, deploy hooks or explicit file lists.');
    log.blank();
    return 0;
  },
};

export const create = {
  name: 'new',
  group: 'Setup',
  describe: 'Create a new project folder wired into the proxy',
  usage: 'new <name> [--clone <git-url>] [--identity <name>]',
  valueFlags: ['clone', 'identity'],
  options: [
    ['    --clone <url>', 'clone a repository instead of scaffolding a compose file'],
    ['    --identity <name>', 'clone using a saved SSH identity (blankey ssh-identities)'],
  ],
  examples: [['blankey new landing --clone git@github.com:me/landing.git', 'clone and wire it up']],
  async run(ctx) {
    const name = ctx.positional[0];
    if (!name) {
      log.fail('Give the project a name.');
      return 1;
    }
    const dir = host.join(ctx.cfg.projectsDir, name);
    if (await host.exists(dir)) {
      log.fail(`${dir} already exists.`);
      return 1;
    }

    if (ctx.flags.clone) {
      const git = await import('../git.js');
      let sshCommand: string | undefined;
      if (ctx.flags.identity) {
        const { getIdentity, sshCommandFor } = await import('../ssh-identities.js');
        const identity = await getIdentity(ctx.cfg, String(ctx.flags.identity));
        if (!identity || !identity.hasFiles) {
          log.fail(`No SSH identity named "${ctx.flags.identity}"`);
          log.hint('Set one up first: Settings ' + S.chevron + ' SSH identities, in the interactive menu.');
          return 1;
        }
        sshCommand = sshCommandFor(ctx.cfg, identity.name);
      }
      const sp = new Spinner(`cloning ${c.faint(String(ctx.flags.clone))}`).start();
      const r = await git.clone(String(ctx.flags.clone), dir, { sshCommand });
      if (!r.ok) {
        sp.fail(r.error || 'clone failed');
        return 1;
      }
      if (sshCommand) await git.setSshIdentity(dir, sshCommand);
      sp.succeed(`cloned into ${dir}`);
    } else {
      await host.mkdirp(dir);
      await host.writeFile(host.join(dir, 'docker-compose.yml'), exampleService(ctx.cfg, name));
      log.blank();
      log.ok(`Created ${bold(dir)} with a compose file already on the ${ctx.cfg.traefik.network} network`);
    }

    log.blank();
    log.hint(`blankey up ${name}   ${S.bullet}   blankey info ${name}`);
    log.blank();
    return 0;
  },
};

