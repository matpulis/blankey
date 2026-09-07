import process from 'node:process';
import { log, cancelled } from '../ui/log.js';
import { c, P, fg, bold } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { Spinner } from '../ui/spinner.js';
import { confirm } from '../ui/prompt.js';
import { stackLabel } from '../context.js';
import { containerDot, containerRow, CONTAINER_COLUMNS } from '../ui/render.js';
import { table } from '../ui/table.js';
import * as docker from '../docker.js';
import * as host from '../host.js';
import { pMap, bytes, firstLine } from '../util.js';

/** Run one compose subcommand across every selected stack, with a live spinner. */
async function forEachStack(ctx, action, { verb, args, confirmMsg, concurrency = 3 }: any = {}) {
  const targets = await ctx.targets(ctx.positional, { stackFlag: ctx.flags.stack, all: ctx.flags.all });
  if (!targets.length) {
    log.warn('Nothing to do.');
    return 0;
  }

  if (confirmMsg && !ctx.yes) {
    log.blank();
    for (const t of targets) log.item(stackLabel(t.project, t.stack));
    log.blank();
    const ok = await confirm(`${confirmMsg} ${c.bold(String(targets.length))} stack(s)?`, { def: false });
    if (!ok) return cancelled();
  }

  log.blank();
  let failed = 0;
  await pMap(targets, async ({ project, stack }) => {
    const label = stackLabel(project, stack);
    const sp = new Spinner(`${c.muted(verb)} ${label}`).start();
    const r = await docker.composeStream(stack, `${action} ${args || ''}`.trim(), {
      onLine: (line) => {
        const t = line.trim();
        if (t) sp.update(`${c.muted(verb)} ${label} ${c.faint(t.slice(0, 60))}`);
      },
    });
    if (r.code === 0) sp.succeed(`${label} ${c.faint(verb + ' ok')}`);
    else {
      failed++;
      sp.fail(`${label} ${c.faint('failed')}`);
      for (const line of r.tail.slice(-6)) log.raw('    ' + c.faint(line));
    }
  }, targets.length > 1 ? concurrency : 1);

  log.blank();
  return failed ? 1 : 0;
}

const targetOptions = [
  ['-s, --stack <name>', 'target a specific stack'],
  ['-a, --all', 'apply to every discovered project'],
  ['-y, --yes', 'do not ask for confirmation'],
];

export const up = {
  name: 'up',
  group: 'Lifecycle',
  describe: 'Start a stack (docker compose up -d)',
  usage: 'up [project[:stack]...] [--all] [--build] [--force-recreate]',
  valueFlags: ['stack'],
  options: [
    ...targetOptions,
    ['    --build', 'build images before starting'],
    ['    --force-recreate', 'recreate containers even if config is unchanged'],
    ['    --no-orphans', 'keep containers that are no longer in the compose file'],
  ],
  examples: [['blankey up shop-api', 'start the default stack of one repo']],
  run(ctx) {
    const extra = [
      '-d',
      ctx.flags.build ? '--build' : '',
      ctx.flags.forceRecreate ? '--force-recreate' : '',
      ctx.flags.orphans === false ? '' : '--remove-orphans',
      ...ctx.passthrough,
    ].filter(Boolean).join(' ');
    return forEachStack(ctx, 'up', { verb: 'starting', args: extra });
  },
};

export const down = {
  name: 'down',
  group: 'Lifecycle',
  describe: 'Stop and remove a stack',
  usage: 'down [project[:stack]...] [--all] [--volumes]',
  valueFlags: ['stack'],
  options: [...targetOptions, ['    --volumes', 'also remove named volumes (destructive)']],
  run(ctx) {
    const extra = [ctx.flags.volumes ? '--volumes' : '', ...ctx.passthrough].filter(Boolean).join(' ');
    return forEachStack(ctx, 'down', {
      verb: 'stopping',
      args: extra,
      confirmMsg: ctx.flags.volumes ? c.err('Remove volumes and tear down') : 'Tear down',
    });
  },
};

