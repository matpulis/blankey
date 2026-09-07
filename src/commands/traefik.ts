import { log, cancelled } from '../ui/log.js';
import { c, P, fg, bold, badge } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { Spinner } from '../ui/spinner.js';
import { confirm } from '../ui/prompt.js';
import { table } from '../ui/table.js';
import { box, rule } from '../ui/box.js';
import * as host from '../host.js';
import * as docker from '../docker.js';
import { traefikCompose, traefikStatic, traefikDynamic } from '../templates.js';
import { parseDockerJson } from '../util.js';

/** The proxy is just another compose stack, described here rather than discovered. */
function traefikStack(cfg) {
  return {
    name: 'traefik',
    project: 'traefik',
    dir: cfg.traefik.dir,
    files: ['docker-compose.yml'],
    explicitFiles: [],
    projectName: 'traefik',
    profiles: [],
    services: [{ name: 'traefik' }],
    routes: [],
  };
}

const SUBCOMMANDS = ['init', 'up', 'down', 'restart', 'status', 'logs', 'routes', 'certs', 'config'];

export default {
  name: 'traefik',
  aliases: ['proxy'],
  group: 'Traefik',
  describe: 'Manage the edge proxy that fronts every stack',
  usage: 'traefik <init|up|down|restart|status|logs|routes|certs> [options]',
  valueFlags: ['tail'],
  options: [
    ['    --force', 'regenerate docker-compose.yml and traefik.yml on init (dynamic/middlewares.yml is never touched)'],
    ['-f, --follow', 'follow logs'],
    ['    --json', 'machine-readable output for status/routes'],
  ],
  details:
    'init scaffolds a Traefik stack (compose file, static config, dynamic config,\n' +
    'ACME storage) and creates the shared external network that every routed\n' +
    'container joins. The dashboard API is published on 127.0.0.1:8080 of the\n' +
    'Docker host only, which is how `routes` and `certs` read live state.',
  examples: [
    ['blankey traefik init', 'scaffold the proxy and its network'],
    ['blankey traefik routes', 'every route Traefik is actually serving'],
  ],
  async run(ctx) {
    const sub = ctx.positional[0] || 'status';
    if (!SUBCOMMANDS.includes(sub)) {
      log.fail(`Unknown traefik subcommand: ${c.bold(sub)}`);
      log.hint(SUBCOMMANDS.join(', '));
      return 127;
    }
    return handlers[sub](ctx);
  },
};

