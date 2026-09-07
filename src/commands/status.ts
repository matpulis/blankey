import { table } from '../ui/table.js';
import { log } from '../ui/log.js';
import { c, P, fg, gradient, bold, strip } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { termWidth, meter } from '../ui/box.js';
import { Spinner } from '../ui/spinner.js';
import { stackCell, stateDot, stateText, ratio, gitCell, commitCell, urlCell } from '../ui/render.js';
import * as docker from '../docker.js';
import * as git from '../git.js';
import * as host from '../host.js';
import { filterProjects } from '../discover.js';
import { pMap, groupBy, relTime, lines, firstLine } from '../util.js';
import { readState } from '../state.js';

export default {
  name: 'status',
  aliases: ['st'],
  group: 'Monitor',
  describe: 'Live health of every stack: containers, git drift and routes',
  usage: 'status [project] [--no-git] [--fetch] [--json]',
  options: [
    ['    --fetch', 'git fetch first so behind/ahead counts are current'],
    ['    --no-git', 'skip git inspection (faster)'],
    ['    --stopped', 'only show stacks that are not fully running'],
    ['    --json', 'machine-readable output'],
  ],
  examples: [
    ['blankey status', 'the whole fleet at a glance'],
    ['blankey status --fetch', 'refresh remotes, then show what is behind'],
  ],
  async run(ctx) {
    const spinner = ctx.json ? null : new Spinner('scanning projects').start();
    const projects = await ctx.projects();
    const filter = ctx.positional[0];
    const list = filterProjects(projects, filter);

    spinner?.update('querying docker');
    const [containers, info, traefikState] = await Promise.all([
      docker.listAllContainers(),
      docker.dockerInfo(),
      traefikSummary(ctx.cfg),
    ]);

    const byProject = groupBy(containers, (ct) => ct.project);
    const withGit = ctx.flags.git !== false;

    let gitInfo = new Map();
    if (withGit) {
      spinner?.update(ctx.flags.fetch ? 'fetching git remotes' : 'reading git state');
      const results = await pMap<[string, any]>(list, async (p: any): Promise<[string, any]> => {
        if (!p.isGit) return [p.name, null];
        if (ctx.flags.fetch) await git.fetch(p.dir);
        return [p.name, await git.status(p.dir)];
      }, ctx.flags.fetch ? 4 : 8);
      gitInfo = new Map(results);
    }

    const state = await readState(ctx.cfg);
    const lastDeploy = new Map();
    for (const d of state.deploys) {
      const key = `${d.project}:${d.stack}`;
      if (!lastDeploy.has(key)) lastDeploy.set(key, d);
    }

    const rows: any[] = [];
    for (const p of list) {
      for (const s of p.stacks) {
        rows.push({
          project: p,
          stack: s,
          summary: docker.summarizeStack(byProject.get(s.projectName) || [], s),
          git: gitInfo.get(p.name) || null,
          deploy: lastDeploy.get(`${p.name}:${s.name}`) || null,
        });
      }
    }

    spinner?.stop(null);

    if (ctx.json) {
      log.raw(JSON.stringify({
        docker: info,
        traefik: traefikState,
        stacks: rows.map((r) => ({
          project: r.project.name,
          stack: r.stack.name,
          projectName: r.stack.projectName,
          state: r.summary.state,
          running: r.summary.running,
          total: r.summary.total,
          unhealthy: r.summary.unhealthy,
          urls: r.stack.routes.flatMap((x) => x.urls),
          git: r.git,
          lastDeploy: r.deploy,
        })),
      }, null, 2));
      return 0;
    }

    if (!info.ok) {
      log.blank();
      log.fail(`Docker is not reachable${host.isRemote() ? ' on ' + host.remoteLabel() : ''}: ${c.faint(info.error || '')}`);
      log.hint('Run `blankey doctor` for a full diagnosis.');
      log.blank();
      return 2;
    }

    renderHeader(ctx, rows, info, traefikState);

    const visible = ctx.flags.stopped
      ? rows.filter((r) => r.summary.state !== 'running')
      : rows;

    if (!visible.length) {
      log.raw(`  ${c.ok(S.tick)} ${c.muted('Everything is running.')}`);
      log.blank();
      return 0;
    }

    log.raw(table(visible.map((r) => ({
      dot: stateDot(r.summary.state),
      name: stackCell(r.project, r.stack),
      state: stateText(r.summary.state),
      containers: ratio(r.summary.running, r.summary.total),
      health: healthFlags(r.summary),
      git: gitCell(r.git),
      commit: commitCell(r.git),
      deployed: r.deploy
        ? (isDrifted(r) ? fg(P.pink, relTime(r.deploy.at) + ' ' + S.star) : c.faint(relTime(r.deploy.at)))
        : c.faint('—'),
      urls: urlCell(r.stack.routes, { max: 1 }),
    })), [
      { key: 'dot', label: '', grow: false },
      { key: 'name', label: 'stack', min: 12 },
      { key: 'state', label: 'state', grow: false },
      { key: 'containers', label: 'up', align: 'right', grow: false },
      { key: 'health', label: '', grow: false },
      // Git columns only earn their space when git was actually inspected.
      ...(withGit ? [
        { key: 'git', label: 'git', min: 8 },
        // Wide enough that the sha plus some of the message always survives.
        { key: 'commit', label: 'commit', min: 18, max: 38 },
      ] : []),
      { key: 'deployed', label: 'deployed', align: 'right', grow: false },
      { key: 'urls', label: 'url', min: 12 },
    ]));
    log.blank();
    renderFooter(rows);
    return rows.some((r) => r.summary.state === 'unhealthy') ? 1 : 0;
  },
};