export const restart = {
  name: 'restart',
  group: 'Lifecycle',
  describe: 'Restart the containers of a stack',
  usage: 'restart [project[:stack]...] [--all]',
  valueFlags: ['stack'],
  options: targetOptions,
  run(ctx) {
    return forEachStack(ctx, 'restart', { verb: 'restarting', args: ctx.passthrough.join(' ') });
  },
};

export const stop = {
  name: 'stop',
  group: 'Lifecycle',
  describe: 'Stop containers without removing them',
  usage: 'stop [project[:stack]...] [--all]',
  valueFlags: ['stack'],
  options: targetOptions,
  run(ctx) {
    return forEachStack(ctx, 'stop', { verb: 'stopping', args: ctx.passthrough.join(' ') });
  },
};

export const start = {
  name: 'start',
  group: 'Lifecycle',
  describe: 'Start previously stopped containers',
  usage: 'start [project[:stack]...] [--all]',
  valueFlags: ['stack'],
  options: targetOptions,
  run(ctx) {
    return forEachStack(ctx, 'start', { verb: 'starting', args: ctx.passthrough.join(' ') });
  },
};

export const ps = {
  name: 'ps',
  group: 'Lifecycle',
  describe: 'Show containers, grouped by repo when no project is named',
  usage: 'ps [project[:stack]] [--all] [--json]',
  valueFlags: ['stack'],
  options: [
    ['-s, --stack <name>', 'target a specific stack'],
    ['-a, --all', 'include stopped containers in the grouped view'],
  ],
  examples: [
    ['blankey ps', 'every container on the host, grouped by repo'],
    ['blankey ps shop-api', 'just one stack'],
  ],
  async run(ctx) {
    if (!ctx.positional[0]) return psAll(ctx);
    const { project, stack } = await ctx.target(ctx.positional[0], { stackFlag: ctx.flags.stack });
    const containers = await docker.stackPs(stack);
    if (ctx.json) {
      log.raw(JSON.stringify(containers, null, 2));
      return 0;
    }
    log.blank();
    log.raw(`  ${c.bold(stackLabel(project, stack))}  ${c.faint(stack.dir)}`);
    log.blank();
    if (!containers.length) {
      log.raw(`  ${c.faint('no containers')} ${c.faint(S.arrow)} ${c.muted('blankey up ' + project.name)}`);
      log.blank();
      return 0;
    }
    log.raw(table(containers.map(containerRow), CONTAINER_COLUMNS));
    log.blank();
    return 0;
  },
};

export const logs = {
  name: 'logs',
  aliases: ['log'],
  group: 'Lifecycle',
  describe: 'Stream logs live from a stack or a single container',
  usage: 'logs [project[:stack]] [service] [--no-follow] [--clear]',
  valueFlags: ['stack', 'tail', 'since'],
  flagAliases: { n: 'tail', t: 'timestamps' },
  options: [
    ['    --no-follow', 'print what is there and exit instead of streaming'],
    ['-n, --tail <n>', 'lines of history to show first (default 120, "all" for everything)'],
    ['-t, --timestamps', 'prefix every line with its timestamp'],
    ['    --since <time>', 'only logs newer than e.g. 10m, 2h'],
    ['    --clear', 'empty the log file instead of reading it'],
    ['-y, --yes', 'skip the confirmation when clearing'],
  ],
  details:
    'Logs stream live by default: the last lines are printed, then new ones appear\n' +
    'as they are written. Ctrl+C stops. With no target it lists every container\n' +
    'grouped by repo and lets you pick one, stopped containers included.',
  examples: [
    ['blankey logs', 'pick a container and watch it live'],
    ['blankey logs shop-api', 'every service in the stack, interleaved'],
    ['blankey logs shop-api api --no-follow -n 500', 'the last 500 lines, then exit'],
    ['blankey logs shop-api api --clear', 'empty that container log file'],
  ],
  async run(ctx) {
    if (ctx.flags.clear) return clearLogs(ctx);

    // Live is the default: --no-follow sets this to false.
    const follow = ctx.flags.follow !== false;
    const tail = ctx.flags.tail === 'all' ? 'all' : String(Number(ctx.flags.tail) || 120);
    const common = [
      follow ? '-f' : '',
      `--tail ${tail}`,
      ctx.flags.timestamps ? '-t' : '',
      ctx.flags.since ? `--since ${ctx.flags.since}` : '',
    ].filter(Boolean);

    if (!ctx.positional[0]) {
      const picked = await pickContainer(ctx, 'Which container?', { running: false });
      if (!picked) {
        return cancelled();
      }
      header(`${picked.project || 'docker'} ${S.arrow} ${picked.service || picked.name}`, follow);
      return host.interactive(`docker logs ${common.join(' ')} ${docker.q(picked.name)}`);
    }

    const { project, stack } = await ctx.target(ctx.positional[0], { stackFlag: ctx.flags.stack });
    const service = ctx.positional[1];
    const args = ['logs', ...common, service ? docker.q(service) : '', ...ctx.passthrough]
      .filter(Boolean).join(' ');
    header(`${stackLabel(project, stack)}${service ? ' ' + S.arrow + ' ' + service : ''}`, follow);
    return docker.composeInteractive(stack, args);
  },
};

