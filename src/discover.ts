import { parseYaml } from './yaml.js';
import * as host from './host.js';
import { pMap, unique } from './util.js';
import { log } from './ui/log.js';
import type { ComposeDoc, Project, Stack, Route, ServiceSummary } from './types.js';
import { resolveRoutes, ensureOverlay, urlsFor } from './routes.js';
import { listCerts } from './certs.js';

const COMPOSE_RE = /^(docker-)?compose(\.([A-Za-z0-9_-]+))?\.(ya?ml)$/;
const REPO_CONFIG_NAMES = ['.blankey.yml', '.blankey.yaml', 'blankey.yml', 'blankey.yaml'];

/** Classify one filename: base compose, override, or a named variant. */
export function classifyComposeFile(filename: string): { kind: string; stack: string; file: string } | null {
  const m = COMPOSE_RE.exec(filename);
  if (!m) return null;
  const variant = m[3] || null;
  if (!variant) return { kind: 'base', stack: 'default', file: filename };
  if (variant === 'override' || variant === 'overrides') return { kind: 'override', stack: 'default', file: filename };
  return { kind: 'variant', stack: variant, file: filename };
}

/**
 * A variant counts as an overlay (-f base -f variant) when it only patches
 * services the base already defines and leaves at least one without its own
 * image/build. Otherwise it is a standalone stack. Overridable per stack via
 * the .blankey.yml inside a repo.
 */
export function detectStackMode(baseDoc: ComposeDoc | null | undefined, variantDoc: ComposeDoc | null | undefined): string {
  if (!baseDoc || !baseDoc.services) return 'standalone';
  const varSvc = variantDoc && variantDoc.services;
  if (!varSvc || typeof varSvc !== 'object') return 'standalone';
  const names = Object.keys(varSvc);
  if (!names.length) return 'standalone';
  const allKnown = names.every((n) => Object.hasOwn(baseDoc.services as object, n));
  const somePatchOnly = names.some((n) => {
    const svc = varSvc[n] || {};
    return !svc.image && !svc.build;
  });
  return allKnown && somePatchOnly ? 'overlay' : 'standalone';
}

/**
 * Merge compose docs the way Compose does for the fields we read: services are
 * merged per key, and labels/environment merge entry-by-entry rather than the
 * later file replacing the whole list.
 */
function mergeDocs(docs: Array<ComposeDoc | null>): ComposeDoc {
  const out: ComposeDoc = { services: {}, networks: {}, volumes: {} };
  for (const doc of docs) {
    if (!doc) continue;
    for (const key of ['networks', 'volumes']) Object.assign(out[key] as object, doc[key] || {});
    for (const [name, svc] of Object.entries(doc.services || {})) {
      const prev = out.services![name] || {};
      const next = { ...prev, ...(svc || {}) };
      if (prev.labels || (svc && svc.labels)) {
        next.labels = { ...labelsToObject(prev.labels), ...labelsToObject(svc && svc.labels) };
      }
      if (prev.environment || (svc && svc.environment)) {
        next.environment = { ...labelsToObject(prev.environment), ...labelsToObject(svc && svc.environment) };
      }
      out.services![name] = next;
    }
    if (doc.name && !out.name) out.name = doc.name;
  }
  return out;
}

