import * as host from './host.js';
import { slug } from './util.js';
import type { Config, Project, Stack, ServiceSummary } from './types.js';

/**
 * Traefik labels without touching the repo.
 *
 * Compose merges several `-f` files, so routing can live in blankey's own
 * config and be handed to Compose as a generated overlay at run time. The repo
 * keeps a plain compose file with no deployment concerns in it, and the labels
 * stay with whoever operates the server.
 *
 * The overlay is written under the projects directory, never inside the repo,
 * and is regenerated only when its contents would change.
 */

export interface RouteSpec {
  /** Hostname to route, or several for one service. */
  host?: string;
  hosts?: string[];
  /** Which compose service. Optional when the stack has exactly one. */
  service?: string;
  /** Container port. Inferred from the compose file when there is one answer. */
  port?: number;
  /** Path prefix, when a hostname is shared between services. */
  path?: string;
  /** Defaults to on when a certificate resolver is configured. */
  tls?: boolean;
  /**
   * Name of a saved SSL configuration (see certs.ts) to serve this route with,
   * instead of an automatic Let's Encrypt certificate. Implies `tls: true`.
   */
  cert?: string;
  middlewares?: string[];
  entrypoint?: string;
}

export interface ResolvedRoute extends Omit<RouteSpec, 'port'> {
  service: string;
  hosts: string[];
  router: string;
  port: number;
  tls: boolean;
  entrypoint: string;
  middlewares: string[];
}

/**
 * The hostnames one spec covers. `host` and `hosts` are both accepted so a
 * single-hostname route stays a one-liner, which means every reader has to
 * fold the two together, so they do it here.
 */
export const hostsOf = (spec: RouteSpec): string[] =>
  [...(spec.hosts ?? []), ...(spec.host ? [spec.host] : [])].filter(Boolean);

/**
 * Whether a route is served over HTTPS. Naming a certificate is itself the
 * decision to use TLS; otherwise it follows the spec, defaulting to on
 * whenever an ACME account exists to issue one.
 */
export const tlsFor = (cfg: Config, spec: RouteSpec): boolean =>
  (spec.cert ? true : (spec.tls ?? Boolean(cfg.traefik.acme?.email)));

/**
 * Where a route's hostnames are actually reachable.
 *
 * Takes the hosts rather than the spec: a resolved route carries both its
 * original `host` and the folded `hosts` array, so re-folding one would list
 * every single-host URL twice.
 */
export const urlsFor = (hosts: string[], { path, tls }: { path?: string; tls?: boolean }): string[] => {
  const suffix = path && path !== '/' ? path : '';
  return hosts.map((h) => `${tls ? 'https' : 'http'}://${h}${suffix}`);
};

/** Accept a bare hostname, one object, or a list of either. */
function normalizeSpecs(value: unknown): RouteSpec[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry): RouteSpec[] => {
    if (typeof entry === 'string') return [{ host: entry }];
    if (entry && typeof entry === 'object') return [entry as RouteSpec];
    return [];
  });
}

/**
 * Routing for one stack, from the operator's config first and the repo's own
 * .blankey.yml second. The operator wins: the point is to be able to control
 * routing without editing anything in the repo.
 */
export function routeSpecsFor(cfg: Config, project: Project, stackName: string): RouteSpec[] {
  const fromConfig = cfg.projects?.[project.name] as any;
  const fromRepo = project.repoConfig as any;

  const pick = (source: any): RouteSpec[] => {
    if (!source) return [];
    const perStack = source.stacks?.[stackName]?.routes;
    // A stack-specific list replaces the project-wide one rather than adding to
    // it, so staging can point somewhere else entirely.
    if (perStack !== undefined) return normalizeSpecs(perStack);
    return normalizeSpecs(source.routes);
  };

  const operator = pick(fromConfig);
  return operator.length ? operator : pick(fromRepo);
}

interface PortMapping { published: number | null; target: number }