function header(what, follow) {
  log.raw(`  ${c.brand(S.chevron)} ${bold(what)}` +
    (follow ? c.faint(`   live, ctrl+c to stop`) : '') + '\n');
}

/**
 * Empty the log files of one container or of every container in a stack.
 * Docker has no command for this, so the file is truncated in place: it keeps
 * the open file handle, which is why truncating is safe and deleting is not.
 */
async function clearLogs(ctx) {
  let containers;
  let what;

  if (!ctx.positional[0]) {
    const picked = await pickContainer(ctx, 'Clear the logs of which container?', { running: false });
    if (!picked) {
      return cancelled();
    }
    containers = [picked];
    what = picked.service || picked.name;
  } else {
    const { project, stack } = await ctx.target(ctx.positional[0], { stackFlag: ctx.flags.stack });
    const service = ctx.positional[1];
    const all = await docker.stackPs(stack);
    containers = service ? all.filter((ct) => ct.service === service) : all;
    what = stackLabel(project, stack) + (service ? ' ' + S.arrow + ' ' + service : '');
    if (!containers.length) {
      log.blank();
      log.warn(service ? `No container for service ${service}.` : 'No containers in that stack.');
      log.blank();
      return 1;
    }
  }

  log.blank();
  log.raw(`  ${c.warn(S.warn)} About to empty the log file of ${bold(String(containers.length))} container(s) in ${bold(what)}`);
  for (const ct of containers) log.raw(`    ${c.faint(S.bullet)} ${c.muted(ct.name)}`);
  log.raw(`  ${c.faint('This cannot be undone. Running containers keep logging normally afterwards.')}`);
  log.blank();
  if (!ctx.yes && !(await confirm('  Continue?', { def: false }))) {
    return cancelled();
  }

  let failed = 0;
  let reclaimed = 0;
  for (const ct of containers) {
    const sp = new Spinner(`${c.muted('clearing')} ${ct.name}`).start();
    const r = await docker.clearContainerLogs(ct.name);
    if (r.ok) {
      reclaimed += r.cleared || 0;
      sp.succeed(`${bold(ct.service || ct.name)} ${c.faint('cleared ' + (r.cleared ? bytes(r.cleared) : '') + (r.sudo ? ' (via sudo)' : ''))}`);
    } else if (r.reason === 'unsupported') {
      failed++;
      sp.warn(`${bold(ct.service || ct.name)} ${c.warn('log files live on the Docker host, which is not reachable from Windows')}`);
      log.raw(`    ${c.faint('Run blankey on the Linux host, or point it there with --host user@server.')}`);
    } else if (r.reason === 'driver') {
      failed++;
      sp.warn(`${bold(ct.service || ct.name)} ${c.warn(`uses the ${r.driver || 'unknown'} log driver, which has no file to clear`)}`);
    } else if (r.reason === 'permission') {
      failed++;
      sp.fail(`${bold(ct.service || ct.name)} ${c.err('permission denied')}`);
      log.raw(`    ${c.faint(firstLine(r.detail || ''))}`);
      log.raw(`    ${c.faint('Run blankey as root on the Docker host, or allow passwordless sudo.')}`);
    } else {
      failed++;
      sp.fail(`${bold(ct.service || ct.name)} ${c.err(firstLine(r.detail || 'could not clear'))}`);
    }
  }

  log.blank();
  if (reclaimed) log.ok(`Reclaimed ${bold(bytes(reclaimed))} of log data.`);
  if (failed) {
    log.hint('Recreating a container always starts a fresh log: blankey up <project> --force-recreate');
  }
  log.blank();
  return failed ? 1 : 0;
}

