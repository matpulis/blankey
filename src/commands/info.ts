import { log } from '../ui/log.js';
import { c, P, fg, bold } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { rule, kv, meter } from '../ui/box.js';
import { table } from '../ui/table.js';
import { Spinner } from '../ui/spinner.js';
import { stateBadge, gitCell, containerRow, CONTAINER_COLUMNS, shaChange } from '../ui/render.js';
import * as docker from '../docker.js';
import * as git from '../git.js';
import { historyFor, fillSubjects } from '../state.js';
import { relTime, duration, pMap, firstLine } from '../util.js';
import { httpProbe } from './deploy.js';

export const info = {
  name: 'info',
  aliases: ['show'],
  group: 'Monitor',
  describe: 'Everything about one project: stacks, containers, git, routes',
  usage: 'info <project[:stack]> [--json]',
  valueFlags: ['stack'],
  options: [['-s, --stack <name>', 'focus one stack']],
  async run(ctx) {
    const sp = ctx.json ? null : new Spinner('gathering').start();
    const project = await ctx.project(ctx.positional[0]);
    const focus = ctx.flags.stack ? project.stacks.filter((s) => s.name === ctx.flags.stack) : project.stacks;

    const [gitState, allContainers, history] = await Promise.all([
      project.isGit ? git.status(project.dir) : Promise.resolve(null),
      docker.listAllContainers(),
      historyFor(ctx.cfg, project.name, null),
    ]);

    const stacks = focus.map((s: any) => ({
      stack: s,
      containers: docker.containersFor(allContainers, s),
      summary: docker.summarizeStack(allContainers, s),
    }));

    // Older records only stored a sha; name the commit so the list is readable.
    if (project.isGit) await fillSubjects(history.slice(0, 5), () => project.dir);

    sp?.stop(null);

    if (ctx.json) {
      log.raw(JSON.stringify({
        name: project.name, dir: project.dir, git: gitState,
        stacks: stacks.map((x) => ({ ...x.stack, doc: undefined, containers: x.containers, summary: { ...x.summary, containers: undefined } })),
        history: history.slice(0, 5),
      }, null, 2));
      return 0;
    }

    log.blank();
    log.raw(`  ${bold(fg(P.brand2, project.name))}  ${c.faint(project.dir)}`);
    log.blank();

    const meta: any[] = [];
    if (gitState?.isRepo) {
      meta.push(['branch', gitCell(gitState)]);
      if (gitState.remote) meta.push(['remote', c.faint(gitState.remote)]);
      if (gitState.subject) {
        meta.push(['head', `${c.faint(gitState.head)} ${c.muted(gitState.subject)}`]);
        meta.push(['authored', c.faint(`${gitState.author || '?'} ${relTime(gitState.date)} ago`)]);
      }
    } else {
      meta.push(['git', c.faint('not a git repository')]);
    }
    if (project.envFiles.length) meta.push(['env files', c.muted(project.envFiles.join(', '))]);
    if (project.repoConfigFile) meta.push(['repo config', c.muted(project.repoConfigFile)]);
    if (Object.keys(project.hooks).length) {
      meta.push(['hooks', c.muted(Object.entries(project.hooks).map(([k, v]) => `${k}: ${v}`).join('  '))]);
    }
    log.raw(kv(meta).map((l) => '  ' + l).join('\n'));
    log.blank();

    for (const { stack, containers, summary } of stacks) {
      const star = stack.name === project.defaultStack ? fg(P.accent, ' ' + S.star) : '';
      log.raw(rule(`stack ${stack.name}`));
      log.blank();
      log.raw(`  ${stateBadge(summary.state)}${star}  ${c.muted(stack.files.join(' + '))}  ${c.faint('compose project ' + stack.projectName)}`);
      log.raw(`  ${meter(summary.running, summary.total || 1, { size: 20 })} ${c.muted(`${summary.running}/${summary.total} containers`)}`);
      log.blank();

      if (containers.length) {
        log.raw(table(containers.map(containerRow), CONTAINER_COLUMNS));
      } else {
        log.raw(`  ${c.faint('no containers running')}`);
      }
      log.blank();

      const declared = stack.services.filter((s) => !containers.some((ct) => ct.service === s.name));
      if (declared.length) {
        log.raw(`  ${c.muted('declared but not running')}  ${declared.map((s) => c.faint(s.name)).join(', ')}`);
        log.blank();
      }

      if (stack.routes.length) {
        for (const r of stack.routes) {
          const urls = r.urls.length ? r.urls.map((u) => fg(P.info, u)).join(', ') : c.faint(r.rule);
          log.raw(`  ${fg(P.brand2, S.globe)} ${bold(r.router)} ${S.arrow} ${urls}` +
            (r.port ? c.faint(` :${r.port}`) : '') +
            (r.certResolver ? c.faint(` [${r.certResolver}]`) : '') +
            (r.middlewares.length ? c.faint(` via ${r.middlewares.join(',')}`) : ''));
        }
        log.blank();
      }
      if (stack.volumes.length) {
        log.raw(`  ${c.muted('volumes')}  ${stack.volumes.map((v) => c.faint(v)).join(', ')}`);
        log.blank();
      }
    }

    if (history.length) {
      log.raw(rule('recent deploys'));
      log.blank();
      for (const d of history.slice(0, 5)) {
        const icon = d.ok ? c.ok(S.tick) : c.err(S.cross);
        log.raw(`  ${icon} ${c.faint(relTime(d.at).padStart(5))} ago  ${c.muted(d.stack)}  ${shaChange(d)}  ` +
          `${d.took ? c.faint(duration(d.took)) : ''}${d.error ? ' ' + c.err(firstLine(d.error, 40)) : ''}`);
        if (d.subject) log.raw(`      ${c.muted(d.subject)}`);
      }
      log.blank();
    }

    log.raw(`  ${c.faint('blankey deploy ' + project.name)}   ${c.faint('blankey logs ' + project.name + ' -f')}   ${c.faint('blankey sh ' + project.name)}`);
    log.blank();
    return 0;
  },
};