/** Every port a service declares, split into its published and container sides. */
function portMappings(service: ServiceSummary | undefined): PortMapping[] {
  if (!service) return [];
  return service.ports
    .map((p) => {
      const parts = String(p).split(':');
      const targetRaw = (parts[parts.length - 1] ?? '').split('/')[0];
      const target = Number(targetRaw);
      if (!Number.isFinite(target)) return null;
      // A bare "80" has no published side to record; "8084:80" does.
      const publishedRaw = parts.length > 1 ? parts[parts.length - 2] : undefined;
      const published = publishedRaw !== undefined ? Number(publishedRaw) : null;
      return { published: Number.isFinite(published as number) ? published : null, target };
    })
    .filter((m): m is PortMapping => m !== null);
}

/** The container port to send traffic to, when the compose file makes it obvious. */
export function inferPort(service: ServiceSummary | undefined): number | null {
  // "8084:80" and "80" both mean the container listens on 80.
  const unique = [...new Set(portMappings(service).map((m) => m.target))];
  return unique.length === 1 ? unique[0]! : null;
}

/**
 * Catch the classic mix-up: a route pointed at the *published* host port
 * ("8084:80" means the host, not the container, answers on 8084) rather than
 * the port the container actually listens on. Traefik reaches containers
 * directly over the Docker network, so the published side is never the right
 * answer, and a route built on it fails with nothing obviously wrong in the
 * config. It just does not respond.
 */
function publishedPortMistake(service: ServiceSummary | undefined, port: number): PortMapping | null {
  const mappings = portMappings(service);
  const match = mappings.find((m) => m.published === port);
  if (!match) return null;
  // Some other mapping on the same service also uses this number as its
  // container port, so it is plausibly correct rather than a mix-up.
  const alsoAContainerPort = mappings.some((m) => m.target === port);
  return alsoAContainerPort ? null : match;
}

export interface ResolveResult {
  routes: ResolvedRoute[];
  problems: string[];
}

/**
 * Turn the configured specs into complete routes, or say why they cannot be.
 *
 * `knownCerts`, when given, is the set of SSL configurations that actually
 * exist. A route naming one that does not is a problem the same way a
 * missing service or port is. Omitted, a named cert is trusted rather than
 * checked, for callers that only have the specs and not the filesystem.
 */
export function resolveRoutes(
  cfg: Config,
  project: Project,
  stack: Stack,
  { knownCerts }: { knownCerts?: Set<string> | string[] } = {},
): ResolveResult {
  const specs = routeSpecsFor(cfg, project, stack.name);
  const problems: string[] = [];
  const routes: ResolvedRoute[] = [];
  if (!specs.length) return { routes, problems };

  const certs = knownCerts ? new Set(knownCerts) : null;
  const services = stack.services;

  specs.forEach((spec, index) => {
    const hosts = hostsOf(spec);
    if (!hosts.length) {
      problems.push(`route ${index + 1} has no host`);
      return;
    }

    const serviceName = spec.service
      ?? (services.length === 1 ? services[0]!.name : undefined);
    if (!serviceName) {
      problems.push(`${hosts[0]} does not say which service to route to (${services.map((s) => s.name).join(', ')})`);
      return;
    }
    const service = services.find((s) => s.name === serviceName);
    if (!service) {
      problems.push(`${hosts[0]} routes to service "${serviceName}", which this stack does not define`);
      return;
    }

    const port = spec.port ?? inferPort(service);
    if (!port) {
      problems.push(`${hosts[0]} needs an explicit port: ${serviceName} does not expose exactly one`);
      return;
    }

    // An explicit port that only matches the *published* side of a mapping is
    // almost always this route pointed at the host port instead of the
    // container's own one, the single most common reason a route 502s.
    if (spec.port !== undefined) {
      const mistake = publishedPortMistake(service, spec.port);
      if (mistake) {
        problems.push(
          `${hosts[0]} uses port ${spec.port}, which is the published host port from "${mistake.published}:${mistake.target}" ` +
          `in the compose file. Traefik reaches the container directly over the Docker network, so use the container port ` +
          `(${mistake.target}) instead.`,
        );
        return;
      }
    }

    if (spec.cert && certs && !certs.has(spec.cert)) {
      problems.push(`${hosts[0]} uses SSL configuration "${spec.cert}", which does not exist`);
      return;
    }

    const tls = tlsFor(cfg, spec);
    routes.push({
      ...spec,
      service: serviceName,
      hosts,
      port,
      tls,
      entrypoint: spec.entrypoint ?? (tls ? 'websecure' : 'web'),
      middlewares: spec.middlewares ?? [],
      router: slug(`${stack.projectName}-${serviceName}${specs.length > 1 ? '-' + (index + 1) : ''}`),
    });
  });

  return { routes, problems };
}