/** Every container on the host, grouped under the repo that owns it. */
async function psAll(ctx) {
  const [containers, projects] = await Promise.all([
    docker.listAllContainers(),
    ctx.projects().catch(() => []),
  ]);
  // "Not stopped" rather than "running": a container stuck restarting is
  // exactly the one you opened this view to find.
  const visible = ctx.flags.all
    ? containers
    : containers.filter((ct) => !['exited', 'dead', 'created'].includes(ct.state));

  if (ctx.json) {
    log.raw(JSON.stringify(
      groupContainers(visible, projects).map(([repo, list]) => ({ repo, containers: list })),
      null, 2,
    ));
    return 0;
  }

  log.blank();
  if (!visible.length) {
    log.raw(`  ${c.faint(ctx.flags.all ? 'no containers on this host' : 'no running containers')}`);
    log.blank();
    return 0;
  }

  const groups = groupContainers(visible, projects);
  const known = new Set(projects.map((p) => p.name));
  for (const [repo, list] of groups) {
    const running = list.filter((ct) => ct.state === 'running').length;
    const title = known.has(repo) ? bold(fg(P.brand2, repo)) : bold(c.muted(repo));
    log.raw(`  ${title} ${c.faint(`${running}/${list.length} up`)}` +
      (known.has(repo) ? '' : c.faint('  not a blankey project')));
    log.raw(table(
      list.map(containerRow),
      CONTAINER_COLUMNS.map((col) => ({ ...col, label: '' })),
      { head: false, indent: 4 },
    ));
    log.blank();
  }
  log.raw(`  ${c.faint(`${visible.length} container(s) in ${groups.length} group(s)`)}   ${c.faint('blankey sh  to shell into one')}`);
  log.blank();
  return 0;
}

// Prefer bash when the image has it, fall back to sh, without failing if neither
// exists in a distroless container.
const SHELL_CMD = 'sh -c "command -v bash >/dev/null && exec bash || exec sh"';

export const exec = {
  name: 'exec',
  aliases: ['sh'],
  group: 'Lifecycle',
  describe: 'Open a shell (or run a command) inside a running container',
  usage: 'exec [project[:stack]] [service] [-- command...]',
  valueFlags: ['stack'],
  options: [
    ['-s, --stack <name>', 'target a specific stack'],
    ['    --root', 'run as root'],
  ],
  details:
    'With no arguments it lists every running container on the host grouped by\n' +
    'repo, including ones outside your projects, and lets you pick one. Naming a\n' +
    'project and service goes straight in.',
  examples: [
    ['blankey sh', 'pick a container from the whole host'],
    ['blankey sh shop-api api', 'shell into the api container'],
    ['blankey exec shop-api db -- psql -U postgres', 'run a command instead'],
  ],
  async run(ctx) {
    const cmd = ctx.passthrough.length ? ctx.passthrough.map(docker.q).join(' ') : SHELL_CMD;
    const user = ctx.flags.root ? '--user root ' : '';

    // No target named: pick a live container out of the whole host.
    if (!ctx.positional[0]) {
      const picked = await pickContainer(ctx, 'Which container?');
      if (!picked) {
        return cancelled();
      }
      log.raw(c.faint(`  ${S.chevron} ${picked.project || 'docker'} ${S.arrow} ${picked.service || picked.name}\n`));
      // The picker chose one exact container, so address it directly rather
      // than letting compose pick a replica for us.
      const tty = process.stdin.isTTY ? '-it' : '-i';
      return host.interactive(`docker exec ${tty} ${user}${docker.q(picked.name)} ${cmd}`);
    }

    const { project, stack } = await ctx.target(ctx.positional[0], { stackFlag: ctx.flags.stack });
    let service = ctx.positional[1];
    if (!service) {
      if (stack.services.length === 1) service = stack.services[0].name;
      else {
        const { select } = await import('../ui/prompt.js');
        service = await select('Which service?', stack.services.map((s) => ({
          label: s.name,
          value: s.name,
          hint: s.image || (s.build ? 'built locally' : ''),
        })));
      }
    }
    if (!service) {
      return cancelled();
    }
    log.raw(c.faint(`  ${S.chevron} ${stackLabel(project, stack)} ${S.arrow} ${service}\n`));
    return docker.composeInteractive(stack, `exec ${user}${docker.q(service)} ${cmd}`);
  },
};

