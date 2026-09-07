import { table } from '../ui/table.js';
import { log } from '../ui/log.js';
import { c, P, fg } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { rule } from '../ui/box.js';
import { stackCell, modeTag, urlCell } from '../ui/render.js';
import * as host from '../host.js';
import { filterProjects } from '../discover.js';

export default {
  name: 'list',
  aliases: ['ls'],
  group: 'Monitor',
  describe: 'Discover every repo and the compose stacks inside it',
  usage: 'list [filter] [--long] [--json]',
  flagAliases: { l: 'long' },
  options: [
    ['-l, --long', 'show services, files and routes for each stack'],
    ['    --json', 'emit the discovered topology as JSON'],
  ],
  examples: [
    ['blankey ls', 'one line per stack'],
    ['blankey ls shop --long', 'full detail for repos matching "shop"'],
  ],
  async run(ctx) {
    const projects = await ctx.projects();
    const filter = ctx.positional[0];
    const list = filterProjects(projects, filter);

    if (ctx.json) {
      log.raw(JSON.stringify(list.map(serialize), null, 2));
      return 0;
    }

    if (!list.length) {
      log.blank();
      log.warn(filter ? `No projects matched ${c.bold(String(filter))}.` : 'No projects with compose files found.');
      log.hint(`Looked in ${ctx.cfg.projectsDir}${host.isRemote() ? ' on ' + host.remoteLabel() : ''}`);
      log.blank();
      return 1;
    }

    log.blank();
    log.raw(rule(`${list.length} project${list.length === 1 ? '' : 's'} in ${ctx.cfg.projectsDir}`));
    log.blank();

    if (ctx.flags.long) {
      for (const p of list) renderLong(p);
      return 0;
    }

    const rows: any[] = [];
    for (const p of list) {
      for (const s of p.stacks) {
        rows.push({
          name: stackCell(p, s),
          services: c.muted(String(s.services.length)),
          files: c.faint(s.files.join(' + ')),
          mode: modeTag(s),
          routes: urlCell(s.routes),
          marks: marks(p, s),
        });
      }
    }
    log.raw(table(rows, [
      { key: 'name', label: 'stack', min: 12 },
      { key: 'services', label: 'svc', align: 'right', grow: false },
      { key: 'mode', label: 'mode', grow: false },
      { key: 'files', label: 'compose files', min: 14 },
      { key: 'routes', label: 'routes', min: 10 },
      { key: 'marks', label: '', grow: false },
    ]));
    log.blank();
    log.raw(c.faint(`  ${S.bullet} default stack is marked ${fg(P.accent, S.star)}   ${S.bullet} run \`blankey ls -l\` for detail`));
    log.blank();
    return 0;
  },
};

function marks(project, stack) {
  const out: any[] = [];
  if (stack.name === project.defaultStack) out.push(fg(P.accent, S.star));
  if (!project.isGit) out.push(c.faint('no-git'));
  if (project.repoConfigFile) out.push(fg(P.brand2, S.pkg));
  return out.join(' ');
}

function renderLong(p) {
  log.raw(`${c.bold(fg(P.brand2, p.name))}  ${c.faint(p.dir)}`);
  const bits: any[] = [];
  if (p.isGit) bits.push('git'); else bits.push(c.faint('not a git repo'));
  if (p.repoConfigFile) bits.push(`config ${p.repoConfigFile}`);
  if (p.envFiles.length) bits.push(`env ${p.envFiles.join(', ')}`);
  log.raw('  ' + c.muted(bits.join(c.faint('  ' + S.bullet + '  '))));

  for (const s of p.stacks) {
    const star = s.name === p.defaultStack ? fg(P.accent, ' ' + S.star) : '';
    log.raw(`  ${c.faint(S.tee)} ${c.bold(s.name)}${star}  ${modeTag(s)}  ${c.faint(s.files.join(' + '))}`);
    log.raw(`  ${c.faint(S.vline)}   ${c.muted('project')} ${c.faint(s.projectName)}`);
    const svcs = s.services.map((x) =>
      fg(x.build ? P.pink : P.info, x.name) + (x.image ? c.faint(':' + shortImage(x.image)) : c.faint(' (build)')));
    log.raw(`  ${c.faint(S.vline)}   ${c.muted('services')} ${svcs.join(c.faint(', ')) || c.faint('none')}`);
    for (const r of s.routes) {
      log.raw(`  ${c.faint(S.vline)}   ${c.muted('route')} ${fg(P.info, r.urls.join(', ') || r.rule)}` +
        (r.port ? c.faint(` ${S.arrow} :${r.port}`) : '') +
        (r.certResolver ? c.faint(` [${r.certResolver}]`) : ''));
    }
  }
  log.blank();
}

function shortImage(image) {
  const parts = String(image).split('/');
  return parts[parts.length - 1];
}

function serialize(p) {
  return {
    name: p.name,
    dir: p.dir,
    isGit: p.isGit,
    defaultStack: p.defaultStack,
    envFiles: p.envFiles,
    repoConfigFile: p.repoConfigFile,
    stacks: p.stacks.map((s) => ({
      name: s.name,
      mode: s.mode,
      files: s.files,
      projectName: s.projectName,
      services: s.services,
      routes: s.routes,
      networks: s.networks,
      volumes: s.volumes,
    })),
  };
}
