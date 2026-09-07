import { menu, input, confirm, notice, busy, CANCEL, type ScreenLike, type MenuItem } from './widgets.js';
import { saveProjectRoutes } from './settings.js';
import { pickTls } from './certs.js';
import { T } from './theme.js';
import { c, fg, bold } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { routeSpecsFor, inferPort, resolveRoutes, hostsOf, tlsFor, urlsFor, type RouteSpec } from '../routes.js';
import { listCerts } from '../certs.js';
import * as docker from '../docker.js';
import type { Config, Project, Stack } from '../types.js';

/**
 * Editing the Traefik routing for one stack.
 *
 * Routes are written into blankey's own config, so a repo never has to carry
 * deployment labels. The screen works from the same specs the resolver reads,
 * and shows what each one would actually produce before it is saved.
 */

export interface RoutingResult {
  saved: boolean;
  path?: string;
  /** True when the user chose to add routing, so a caller can rescan. */
  changed: boolean;
}

const describe = (spec: RouteSpec): string => hostsOf(spec).join(', ') || '(no host)';

function specDetail(cfg: Config, stack: Stack, spec: RouteSpec, certNames: string[]): string[] {
  const service = spec.service ?? (stack.services.length === 1 ? stack.services[0]!.name : null);
  const svc = stack.services.find((s) => s.name === service);
  const port = spec.port ?? inferPort(svc);
  const tls = tlsFor(cfg, spec);

  const tlsLine = spec.cert
    ? (certNames.includes(spec.cert) ? c.faint(spec.cert) : fg(T.danger, `${spec.cert}, not found`))
    : (tls ? c.faint("on, Let's Encrypt") : c.faint('off'));

  return [
    bold(describe(spec)),
    '',
    `${c.muted('service')}  ${service ? c.faint(service) : fg(T.danger, 'not chosen')}`,
    `${c.muted('port')}     ${port ? c.faint(String(port)) : fg(T.danger, 'cannot be inferred')}`,
    `${c.muted('tls')}      ${tlsLine}`,
    ...(spec.path ? [`${c.muted('path')}     ${c.faint(spec.path)}`] : []),
    '',
    c.muted('becomes'),
    ...urlsFor(hostsOf(spec), { path: spec.path, tls }).map((url) => fg(T.info, url)),
  ];
}

/**
 * Offer to recreate the stack's containers so a routing change takes effect
 * immediately, and do it if asked.
 *
 * Nothing to offer when the stack is not running, since starting it later already
 * picks up whatever is on disk at that point, so asking would be noise.
 */
async function offerRestart(screen: ScreenLike, breadcrumb: string[], stack: Stack): Promise<boolean> {
  const containers = await docker.stackPs(stack).catch(() => []);
  const running = containers.filter((ct: any) => ct.state === 'running');
  if (!running.length) return false;

  const go = await confirm(screen, {
    breadcrumb,
    message: `Restart ${running.length === 1 ? 'the container' : `${running.length} containers`} to apply this now?`,
    detail: [
      c.muted('Traefik reads labels from the container itself, and a plain restart does not'),
      c.muted('re-read them; only recreating it does, which is what this does.'),
      '',
      c.faint('Skipping is fine: it applies the next time this stack deploys or starts.'),
    ],
    def: true,
  });
  if (go !== true) return false;

  busy(screen, breadcrumb, `restarting ${stack.projectName}`);
  const r = await docker.composeStream(stack, 'up -d --remove-orphans', {}).catch((e: any) => ({ code: 1, tail: [String(e?.message || e)] }));
  if (r.code !== 0) {
    await notice(screen, {
      breadcrumb,
      tone: 'danger',
      title: 'Restart failed',
      message: `Could not restart ${stack.projectName}`,
      detail: [
        ...((r.tail ?? []).slice(-6).map((l: string) => c.faint(l))),
        '',
        c.muted('The routing was still saved. Restart it by hand when ready.'),
      ],
      action: 'Continue',
    });
    return false;
  }
  return true;
}

