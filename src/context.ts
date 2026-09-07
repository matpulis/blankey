import process from 'node:process';

import { discover, findStack } from './discover.js';
import * as host from './host.js';
import { fatal } from './ui/log.js';
import { c } from './ui/colors.js';
import { levenshtein, score } from './util.js';

/**
 * Shared per-invocation state. Discovery is memoized so a command can ask for
 * projects several times without rescanning the disk.
 */
export function createContext({ cfg, flags, positional, passthrough }) {
  let scan: any = null;
  return {
    cfg,
    flags,
    positional,
    passthrough,
    json: Boolean(flags.json),
    yes: Boolean(flags.yes),
    async projects({ refresh = false }: any = {}) {
      if (!scan || refresh) scan = await discover(cfg);
      if (scan.missingRoot) {
        fatal(`Projects directory does not exist: ${scan.root}`, {
          hint: host.isRemote()
            ? `Checked on ${host.remoteLabel()}. Fix projectsDir in ${cfg.__file}`
            : `Create it, or point projectsDir somewhere else in ${cfg.__file}`,
        });
      }
      return scan.projects;
    },
    async project(name, { required = true }: any = {}) {
      const list = await this.projects();
      const found = resolveProject(list, name, cfg);
      if (!found && required) failUnknown(name, list);
      return found;
    },
    /** Resolve `name`, `name:stack` or `name/stack` (plus `.` for cwd) to a stack. */
    async target(spec, { stackFlag }: any = {}) {
      const list = await this.projects();
      const { name, stack } = splitSpec(spec);
      const project = resolveProject(list, name, cfg);
      if (!project) failUnknown(name, list);
      const stackName = stackFlag || stack || null;
      const s = findStack(project, stackName);
      if (!s) {
        fatal(`Project ${c.bold(project.name)} has no stack named ${c.bold(stackName)}`, {
          hint: `Available: ${project.stacks.map((x) => x.name).join(', ')}`,
        });
      }
      return { project, stack: s };
    },
    /** Targets for bulk commands: explicit names, or everything when --all. */
    async targets(specs, { stackFlag, all }: any = {}) {
      const list = await this.projects();
      if (all || (!specs.length && flags.all)) {
        return list.map((p) => ({ project: p, stack: findStack(p, stackFlag) })).filter((t) => t.stack);
      }
      if (!specs.length) {
        const here = detectCwdProject(list);
        if (here) return [await this.target(here.name, { stackFlag })];
        fatal('No project specified.', { hint: 'Pass a project name, or --all for every project.' });
      }
      const out: any[] = [];
      for (const spec of specs) out.push(await this.target(spec, { stackFlag }));
      return out;
    },
  };
}

export function splitSpec(spec) {
  if (!spec) return { name: null, stack: null };
  const m = /^([^:/]+)[:/](.+)$/.exec(String(spec));
  if (m) return { name: m[1], stack: m[2] };
  return { name: String(spec), stack: null };
}

function detectCwdProject(list) {
  const cwd = host.toPosix(process.cwd()).toLowerCase();
  return list.find((p) => {
    const dir = host.toPosix(p.dir).toLowerCase();
    return cwd === dir || cwd.startsWith(dir + '/');
  }) || null;
}

export function resolveProject(list, name, cfg) {
  if (!name || name === '.') {
    const here = detectCwdProject(list);
    if (here) return here;
    if (name === '.') return null;
  }
  const exact = list.find((p) => p.name === name);
  if (exact) return exact;
  const ci = list.find((p) => p.name.toLowerCase() === String(name).toLowerCase());
  if (ci) return ci;
  const alias = cfg?.projects
    ? Object.entries(cfg.projects).find(([, v]: [string, any]) => v && v.alias === name)
    : null;
  if (alias) return list.find((p) => p.name === alias[0]) || null;
  const ranked = list
    .map((p) => ({ p, s: score(String(name), p.name) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  if (ranked.length === 1) return ranked[0].p;
  if (ranked.length > 1 && ranked[0].s > ranked[1].s + 100) return ranked[0].p;
  return null;
}

function failUnknown(name, list) {
  const near = list
    .map((p) => ({ name: p.name, d: levenshtein(String(name || ''), p.name) }))
    .sort((a, b) => a.d - b.d)
    .filter((x) => x.d <= Math.max(3, Math.round(x.name.length / 2)))
    .slice(0, 3)
    .map((x) => x.name);
  fatal(`Unknown project: ${c.bold(String(name))}`, {
    hint: near.length
      ? `Did you mean ${near.join(', ')}?`
      : list.length
        ? `Known projects: ${list.map((p) => p.name).join(', ')}`
        : 'No projects discovered yet. Run `blankey ls` to check your projectsDir.',
  });
}

export function stackLabel(project, stack) {
  return stack.name === 'default' ? project.name : `${project.name}${c.faint(':')}${stack.name}`;
}