export const urls = {
  name: 'urls',
  aliases: ['routes'],
  group: 'Monitor',
  describe: 'Every hostname served across all projects, optionally probed',
  usage: 'urls [--check] [--json]',
  options: [
    ['    --check', 'request each URL from the Docker host and show the status'],
    ['    --json', 'machine-readable output'],
  ],
  examples: [['blankey urls --check', 'find the site that is quietly 502ing']],
  async run(ctx) {
    const projects = await ctx.projects();
    const rows: any[] = [];
    for (const p of projects) {
      for (const s of p.stacks) {
        for (const r of s.routes) {
          for (const url of (r.urls.length ? r.urls : [null])) {
            rows.push({ project: p, stack: s, route: r, url });
          }
        }
      }
    }

    if (!rows.length) {
      log.blank();
      log.warn('No Traefik routes found in any compose file.');
      log.hint('Add traefik.http.routers.<name>.rule labels to a service.');
      log.blank();
      return 0;
    }

    let probes = new Map();
    if (ctx.flags.check) {
      const sp = ctx.json ? null : new Spinner(`probing ${rows.length} url(s)`).start();
      const results = await pMap(rows.filter((r: any) => r.url), async (r: any): Promise<[string, any]> => {
        const res = await httpProbe(r.url, 8000);
        sp?.update(`probing ${c.faint(r.url)}`);
        return [r.url, res];
      }, 6);
      probes = new Map(results);
      sp?.stop(null);
    }

    if (ctx.json) {
      log.raw(JSON.stringify(rows.map((r) => ({
        project: r.project.name, stack: r.stack.name, router: r.route.router,
        service: r.route.service, url: r.url, rule: r.route.rule,
        tls: r.route.tls, port: r.route.port,
        probe: probes.get(r.url) || null,
      })), null, 2));
      return 0;
    }

    log.blank();
    log.raw(rule(`${rows.length} route(s)`));
    log.blank();
    log.raw(table(rows.map((r) => {
      const probe = probes.get(r.url);
      return {
        icon: probe ? (probe.ok ? c.ok(S.dot) : c.err(S.dot)) : c.faint(S.ring),
        url: r.url ? fg(P.info, r.url) : c.faint(r.route.rule),
        status: probe ? (probe.ok ? c.ok(probe.detail) : c.err(probe.detail)) : '',
        owner: c.bold(r.project.name) + (r.stack.name === 'default' ? '' : c.faint(':' + r.stack.name)),
        from: (r.route as any).managed ? c.faint('blankey') : c.faint('repo'),
        service: c.muted(r.route.service),
        port: r.route.port ? c.faint(':' + r.route.port) : c.faint('auto'),
        tls: r.route.tls ? fg(P.ok, 'tls') : c.warn('plain'),
      };
    }), [
      { key: 'icon', label: '', grow: false },
      { key: 'url', label: 'url', min: 18 },
      ...(ctx.flags.check ? [{ key: 'status', label: 'status', grow: false }] : []),
      { key: 'owner', label: 'project', min: 10 },
      { key: 'service', label: 'service', min: 6 },
      { key: 'from', label: 'labels', grow: false },
      { key: 'port', label: 'port', grow: false },
      { key: 'tls', label: 'tls', grow: false },
    ]));
    log.blank();

    const plain = rows.filter((r) => !r.route.tls);
    if (plain.length) {
      log.raw(`  ${c.warn(S.warn)} ${plain.length} route(s) served without TLS ${c.faint('add tls.certresolver labels')}`);
      log.blank();
    }
    if (ctx.flags.check) {
      const bad = rows.filter((r) => probes.get(r.url) && !probes.get(r.url).ok);
      if (bad.length) {
        log.raw(`  ${c.err(S.cross)} ${bad.length} route(s) not responding: ${bad.map((r) => r.project.name).join(', ')}`);
        log.blank();
        return 1;
      }
    }
    return 0;
  },
};