/** Ask for one route. Returns the spec, or CANCEL. */
async function editSpec(
  screen: ScreenLike,
  breadcrumb: string[],
  cfg: Config,
  stack: Stack,
  current: RouteSpec = {},
): Promise<RouteSpec | typeof CANCEL> {
  const spec: RouteSpec = { ...current };

  const host = await input(screen, {
    breadcrumb,
    label: 'Hostname',
    help: 'The address people will use. It must already point at this server.',
    placeholder: 'app.example.com',
    value: describe(current) === '(no host)' ? '' : describe(current),
    validate: (t) => {
      const value = t.trim();
      if (!value) return 'Enter a hostname';
      if (/^https?:\/\//.test(value)) return 'Just the hostname, without http://';
      if (value.includes('/')) return 'Just the hostname. Add a path below if you need one.';
      return null;
    },
  });
  if (host === CANCEL) return CANCEL;
  const hosts = (host as string).split(',').map((h) => h.trim()).filter(Boolean);
  if (hosts.length > 1) { spec.hosts = hosts; delete spec.host; }
  else { spec.host = hosts[0]!; delete spec.hosts; }

  // Only worth asking when there is a choice to make.
  if (stack.services.length > 1) {
    const picked = await menu<string>(screen, {
      breadcrumb: [...breadcrumb, 'Service'],
      title: 'Which service receives the traffic',
      items: stack.services.map((s) => ({
        label: s.name,
        hint: s.ports.join(', ') || (s.build ? 'built here' : s.image || ''),
        value: s.name,
        detail: () => [
          bold(s.name),
          '',
          `${c.muted('image')}  ${c.faint(s.image || '(built from source)')}`,
          `${c.muted('ports')}  ${c.faint(s.ports.join(', ') || 'none declared')}`,
        ],
      })),
      filterable: false,
      detailTitle: 'Service',
    });
    if (picked === CANCEL) return CANCEL;
    spec.service = picked as string;
  } else {
    spec.service = stack.services[0]?.name;
  }

  const svc = stack.services.find((s) => s.name === spec.service);
  const guessed = inferPort(svc);
  const port = await input(screen, {
    breadcrumb: [...breadcrumb, 'Port'],
    label: 'Container port',
    help: guessed
      ? `Read from the compose file. This is the port inside the container, not the published one.`
      : 'The port your app listens on inside the container.',
    value: String(spec.port ?? guessed ?? ''),
    placeholder: '80',
    validate: (t) => (/^\d+$/.test(t.trim()) ? null : 'Enter a port number'),
  });
  if (port === CANCEL) return CANCEL;
  spec.port = Number((port as string).trim());

  const picked = await pickTls(screen, breadcrumb, cfg, { tls: spec.tls, cert: spec.cert });
  if (picked === CANCEL) return CANCEL;
  spec.tls = picked.tls;
  if (picked.cert) spec.cert = picked.cert;
  else delete spec.cert;

  return spec;
}

/** The routing screen for one stack. */
export async function routingEditor(
  screen: ScreenLike,
  { cfg, project, stack, breadcrumb = ['Routing'] }:
  { cfg: Config; project: Project; stack: Stack; breadcrumb?: string[] },
): Promise<RoutingResult> {
  // Stack-specific when the repo has more than one stack, so staging and live
  // do not have to share a hostname.
  const stackScope = project.stacks.length > 1 ? stack.name : null;
  let specs: RouteSpec[] = routeSpecsFor(cfg, project, stack.name).map((s) => ({ ...s }));
  const original = JSON.stringify(specs);
  const crumb = [...breadcrumb, project.name];

  const fromRepo = stack.routes.filter((r: any) => !r.managed);

  for (;;) {
    const dirty = JSON.stringify(specs) !== original;
    const certNames = (await listCerts(cfg)).map((c) => c.name);
    const items: MenuItem<string>[] = [];

    if (specs.length) items.push({ separator: 'routes' });
    specs.forEach((spec, i) => {
      items.push({
        label: describe(spec),
        hint: spec.service ?? '',
        value: `edit:${i}`,
        detail: () => specDetail(cfg, stack, spec, certNames),
      });
    });

    if (fromRepo.length) {
      items.push({ separator: 'from the repo compose file' });
      for (const route of fromRepo) {
        items.push({
          label: route.urls[0] || route.rule,
          hint: route.service,
          value: 'repo',
          disabled: true,
          detail: () => [
            bold(route.urls[0] || route.rule),
            '',
            c.muted('These labels are written in the repo compose file, so they are edited there rather than here.'),
          ],
        });
      }
    }

    items.push({ separator: '' });
    items.push({
      label: 'Add a route',
      value: 'add',
      detail: () => [
        bold('Add a route'),
        '',
        c.muted('A hostname, the service behind it and the port it listens on.'),
        '',
        c.muted('The labels are generated into an overlay outside the repo, so the compose file in git stays free of deployment concerns.'),
      ],
    });
    if (specs.length) items.push({ label: 'Remove a route', value: 'remove' });
    items.push({
      label: dirty ? 'Save routing' : 'Save routing (no changes)',
      value: 'save',
      badge: dirty ? fg(T.warn, S.dot) : '',
    });

    const picked = await menu<string>(screen, {
      breadcrumb: crumb,
      items,
      title: stackScope ? `${project.name}:${stack.name}` : project.name,
      detailTitle: 'Route',
      emptyMessage: 'no routing yet',
      footer: [
        [`${S.up}${S.down}`, 'move'], ['enter', 'choose'], ['esc', dirty ? 'discard' : 'back'],
      ],
    });

    if (picked === CANCEL) {
      if (!dirty) return { saved: false, changed: false };
      const discard = await confirm(screen, {
        breadcrumb: crumb,
        message: 'Discard these routes?',
        detail: [c.muted('Nothing has been written to the config yet.')],
        danger: true,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
      });
      if (discard === true) return { saved: false, changed: false };
      continue;
    }

    if (picked === 'add') {
      const spec = await editSpec(screen, [...crumb, 'New route'], cfg, stack);
      if (spec !== CANCEL) specs.push(spec as RouteSpec);
      continue;
    }

    if (typeof picked === 'string' && picked.startsWith('edit:')) {
      const index = Number(picked.slice(5));
      const spec = await editSpec(screen, [...crumb, 'Edit route'], cfg, stack, specs[index]);
      if (spec !== CANCEL) specs[index] = spec as RouteSpec;
      continue;
    }

    if (picked === 'remove') {
      const target = await menu<number>(screen, {
        breadcrumb: [...crumb, 'Remove'],
        title: 'Which route to remove',
        items: specs.map((spec, i) => ({ label: describe(spec), hint: spec.service ?? '', value: i })),
        filterable: false,
      });
      if (target !== CANCEL) specs = specs.filter((_, i) => i !== target);
      continue;
    }

    if (picked === 'save') {
      // "Save (no changes)" is offered as a quick way out; there is genuinely
      // nothing to write or apply, so leave without asking anything.
      if (!dirty) return { saved: false, changed: false };

      // Check it resolves before writing: routing that looks configured but
      // cannot work is worse than none at all.
      const preview = { ...stack, services: stack.services } as Stack;
      const probe = { ...cfg, projects: { ...cfg.projects, [project.name]: { routes: specs } } } as Config;
      const { problems } = resolveRoutes(probe, { ...project, repoConfig: {} } as Project, preview, { knownCerts: certNames });
      if (problems.length) {
        await notice(screen, {
          breadcrumb: crumb,
          tone: 'danger',
          title: 'Cannot save yet',
          message: 'These routes would not work',
          detail: [...problems.map((p) => `${fg(T.danger, S.cross)} ${p}`), '', c.muted('Edit them and try again.')],
          action: 'Back',
        });
        continue;
      }

      busy(screen, crumb, 'writing the config');
      const path = await saveProjectRoutes(cfg, project.name, stackScope, specs);

      // Traefik reads labels off the container itself, and a plain restart
      // does not re-read them; only recreating the container does. So there
      // is a real question to ask here, not just a courtesy.
      const restarted = await offerRestart(screen, crumb, stack);

      await notice(screen, {
        breadcrumb: crumb,
        tone: 'success',
        message: specs.length
          ? `${specs.length} route${specs.length === 1 ? '' : 's'} saved`
          : 'Routing removed',
        detail: [
          c.faint(path),
          '',
          ...specs.flatMap((spec) => urlsFor(hostsOf(spec), { tls: tlsFor(cfg, spec) }).map((url) => fg(T.info, url))),
          '',
          restarted
            ? fg(T.ok, `${S.tick} Restarted, the change is live.`)
            : c.muted('Applied on the next deploy or start of this stack.'),
        ],
        action: 'Done',
      });
      return { saved: true, path, changed: true };
    }
  }
}

/**
 * Offer routing before a deploy when a stack has none.
 *
 * Deploying something nobody can reach is the common first-run mistake, so it
 * is worth one question. Declining is remembered for the rest of the session.
 */
const declined = new Set<string>();

export async function offerRoutingBeforeDeploy(
  screen: ScreenLike,
  { cfg, project, stack }: { cfg: Config; project: Project; stack: Stack },
): Promise<RoutingResult> {
  const key = `${project.name}:${stack.name}`;
  if (stack.routes.length || declined.has(key)) return { saved: false, changed: false };

  const answer = await confirm(screen, {
    breadcrumb: ['Deployments', project.name],
    message: 'This stack has no Traefik routing',
    detail: [
      c.muted('Nothing will be reachable through the proxy until it has a hostname.'),
      '',
      c.muted('Set it up now and blankey writes the labels for you, outside the repo. You can also skip this and deploy anyway.'),
    ],
    confirmLabel: 'Set up routing',
    cancelLabel: 'Deploy without it',
    def: true,
  });

  if (answer !== true) {
    declined.add(key);
    return { saved: false, changed: false };
  }
  return routingEditor(screen, { cfg, project, stack, breadcrumb: ['Deployments'] });
}
