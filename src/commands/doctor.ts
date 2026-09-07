import { log } from '../ui/log.js';
import { c, P, fg, bold, badge } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { Spinner } from '../ui/spinner.js';
import { rule } from '../ui/box.js';
import * as host from '../host.js';
import * as docker from '../docker.js';
import { pMap, bytes, groupBy, firstLine } from '../util.js';
import { listCerts } from '../certs.js';
import { filterProjects } from '../discover.js';

export default {
  name: 'doctor',
  group: 'Maintenance',
  describe: 'Check the host, the proxy and every stack for problems',
  usage: 'doctor [project] [--fix] [--json]',
  options: [
    ['    --fix', 'create the proxy network and other safe repairs'],
    ['    --deep', 'also validate every compose file with docker compose config'],
    ['    --json', 'machine-readable report'],
  ],
  details:
    'Checks are grouped by severity. A failure means something is broken now; a\n' +
    'warning means it will bite you later (a service that will never be routed,\n' +
    'two projects claiming the same hostname, a host port already taken).',
  async run(ctx) {
    const sp = ctx.json ? null : new Spinner('running checks').start();
    const findings: any[] = [];
    const add = (level: string, area: string, message: string, hint?: string) => findings.push({ level, area, message, hint });

    // ---- host -------------------------------------------------------------
    sp?.update('checking docker');
    const info = await docker.dockerInfo();
    if (!info.ok) {
      add('fail', 'docker', `Docker is not reachable${host.isRemote() ? ' on ' + host.remoteLabel() : ''}`, info.error ?? undefined);
    } else {
      add('ok', 'docker', `Docker ${info.version}${info.cpus ? ` ${S.bullet} ${info.cpus} CPU ${S.bullet} ${bytes(info.memTotal)} RAM` : ''}`);
    }

    const compose = await docker.composeBin();
    if (compose.missing) add('fail', 'docker', 'Docker Compose is not installed', 'Install the compose plugin: docker compose version');
    else if (!compose.v2) add('warn', 'docker', `Using legacy ${compose.cmd} ${compose.version}`, 'Compose v2 is recommended');
    else add('ok', 'docker', `Compose ${compose.version}`);

    // ---- config -----------------------------------------------------------
    add('ok', 'config', `Config ${c.faint(ctx.cfg.__file)}`);
    const rootOk = await host.exists(ctx.cfg.projectsDir);
    if (!rootOk) add('fail', 'config', `projectsDir does not exist: ${ctx.cfg.projectsDir}`, 'Create it or point projectsDir elsewhere');

    // ---- proxy ------------------------------------------------------------
    sp?.update('checking traefik');
    const netName = ctx.cfg.traefik.network;
    let netOk = await docker.networkExists(netName);
    if (!netOk && ctx.flags.fix && info.ok) {
      try {
        await docker.ensureNetwork(netName);
        netOk = true;
        add('ok', 'traefik', `Created the ${netName} network`);
      } catch (e) {
        add('fail', 'traefik', `Could not create network ${netName}`, e.message);
      }
    } else if (!netOk) {
      add('fail', 'traefik', `Proxy network ${bold(netName)} does not exist`, 'blankey traefik init  (or doctor --fix)');
    } else {
      add('ok', 'traefik', `Network ${netName} exists`);
    }

    const traefikFile = host.join(ctx.cfg.traefik.dir, 'docker-compose.yml');
    if (!(await host.exists(traefikFile))) {
      add('warn', 'traefik', 'No Traefik stack scaffolded yet', 'blankey traefik init');
    } else {
      const running = await host.exec('docker ps --filter label=blankey.role=traefik --format "{{.Status}}"', { timeout: 15000 });
      if (running.code === 0 && running.stdout.trim()) add('ok', 'traefik', `Proxy running ${c.faint(firstLine(running.stdout))}`);
      else add('fail', 'traefik', 'Proxy is scaffolded but not running', 'blankey traefik up');
    }

    const acme = host.join(ctx.cfg.traefik.dir, 'letsencrypt', 'acme.json');
    if (await host.exists(acme)) {
      const perm = await host.exec(`stat -c %a ${host.q(acme)}`, { timeout: 10000 });
      if (perm.code === 0 && perm.stdout.trim() !== '600') {
        add('warn', 'traefik', `acme.json is mode ${perm.stdout.trim()}`, `chmod 600 ${acme}`);
      }
    }

    const sslConfigs = await listCerts(ctx.cfg);
    const halfInstalled = sslConfigs.filter((cert) => !cert.hasFiles);
    for (const cert of halfInstalled) {
      add('fail', 'traefik', `SSL configuration "${cert.name}" is missing its certificate or key`,
        `Expected both ${cert.certPath} and ${cert.keyPath}`);
    }
    if (sslConfigs.length && !halfInstalled.length) {
      add('ok', 'traefik', `${sslConfigs.length} SSL configuration${sslConfigs.length === 1 ? '' : 's'}: ${sslConfigs.map((c) => c.name).join(', ')}`);
    }

    // ---- projects ---------------------------------------------------------
    sp?.update('checking projects');
    const projects = rootOk ? await ctx.projects() : [];
    const filtered = filterProjects(projects, ctx.positional[0]);

    if (rootOk && !projects.length) {
      add('warn', 'projects', `No compose projects found in ${ctx.cfg.projectsDir}`, 'Clone a repo there, or check the ignore list');
    }

    const hostPorts = info.ok ? await docker.usedHostPorts() : new Map();
    const claimed = new Map();

    for (const p of filtered) {
      // Two stacks sharing a Compose project name are, to Docker, one and the
      // same set of containers: deploying either one recreates the other's,
      // and a status check for one reports the other's containers too.
      if (p.stacks.length > 1) {
        const byName = groupBy(p.stacks, (s: any) => s.projectName);
        for (const [projectName, group] of byName) {
          if (group.length < 2) continue;
          add('fail', p.name,
            `${group.map((s: any) => s.name).join(', ')} all use Compose project "${projectName}", so they share the same containers`,
            'Set isolateStacks: true, either in the repo .blankey.yml or under projects.' + p.name + ' in blankey.yml');
        }
      }
      for (const s of p.stacks) {
        const routed = s.services.filter((svc) =>
          s.routes.some((r) => r.service === svc.name));
        const managed = (s as any).managed;
        const managedServices = new Set<string>((managed?.routes ?? []).map((r: any) => r.service));

        // Routing configured but unusable is worse than none: it looks set up.
        for (const problem of managed?.problems ?? []) {
          add('fail', p.name, `${s.name}: ${problem}`,
            'Fix the routes entry in your blankey config, or the repo .blankey.yml');
        }

        for (const svc of routed) {
          // blankey's own overlay always joins the proxy network, so only
          // labels written in the repo can get this wrong.
          if (managedServices.has(svc.name)) continue;
          // A routed service must join the proxy network explicitly: with no
          // networks key it only lands on the project default, where Traefik
          // cannot reach it.
          if (!svc.networks.includes(netName)) {
            add('warn', p.name, `${s.name}/${svc.name} has traefik labels but is not on ${netName}`,
              svc.networks.length
                ? `Add "${netName}" to its networks, or Traefik will never see it`
                : `It declares no networks, so it only joins the project default. Add "${netName}".`);
          }
        }

        // Compose appends port lists across files, so an overlay cannot take a
        // published port away. The app stays reachable directly, past Traefik.
        for (const svc of s.services) {
          if (!managedServices.has(svc.name) || !svc.ports.length) continue;
          const published = svc.ports.filter((port) => String(port).includes(':'));
          if (!published.length) continue;
          add('warn', p.name, `${s.name}/${svc.name} is routed through Traefik but also publishes ${published.join(', ')}`,
            'Traffic can reach it directly on that port, bypassing TLS. Remove the ports entry from the repo compose file.');
        }
        for (const r of s.routes) {
          if (!r.port && routed.length) {
            const svc = s.services.find((x) => x.name === r.service);
            if (svc && svc.ports.length === 0) {
              add('warn', p.name, `router ${r.router} has no loadbalancer.server.port label`,
                'Traefik guesses the port when a container exposes exactly one');
            }
          }
          for (const h of r.hosts) {
            const key = h.toLowerCase();
            const owner = `${p.name}:${s.name}`;
            if (claimed.has(key) && claimed.get(key) !== owner) {
              add('warn', p.name, `hostname ${bold(h)} is claimed by both ${claimed.get(key)} and ${owner}`,
                'Whichever router Traefik loads last wins');
            } else claimed.set(key, owner);
          }
        }
        for (const svc of s.services) {
          for (const port of svc.ports) {
            const published = String(port).split(':')[0];
            if (!/^\d+$/.test(published)) continue;
            const key = `${published}/tcp`;
            if (hostPorts.has(key)) {
              const inUse = hostPorts.get(key);
              add('warn', p.name, `host port ${published} is already published (container port ${inUse})`,
                'Two stacks binding the same host port will not start together');
            }
          }
        }
        for (const svc of s.services) {
          for (const envFile of svc.envFiles) {
            if (!(await host.exists(host.join(s.dir, envFile)))) {
              add('fail', p.name, `${s.name}/${svc.name} references a missing env file: ${envFile}`,
                `Create ${host.join(s.dir, envFile)}`);
            }
          }
        }
      }
      if (!p.isGit) add('warn', p.name, 'Not a git repository', 'blankey deploy can only restart it, not update it');
    }

    if (ctx.flags.deep && info.ok) {
      sp?.update('validating compose files');
      const stacks = filtered.flatMap((p) => p.stacks.map((s) => ({ p, s })));
      await pMap(stacks, async ({ p, s }: any) => {
        const r = await docker.compose(s, 'config -q', { timeout: 60000 });
        if (r.code !== 0) {
          add('fail', p.name, `${s.name} compose file is invalid`, firstLine(r.stderr));
        }
      }, 4);
    }

    // ---- backups ----------------------------------------------------------
    sp?.update('checking backups');
    const { backupProblems } = await import('../config.js');
    const backupMissing = backupProblems(ctx.cfg.backup);
    const volumeStacks = filtered.flatMap((p) => p.stacks).filter((s) => (s.volumes || []).length);

    if (backupMissing.length) {
      if (volumeStacks.length) {
        add('warn', 'backups', `${volumeStacks.length} stack(s) use named volumes but backups are not configured`,
          'blankey backup check  shows what is missing');
      }
    } else {
      const { scheduleStatus } = await import('../schedule.js');
      const sched = await scheduleStatus(ctx.cfg);
      if (sched.installed > 1) {
        add('fail', 'backups', 'A systemd timer and a cron entry are both installed, so backups run twice',
          'blankey backup unschedule, then schedule again');
      } else if (!sched.installed) {
        add('warn', 'backups', 'Backups are configured but nothing is scheduled',
          'blankey backup schedule daily --at 03:30');
      } else {
        add('ok', 'backups', `Scheduled${sched.systemd?.next ? ', next run ' + sched.systemd.next : ''}`);
      }
    }

    // ---- disk -------------------------------------------------------------
    if (info.ok) {
      const df = await docker.diskUsage();
      const reclaimable = (df || []).find((x) => x.Type === 'Images');
      if (reclaimable && reclaimable.Reclaimable && /\d/.test(reclaimable.Reclaimable)) {
        const amount = String(reclaimable.Reclaimable).split(' ')[0];
        const gb = parseFloat(amount);
        if (/GB/.test(reclaimable.Reclaimable) && gb >= 5) {
          add('warn', 'disk', `${reclaimable.Reclaimable} of images can be reclaimed`, 'blankey prune');
        } else {
          add('ok', 'disk', `Images: ${reclaimable.Size}, ${reclaimable.Reclaimable} reclaimable`);
        }
      }
    }

    sp?.stop(null);

    if (ctx.json) {
      log.raw(JSON.stringify({ findings }, null, 2));
      return findings.some((f) => f.level === 'fail') ? 2 : 0;
    }

    render(findings);
    const fails = findings.filter((f) => f.level === 'fail').length;
    const warns = findings.filter((f) => f.level === 'warn').length;
    return fails ? 2 : warns ? 1 : 0;
  },
};

function render(findings: any[]) {
  const byArea = groupBy(findings, (f: any) => f.area);
  log.blank();
  log.raw(rule('doctor'));
  log.blank();
  for (const [area, items] of byArea) {
    const worst = items.some((i) => i.level === 'fail') ? P.err
      : items.some((i) => i.level === 'warn') ? P.warn : P.ok;
    log.raw(`  ${fg(worst, S.block)} ${bold(area)}`);
    for (const f of items) {
      const icon = f.level === 'fail' ? c.err(S.cross) : f.level === 'warn' ? c.warn(S.warn) : c.ok(S.tick);
      log.raw(`    ${icon} ${f.level === 'ok' ? c.muted(f.message) : f.message}`);
      if (f.hint) log.raw(`      ${c.faint(S.arrow + ' ' + f.hint)}`);
    }
    log.blank();
  }
  const fails = findings.filter((f) => f.level === 'fail').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  const verdict = fails
    ? `${badge(' PROBLEMS ', P.err)} ${fails} failing, ${warns} warning(s)`
    : warns
      ? `${badge(' OK ', P.warn)} ${warns} warning(s), nothing broken`
      : `${badge(' HEALTHY ', P.ok)} everything checks out`;
  log.raw('  ' + verdict);
  log.blank();
}