/** The compose overlay that adds the labels and the proxy network. */
export function renderOverlay(cfg: Config, routes: ResolvedRoute[]): string {
  const network = cfg.traefik.network;
  const resolver = cfg.traefik.acme?.resolver || 'le';
  const byService = new Map<string, ResolvedRoute[]>();
  for (const route of routes) {
    if (!byService.has(route.service)) byService.set(route.service, []);
    byService.get(route.service)!.push(route);
  }

  const lines: string[] = [
    '# Generated by blankey. Do not edit: it is rewritten from your config.',
    '#',
    '# Compose merges this on top of the repo compose file, which is how routing',
    '# stays out of the repo. Change it via `projects.<name>.routes` in the',
    '# blankey config, or `routes:` in the repo .blankey.yml.',
    '',
    'services:',
  ];

  for (const [service, list] of byService) {
    lines.push(`  ${service}:`);
    lines.push('    networks:');
    lines.push(`      - ${network}`);
    lines.push('    labels:');
    lines.push('      - traefik.enable=true');
    for (const route of list) {
      const rule = buildRule(route);
      lines.push(`      - traefik.http.routers.${route.router}.rule=${rule}`);
      lines.push(`      - traefik.http.routers.${route.router}.entrypoints=${route.entrypoint}`);
      if (route.tls) {
        lines.push(`      - traefik.http.routers.${route.router}.tls=true`);
        // A named SSL configuration is matched by Traefik automatically, by
        // the hostname inside the certificate itself, so asking for a resolver
        // on top of that would mean ACME trying to issue one too.
        if (!route.cert && cfg.traefik.acme?.email) {
          lines.push(`      - traefik.http.routers.${route.router}.tls.certresolver=${resolver}`);
        }
      }
      if (route.middlewares.length) {
        lines.push(`      - traefik.http.routers.${route.router}.middlewares=${route.middlewares.join(',')}`);
      }
      lines.push(`      - traefik.http.services.${route.router}.loadbalancer.server.port=${route.port}`);
    }
    lines.push('');
  }

  lines.push('networks:');
  lines.push(`  ${network}:`);
  lines.push('    external: true');
  lines.push('');
  return lines.join('\n');
}

function buildRule(route: ResolvedRoute): string {
  const hosts = route.hosts.map((h) => `Host(\`${h}\`)`).join(' || ');
  const hostPart = route.hosts.length > 1 ? `(${hosts})` : hosts;
  if (!route.path || route.path === '/') return hostPart;
  return `${hostPart} && PathPrefix(\`${route.path}\`)`;
}

export function overlayPath(cfg: Config, project: Project, stack: Stack): string {
  return host.join(cfg.projectsDir, '.blankey', 'routes', `${slug(project.name)}__${slug(stack.name)}.yml`);
}

/**
 * Write the overlay if its contents changed, and hand back its path.
 *
 * Every compose invocation for a stack has to pass the same set of files, or
 * Compose sees a different configuration and recreates containers, so this is
 * resolved during discovery rather than at the moment of deploying.
 */
export async function ensureOverlay(
  cfg: Config,
  project: Project,
  stack: Stack,
  routes: ResolvedRoute[],
): Promise<string | null> {
  if (!routes.length) return null;
  const target = overlayPath(cfg, project, stack);
  await host.writeIfChanged(target, renderOverlay(cfg, routes));
  return target;
}