/**
 * True when the containers are running a one-shot build that the working tree
 * no longer reflects. Worth flagging, since the repo looks innocent.
 */
function isDrifted(row: any): boolean {
  const d = row.deploy;
  if (!d || !d.ok || !d.ephemeral || !d.deployedSha) return false;
  if (!row.git || !row.git.head) return true;
  return d.deployedSha !== row.git.head;
}

function healthFlags(summary: any) {
  const out: any[] = [];
  if (summary.unhealthy) out.push(fg(P.err, `${S.cross}${summary.unhealthy}`));
  if (summary.restarting) out.push(fg(P.warn, `${S.arrow}${summary.restarting}`));
  if (summary.starting) out.push(fg(P.info, `${S.clock}${summary.starting}`));
  return out.join(' ');
}

function renderHeader(ctx: any, rows: any[], info: any, traefik: any) {
  const running = rows.filter((r) => r.summary.state === 'running').length;
  const degraded = rows.filter((r) => ['partial', 'unhealthy', 'restarting'].includes(r.summary.state)).length;
  const stopped = rows.filter((r) => r.summary.state === 'stopped').length;
  const behind = rows.filter((r) => r.git && r.git.behind > 0).length;

  log.blank();
  const where = host.isRemote() ? host.remoteLabel() : 'local docker';
  log.raw(`  ${bold(gradient('blankey'))} ${c.faint(S.bullet)} ${c.muted(where)} ${c.faint(S.bullet)} ${c.faint('docker ' + (info.version || '?'))}`);

  const pieces = [
    `${fg(P.ok, S.dot)} ${bold(String(running))} ${c.muted('running')}`,
    degraded ? `${fg(P.warn, S.dot)} ${bold(String(degraded))} ${c.muted('degraded')}` : '',
    stopped ? `${fg(P.faint, S.ring)} ${bold(String(stopped))} ${c.muted('stopped')}` : '',
    behind ? `${fg(P.info, S.down)} ${bold(String(behind))} ${c.muted('behind')}` : '',
    traefikLabel(traefik),
  ].filter(Boolean);
  log.raw('  ' + pieces.join(c.faint('   ')));
  log.raw('  ' + meter(running, Math.max(rows.length, 1), { size: Math.min(40, termWidth() - 6) }));
  log.blank();
}

function traefikLabel(traefik: any) {
  if (!traefik) return '';
  if (traefik.running) return `${fg(P.brand2, S.globe)} ${c.muted('traefik up')}`;
  if (traefik.present) return `${fg(P.err, S.globe)} ${c.muted('traefik down')}`;
  return `${fg(P.faint, S.globe)} ${c.faint('no traefik')}`;
}

function renderFooter(rows: any[]) {
  const uniqueRepos = (list: any[]): string[] => [...new Set(list.map((r) => r.project.name))];
  const behind = uniqueRepos(rows.filter((r) => r.git && r.git.behind > 0));
  const dirty = uniqueRepos(rows.filter((r) => r.git && r.git.dirty > 0));
  const bad = rows.filter((r) => ['unhealthy', 'partial', 'restarting'].includes(r.summary.state));
  const tips: any[] = [];
  if (behind.length) {
    tips.push(`${fg(P.info, S.down)} ${behind.length} repo(s) behind origin ${c.faint('blankey deploy --all --changed')}`);
  }
  if (dirty.length) {
    tips.push(`${fg(P.pink, S.bullet)} ${dirty.length} repo(s) with local changes ${c.faint('blankey info ' + dirty[0])}`);
  }
  if (bad.length) {
    const names = [...new Set(bad.map((r) => strip(stackCell(r.project, r.stack))))];
    tips.push(`${fg(P.err, S.cross)} ${names.join(', ')} need attention ${c.faint('blankey logs ' + bad[0].project.name)}`);
  }
  const drifted = rows.filter(isDrifted);
  if (drifted.length) {
    const names = [...new Set(drifted.map((r) => strip(stackCell(r.project, r.stack))))];
    tips.push(`${fg(P.pink, S.star)} ${names.join(', ')} running a one-shot build, not the working tree ` +
      c.faint('blankey deploy ' + drifted[0].project.name));
  }
  for (const t of tips) log.raw('  ' + t);
  if (tips.length) log.blank();
}

async function traefikSummary(cfg: any): Promise<any> {
  const dir = cfg.traefik?.dir;
  if (!dir) return null;
  const present = await host.exists(dir);
  const containers = await host.exec(
    'docker ps --filter label=blankey.role=traefik --format "{{.Names}}|{{.Status}}"',
    { timeout: 15000 },
  );
  const labelled = containers.code === 0 ? lines(containers.stdout)[0] : null;
  if (labelled) {
    const [name, status] = labelled.split('|');
    return { present: true, running: true, name, status };
  }
  // No blankey label: an existing proxy someone else set up still counts as one.
  const unlabelled = await host.exec('docker ps --filter ancestor=traefik --format "{{.Names}}"', { timeout: 15000 });
  if (unlabelled.code === 0 && unlabelled.stdout.trim()) {
    return { present: true, running: true, name: firstLine(unlabelled.stdout), status: 'running' };
  }
  return { present, running: false };
}