export function labelsToObject(labels: unknown): Record<string, string> {
  const obj: Record<string, string> = {};
  if (!labels) return obj;
  if (Array.isArray(labels)) {
    for (const item of labels) {
      const s = String(item);
      const eq = s.indexOf('=');
      if (eq < 0) { obj[s] = ''; continue; }
      obj[s.slice(0, eq).trim()] = s.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
    return obj;
  }
  for (const [k, v] of Object.entries(labels)) obj[k] = v === null ? '' : String(v);
  return obj;
}

const QUOTE_CLASS = '[' + String.fromCharCode(34, 39, 96) + ']';
const HOST_RE = new RegExp('Host\\(\\s*(' + QUOTE_CLASS + ')(.*?)\\1\\s*\\)', 'g');
const PATH_RE = new RegExp('Path(?:Prefix|Regexp)?\\(\\s*(' + QUOTE_CLASS + ')(.*?)\\1\\s*\\)', 'g');

/** Pull Traefik routers out of service labels so `blankey urls` can list them. */
export function extractRoutes(services: Record<string, any> | undefined): Route[] {
  const routes: Route[] = [];
  for (const [svcName, svc] of Object.entries(services || {})) {
    const labels = labelsToObject(svc && svc.labels);
    if (labels['traefik.enable'] === 'false') continue;

    const routers = new Map<string, Record<string, string>>();
    for (const [key, value] of Object.entries(labels)) {
      const m = /^traefik\.http\.routers\.([^.]+)\.(.+)$/.exec(key);
      if (!m) continue;
      const [, router, prop] = m;
      if (!routers.has(router)) routers.set(router, {});
      routers.get(router)![prop] = value;
    }
    const portLabel = Object.entries(labels).find(([k]) =>
      /^traefik\.http\.services\..+\.loadbalancer\.server\.port$/.test(k));

    for (const [router, props] of routers) {
      const rule = props.rule || '';
      if (!rule) continue;
      const hosts = unique([...rule.matchAll(HOST_RE)].map((x) => x[2] as string));
      const paths = unique([...rule.matchAll(PATH_RE)].map((x) => x[2] as string));
      const tls = props.tls === 'true' || Boolean(props['tls.certresolver']) ||
        String(props.entrypoints || '').includes('websecure');
      const scheme = tls ? 'https' : 'http';
      const suffix = paths[0] && paths[0] !== '/' ? paths[0] : '';
      routes.push({
        router,
        service: svcName,
        rule,
        hosts,
        paths,
        entrypoints: String(props.entrypoints || '').split(',').filter(Boolean),
        certResolver: props['tls.certresolver'] || null,
        middlewares: String(props.middlewares || '').split(',').filter(Boolean),
        tls,
        port: portLabel ? Number(portLabel[1]) : null,
        urls: hosts.map((h) => scheme + '://' + h + suffix),
      });
    }
  }
  return routes;
}

function summarizeServices(services: Record<string, any> | undefined): ServiceSummary[] {
  return Object.entries(services || {}).map(([name, svc]) => ({
    name,
    image: (svc && svc.image) || null,
    build: svc && svc.build ? (typeof svc.build === 'string' ? svc.build : svc.build.context || '.') : null,
    ports: (Array.isArray(svc && svc.ports) ? svc.ports : []).map((p) =>
      (p && typeof p === 'object' ? [p.published, p.target].filter(Boolean).join(':') : String(p))),
    networks: Array.isArray(svc && svc.networks) ? svc.networks : Object.keys((svc && svc.networks) || {}),
    restart: (svc && svc.restart) || null,
    profiles: (svc && svc.profiles) || [],
    dependsOn: Array.isArray(svc && svc.depends_on) ? svc.depends_on : Object.keys((svc && svc.depends_on) || {}),
    envFiles: ([] as any[]).concat((svc && svc.env_file) || []).map((e: any) => (e && typeof e === 'object' ? e.path : e)).filter(Boolean),
    hasHealthcheck: Boolean(svc && svc.healthcheck),
  }));
}

async function readDoc(dir: string, file: string): Promise<ComposeDoc | null> {
  const text = await host.readFile(host.join(dir, file));
  if (text === null) return null;
  try {
    return parseYaml(text);
  } catch (e) {
    log.debug('yaml parse failed for ' + file + ': ' + e.message);
    return null;
  }
}

/** Build the stack list for one repo directory. */
export async function readProject(cfg: any, name: string, dir: string): Promise<Project | null> {
  const files = await host.listFiles(dir);
  const composeFiles = files.map(classifyComposeFile).filter(Boolean) as Array<{ kind: string; stack: string; file: string }>;
  if (!composeFiles.length) return null;

  const repoCfgName = REPO_CONFIG_NAMES.find((n) => files.includes(n));
  const repoCfg = repoCfgName ? (parseYaml(await host.readFile(host.join(dir, repoCfgName))) || {}) : {};
  if (repoCfg.ignore === true) return null;

  const base = composeFiles.find((f) => f.kind === 'base');
  const override = composeFiles.find((f) => f.kind === 'override');
  const variants = composeFiles.filter((f) => f.kind === 'variant');

  const docs = new Map<string, ComposeDoc | null>();
  await pMap(composeFiles, async (f) => { docs.set(f.file, await readDoc(dir, f.file)); }, 6);

  // Central overrides (blankey.yml's projects.<name>) let you set isolateStacks
  // or a stack's projectName without adding a file to the repo itself. The
  // repo's own .blankey.yml, when present, still wins.
  //
  // Defaults to true: a named stack that shared its project name with another
  // stack in the same repo would mean the same containers, since Compose keys
  // containers by project + service, not by which file created them, so a
  // deploy of one silently becomes a deploy of the other. The "default" stack
  // is exempt regardless of this setting (see `derived` below), so it still
  // matches what Compose would pick on its own and never orphans containers
  // you started by hand before adopting blankey.
  const central = (cfg.projects && cfg.projects[name]) || {};
  const isolate = repoCfg.isolateStacks ?? central.isolateStacks ?? cfg.isolateStacks ?? true;
  const projectBase = repoCfg.name || name;
  const stacks: Stack[] = [];

  const makeStack = (stackName: string, fileList: string[], mode: string): Stack => {
    const declared = (repoCfg.stacks && repoCfg.stacks[stackName]) || {};
    const centralStack = (central.stacks && central.stacks[stackName]) || {};
    const stackFiles = declared.files || fileList;
    const merged = mergeDocs(stackFiles.map((f) => docs.get(f)).filter(Boolean));
    const derived = stackName === 'default' || !isolate ? projectBase : projectBase + '-' + stackName;
    return {
      name: stackName,
      project: name,
      dir,
      files: stackFiles,
      // The default stack runs without -f so Compose picks up its own override
      // file exactly as it would on the command line.
      explicitFiles: stackName === 'default' && !declared.files ? [] : stackFiles,
      mode: declared.mode || mode,
      projectName: declared.projectName || centralStack.projectName || merged.name || derived,
      envFile: declared.env || null,
      profiles: declared.profiles || [],
      healthcheck: declared.healthcheck || repoCfg.healthcheck || null,
      services: summarizeServices(merged.services),
      routes: extractRoutes(merged.services),
      networks: Object.keys(merged.networks || {}),
      volumes: Object.keys(merged.volumes || {}),
      doc: merged,
    };
  };

  if (base) stacks.push(makeStack('default', [base.file, ...(override ? [override.file] : [])], 'base'));
  for (const v of variants) {
    const mode = base ? detectStackMode(docs.get(base.file), docs.get(v.file)) : 'standalone';
    const fileList = mode === 'overlay' && base ? [base.file, v.file] : [v.file];
    stacks.push(makeStack(v.stack, fileList, mode));
  }
  if (!stacks.length) return null;

  const wanted = repoCfg.defaultStack || (cfg.defaults && cfg.defaults.stack) || 'default';
  const isGit = await host.exists(host.join(dir, '.git'));

  const project: Project = {
    name,
    dir,
    stacks,
    defaultStack: stacks.some((s) => s.name === wanted) ? wanted : stacks[0].name,
    repoConfig: repoCfg,
    repoConfigFile: repoCfgName || null,
    hooks: repoCfg.hooks || {},
    // A repo with a remote blankey should leave alone: `updates: false`.
    autoUpdate: repoCfg.updates !== false,
    hasEnv: files.includes('.env'),
    envFiles: files.filter((f) => f === '.env' || f.startsWith('.env.')),
    isGit,
    files,
  };

  await attachManagedRoutes(cfg, project);
  return project;
}

/**
 * Fold in routing that blankey supplies itself.
 *
 * The generated overlay has to be part of every compose invocation for the
 * stack, not just deploys: passing a different set of files would make Compose
 * see a different configuration and recreate containers. Resolving it here, in
 * discovery, is what guarantees that.
 */
async function attachManagedRoutes(cfg: any, project: Project): Promise<void> {
  const knownCerts = new Set((await listCerts(cfg)).map((c) => c.name));
  for (const stack of project.stacks) {
    const { routes, problems } = resolveRoutes(cfg, project, stack, { knownCerts });
    if (!routes.length && !problems.length) continue;

    const overlay = routes.length ? await ensureOverlay(cfg, project, stack, routes) : null;
    stack.managed = { routes, overlay, problems };

    if (!overlay) continue;
    // The default stack normally runs with no -f so Compose finds its own
    // override file. Adding one file means naming them all.
    stack.explicitFiles = [...stack.files, overlay];
    stack.routes = [
      ...stack.routes,
      ...routes.map((r) => ({
        router: r.router,
        service: r.service,
        rule: '',
        hosts: r.hosts,
        paths: r.path ? [r.path] : [],
        entrypoints: [r.entrypoint],
        certResolver: r.tls ? (r.cert || cfg.traefik.acme?.resolver || 'le') : null,
        middlewares: r.middlewares,
        tls: r.tls,
        port: r.port,
        managed: true,
        urls: urlsFor(r.hosts, r),
      })),
    ];
  }
}

/** Scan the configured projects directory. */
export async function discover(cfg: any, { filter }: { filter?: string } = {}): Promise<{ root: string; projects: Project[]; missingRoot: boolean }> {
  const root = cfg.projectsDir;
  if (!(await host.exists(root))) return { root, projects: [], missingRoot: true };

  const ignore = new Set([...(cfg.ignore || []), '_traefik']);
  const traefikDirName = cfg.traefik && cfg.traefik.dir ? cfg.traefik.dir.split(/[\\/]/).pop() : null;
  if (traefikDirName) ignore.add(traefikDirName);

  const names = (await host.listDirs(root))
    .filter((n) => !n.startsWith('.') && !ignore.has(n))
    .sort((a, b) => a.localeCompare(b));

  const found = await pMap(names, async (n) => {
    try {
      return await readProject(cfg, n, host.join(root, n));
    } catch (e) {
      log.debug('discover ' + n + ' failed: ' + e.message);
      return null;
    }
  }, 8);

  const projects = filterProjects(found.filter(Boolean) as Project[], filter);
  return { root, projects, missingRoot: false };
}

/**
 * Narrow a project list by a name fragment. An empty filter means everything,
 * so callers can pass an optional positional argument straight through.
 */
export function filterProjects(projects: Project[], filter?: unknown): Project[] {
  const needle = String(filter ?? '').toLowerCase();
  return needle ? projects.filter((p) => p.name.toLowerCase().includes(needle)) : projects;
}

export function findStack(project: Project, stackName?: string | null): Stack | null {
  if (!stackName) return project.stacks.find((s) => s.name === project.defaultStack) || project.stacks[0];
  return project.stacks.find((s) => s.name === stackName) || null;
}