const handlers = {
  async init(ctx) {
    const cfg = ctx.cfg;
    const dir = cfg.traefik.dir;
    log.blank();
    log.step(`Scaffolding Traefik in ${c.bold(dir)}`);
    log.blank();

    // docker-compose.yml and traefik.yml are entirely derived from config, so
    // --force regenerating them is safe and is how a settings change reaches
    // disk. dynamic/middlewares.yml is explicitly meant for hand edits (the
    // dashboard password lives there) and is never overwritten once it
    // exists, force or not.
    const derived = [
      ['docker-compose.yml', traefikCompose(cfg)],
      ['traefik.yml', traefikStatic(cfg)],
    ];
    const handEdited = [
      ['dynamic/middlewares.yml', traefikDynamic()],
    ];

    await host.mkdirp(dir);
    await host.mkdirp(host.join(dir, 'dynamic'));
    await host.mkdirp(host.join(dir, 'certs'));
    await host.mkdirp(host.join(dir, 'certs-incoming'));
    await host.mkdirp(host.join(dir, 'letsencrypt'));
    await host.mkdirp(host.join(dir, 'logs'));

    for (const [name, content] of derived) {
      const target = host.join(dir, name);
      if ((await host.exists(target)) && !ctx.flags.force) {
        log.raw(`  ${c.faint(S.ring)} ${c.muted(name)} ${c.faint('exists, kept')}`);
        continue;
      }
      await host.writeFile(target, content);
      log.raw(`  ${c.ok(S.tick)} ${name}`);
    }
    for (const [name, content] of handEdited) {
      const target = host.join(dir, name);
      if (await host.exists(target)) {
        log.raw(`  ${c.faint(S.ring)} ${c.muted(name)} ${c.faint('exists, kept (never overwritten once created)')}`);
        continue;
      }
      await host.writeFile(target, content);
      log.raw(`  ${c.ok(S.tick)} ${name}`);
    }

    // acme.json must be private or Traefik refuses to use it.
    const acmeFile = host.join(dir, 'letsencrypt', 'acme.json');
    if (!(await host.exists(acmeFile))) {
      await host.writeFile(acmeFile, '{}');
      await host.exec(`chmod 600 ${host.q(acmeFile)}`);
      log.raw(`  ${c.ok(S.tick)} letsencrypt/acme.json ${c.faint('(chmod 600)')}`);
    }

    const net = await docker.ensureNetwork(cfg.traefik.network);
    log.raw(`  ${net.created ? c.ok(S.tick) : c.faint(S.ring)} network ${c.bold(cfg.traefik.network)} ${c.faint(net.created ? 'created' : 'already exists')}`);

    log.blank();
    const notes: any[] = [];
    if (!cfg.traefik.acme?.email) {
      notes.push(`${c.warn(S.warn)} No ACME email configured, so TLS certificates are off.`);
      notes.push(`  ${c.faint('Add traefik.acme.email to ' + cfg.__file + ' and re-run with --force.')}`);
    }
    if (cfg.traefik.dashboard && cfg.traefik.dashboardHost) {
      notes.push(`${c.info(S.info)} Dashboard at ${fg(P.info, 'https://' + cfg.traefik.dashboardHost)}`);
      notes.push(`  ${c.faint('Set a real password in dynamic/middlewares.yml: htpasswd -nb admin secret')}`);
    }
    notes.push(`${c.muted('Every routed service needs:')} ${c.faint(`networks: [${cfg.traefik.network}]`)} ${c.muted('plus traefik labels.')}`);
    notes.push(`${c.muted('Using your own certificates (Cloudflare origin, say)? Drop them in')} ${c.faint(host.join(dir, 'certs-incoming'))}`);
    log.raw(box(notes, { title: 'next steps' }));
    log.blank();
    log.hint('blankey traefik up');
    log.blank();
    return 0;
  },

  async up(ctx) {
    const cfg = ctx.cfg;
    const dir = cfg.traefik.dir;
    if (!(await host.exists(host.join(dir, 'docker-compose.yml')))) {
      log.fail(`No Traefik stack at ${c.bold(dir)}`);
      log.hint('blankey traefik init');
      return 1;
    }
    await docker.ensureNetwork(cfg.traefik.network);
    const sp = new Spinner(`${c.muted('starting')} traefik`).start();
    const r = await docker.composeStream(traefikStack(cfg), 'up -d --remove-orphans', {
      onLine: (line) => sp.update(`${c.muted('starting')} traefik ${c.faint(line.slice(0, 50))}`),
    });
    if (r.code !== 0) {
      sp.fail('traefik failed to start');
      for (const line of r.tail.slice(-8)) log.raw('    ' + c.faint(line));
      return 1;
    }
    sp.succeed(`traefik ${c.faint('up')}`);
    return handlers.status(ctx);
  },

  async down(ctx) {
    if (!ctx.yes && !(await confirm('Stop the proxy? Every routed site goes offline.', { def: false }))) {
      return cancelled();
    }
    const sp = new Spinner(`${c.muted('stopping')} traefik`).start();
    const r = await docker.compose(traefikStack(ctx.cfg), 'down', { timeout: 120000 });
    r.code === 0 ? sp.succeed('traefik stopped') : sp.fail(r.stderr || 'failed');
    return r.code === 0 ? 0 : 1;
  },

  async restart(ctx) {
    const sp = new Spinner(`${c.muted('restarting')} traefik`).start();
    const r = await docker.compose(traefikStack(ctx.cfg), 'restart', { timeout: 120000 });
    r.code === 0 ? sp.succeed('traefik restarted') : sp.fail(r.stderr || 'failed');
    return r.code === 0 ? 0 : 1;
  },

  async logs(ctx) {
    const args = ['logs', ctx.flags.follow ? '-f' : '', `--tail ${Number(ctx.flags.tail) || 150}`]
      .filter(Boolean).join(' ');
    return docker.composeInteractive(traefikStack(ctx.cfg), args);
  },

  async status(ctx) {
    const cfg = ctx.cfg;
    const [containers, netOk, api] = await Promise.all([
      docker.stackPs(traefikStack(cfg)),
      docker.networkExists(cfg.traefik.network),
      apiGet('/api/overview'),
    ]);
    const ct = containers[0];

    if (ctx.json) {
      log.raw(JSON.stringify({ container: ct || null, network: netOk, overview: api.data }, null, 2));
      return 0;
    }

    log.blank();
    const up = ct && ct.state === 'running';
    log.raw(`  ${up ? badge(' UP ', P.ok) : badge(' DOWN ', P.err)}  ${bold('traefik')} ${c.faint(cfg.traefik.dir)}`);
    log.blank();
    const rows = [
      ['container', ct ? c.muted(ct.status) : c.faint('not created')],
      ['image', ct ? c.faint(ct.image) : c.faint(cfg.traefik.image)],
      ['network', netOk ? c.ok(cfg.traefik.network) : c.err(cfg.traefik.network + ' missing')],
      ['entrypoints', c.muted(`:${cfg.traefik.entrypoints.web} ${S.bullet} :${cfg.traefik.entrypoints.websecure}`)],
      ['dashboard', cfg.traefik.dashboardHost ? fg(P.info, 'https://' + cfg.traefik.dashboardHost) : c.faint('not configured')],
      ['acme', cfg.traefik.acme?.email
        ? c.muted(`${cfg.traefik.acme.email} (${cfg.traefik.acme.resolver}${cfg.traefik.acme.staging ? ', staging' : ''})`)
        : c.faint('disabled')],
    ];
    if (api.ok && api.data?.http) {
      const h = api.data.http;
      rows.push(['routers', c.muted(`${h.routers?.total ?? 0} total, ${fg(P.ok, String(h.routers?.warnings ?? 0))} warnings, ${fg(P.err, String(h.routers?.errors ?? 0))} errors`)]);
      rows.push(['services', c.muted(String(h.services?.total ?? 0))]);
    } else if (up) {
      rows.push(['api', c.faint('not reachable on 127.0.0.1:8080')]);
    }
    const w = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) log.raw(`  ${c.muted(k.padEnd(w))}  ${v}`);
    log.blank();
    if (!up) log.hint('blankey traefik up');
    return up ? 0 : 1;
  },

  async routes(ctx) {
    const res = await apiGet('/api/http/routers');
    if (!res.ok) {
      log.blank();
      log.fail('Could not read the Traefik API on 127.0.0.1:8080.');
      log.hint('Is the proxy running? blankey traefik status');
      log.blank();
      return 1;
    }
    const routers = Array.isArray(res.data) ? res.data : [];
    if (ctx.json) {
      log.raw(JSON.stringify(routers, null, 2));
      return 0;
    }
    log.blank();
    log.raw(rule(`${routers.length} router(s) live in traefik`));
    log.blank();
    log.raw(table(routers.map((r) => ({
      icon: r.status === 'enabled' ? c.ok(S.dot) : c.err(S.dot),
      name: bold(String(r.name || '').replace(/@docker$/, '')),
      rule: c.muted(r.rule || ''),
      service: c.faint(String(r.service || '').replace(/@docker$/, '')),
      entry: c.faint((r.entryPoints || []).join(',')),
      tls: r.tls ? fg(P.ok, 'tls') : c.faint('—'),
      provider: c.faint(r.provider || ''),
    })), [
      { key: 'icon', label: '', grow: false },
      { key: 'name', label: 'router', min: 10 },
      { key: 'rule', label: 'rule', min: 16 },
      { key: 'service', label: 'service', min: 8 },
      { key: 'entry', label: 'entrypoint', grow: false },
      { key: 'tls', label: 'tls', grow: false },
    ]));
    log.blank();
    const broken = routers.filter((r) => r.status !== 'enabled');
    if (broken.length) {
      log.raw(`  ${c.err(S.cross)} ${broken.length} router(s) not enabled: ${broken.map((r) => r.name).join(', ')}`);
      log.blank();
    }
    return 0;
  },

  async certs(ctx) {
    const acmePath = host.join(ctx.cfg.traefik.dir, 'letsencrypt', 'acme.json');
    const text = await host.readFile(acmePath);
    if (!text) {
      log.fail(`No ACME storage at ${acmePath}`);
      return 1;
    }
    let data: any;
    try { data = JSON.parse(text); } catch { data = null; }
    const certs: any[] = [];
    for (const [resolver, entry] of Object.entries<any>(data || {})) {
      for (const cert of entry?.Certificates || []) {
        certs.push({
          resolver,
          main: cert.domain?.main,
          sans: (cert.domain?.sans || []).join(', '),
        });
      }
    }
    if (ctx.json) {
      log.raw(JSON.stringify(certs, null, 2));
      return 0;
    }
    log.blank();
    if (!certs.length) {
      log.raw(`  ${c.faint('No certificates issued yet.')}`);
      log.blank();
      return 0;
    }
    log.raw(table(certs.map((x) => ({
      icon: c.ok(S.tick),
      main: bold(x.main || ''),
      sans: c.faint(x.sans || '—'),
      resolver: c.muted(x.resolver),
    })), [
      { key: 'icon', label: '', grow: false },
      { key: 'main', label: 'domain', min: 14 },
      { key: 'sans', label: 'alt names', min: 10 },
      { key: 'resolver', label: 'resolver', grow: false },
    ]));
    log.blank();
    return 0;
  },

  async config(ctx) {
    const file = host.join(ctx.cfg.traefik.dir, 'traefik.yml');
    const text = await host.readFile(file);
    if (!text) {
      log.fail(`Not found: ${file}`);
      return 1;
    }
    log.blank();
    log.raw(c.faint(`  ${file}`));
    log.blank();
    for (const line of text.split('\n')) {
      log.raw('  ' + (line.trim().startsWith('#') ? c.faint(line) : c.muted(line)));
    }
    log.blank();
    return 0;
  },
};

/** Query the loopback-bound Traefik API from the Docker host. */
async function apiGet(pathname) {
  const r = await host.exec(
    `curl -fsS -m 5 http://127.0.0.1:8080${pathname}`,
    { timeout: 15000 },
  );
  if (r.code !== 0) return { ok: false, data: null };
  try {
    return { ok: true, data: JSON.parse(r.stdout) };
  } catch {
    const parsed = parseDockerJson(r.stdout);
    return { ok: parsed.length > 0, data: parsed };
  }
}