/**
 * Group containers by the repo they belong to and let the user pick one.
 * Containers whose compose project matches no known repo are grouped last, so
 * things like the proxy stay reachable.
 *
 * `running: false` widens the list to stopped containers too, since you can still
 * read the logs of a container that died, which is usually when you want to.
 */
async function pickContainer(ctx, question, { running = true }: any = {}) {
  const { select } = await import('../ui/prompt.js');
  const [containers, projects] = await Promise.all([
    docker.listAllContainers(),
    ctx.projects().catch(() => []),
  ]);
  const candidates = running
    ? containers.filter((ct) => ct.state === 'running')
    : containers.filter((ct) => ct.state !== 'created');

  if (!candidates.length) {
    log.blank();
    log.warn(running ? 'No running containers on this host.' : 'No containers on this host.');
    log.blank();
    return null;
  }

  const groups = groupContainers(candidates, projects);
  const choices: any[] = [];
  for (const [title, list] of groups) {
    choices.push({ separator: title });
    for (const ct of list) {
      choices.push({
        label: `${containerDot(ct)} ${(ct.service || ct.name).padEnd(16)} ${c.faint(ct.name)}`,
        value: ct,
        hint: ct.state === 'running' ? ct.image : `${ct.state} ${S.bullet} ${ct.image}`,
      });
    }
  }
  log.blank();
  return select(question, choices);
}

/** Map compose project names back to the repos blankey knows about. */
export function groupContainers(containers: any[], projects: any[]): Array<[string, any[]]> {
  const owner = new Map();
  for (const p of projects) {
    for (const s of p.stacks) {
      if (!owner.has(s.projectName)) owner.set(s.projectName, p.name);
    }
  }
  const groups = new Map<string, any[]>();
  for (const ct of containers) {
    const repo = owner.get(ct.project) || ct.project || 'other';
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo)!.push(ct);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.service || a.name).localeCompare(b.service || b.name));
  }

  // Repos blankey knows about come first, then everything else on the host.
  const repos = new Set(owner.values());
  const byName = (a: [string, any[]], b: [string, any[]]) => a[0].localeCompare(b[0]);
  const entries = [...groups.entries()];
  return [
    ...entries.filter(([name]) => repos.has(name)).sort(byName),
    ...entries.filter(([name]) => !repos.has(name)).sort(byName),
  ];
}

export const run = {
  name: 'run',
  group: 'Lifecycle',
  describe: 'Pass raw arguments through to docker compose for a stack',
  usage: 'run <project[:stack]> -- <compose args...>',
  valueFlags: ['stack'],
  options: [['-s, --stack <name>', 'target a specific stack']],
  examples: [['blankey run shop-api -- config --services', 'anything compose can do']],
  async run(ctx) {
    const { project, stack } = await ctx.target(ctx.positional[0], { stackFlag: ctx.flags.stack });
    const args = [...ctx.positional.slice(1), ...ctx.passthrough];
    if (!args.length) {
      log.fail('Nothing to run.');
      log.hint('blankey run <project> -- ps --services');
      return 1;
    }
    log.raw(c.faint(`  ${S.chevron} ${stackLabel(project, stack)} ${S.arrow} compose ${args.join(' ')}\n`));
    return docker.composeInteractive(stack, args.join(' '));
  },
};

