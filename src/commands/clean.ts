import { log, cancelled } from '../ui/log.js';
import { c, P, fg, bold, badge } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { Spinner } from '../ui/spinner.js';
import { confirm } from '../ui/prompt.js';
import { table } from '../ui/table.js';
import { rule, box, meter } from '../ui/box.js';
import * as host from '../host.js';
import * as docker from '../docker.js';
import { bytes, parseSize, firstLine } from '../util.js';

export const SAFE = ['containers', 'images', 'cache', 'networks', 'logs'];
export const ALL = [...SAFE, 'unused-images', 'volumes'];

export default {
  name: 'clean',
  aliases: ['prune', 'gc'],
  group: 'Maintenance',
  describe: 'Show what disk space can be reclaimed, then reclaim it',
  usage: 'clean [target...] [--safe] [--all] [--json]',
  valueFlags: [],
  options: [
    ['    --safe', `run everything that cannot lose data (${SAFE.join(', ')})`],
    ['    --all', 'also unused images and volumes (volumes can lose data)'],
    ['    --logs', 'shorthand for the logs target'],
    ['-y, --yes', 'skip the confirmation'],
    ['    --json', 'emit the survey as JSON'],
  ],
  details:
    'With no target it only looks: nothing is removed, and every row shows what\n' +
    'running it would free. Name targets to act on them.\n' +
    '\n' +
    `Targets: ${ALL.join(', ')}\n` +
    '\n' +
    'Volumes are never included in --safe. An unused volume is still the database\n' +
    'of a stack that happens to be stopped, so removing it is a data-loss risk you\n' +
    'have to ask for by name.',
  examples: [
    ['blankey clean', 'the bill, without paying it'],
    ['blankey clean --safe', 'stopped containers, dangling images, cache, networks, logs'],
    ['blankey clean logs cache', 'just those two'],
    ['blankey clean volumes -y', 'the destructive one, asked for explicitly'],
  ],
  async run(ctx) {
    const requested = resolveTargets(ctx);
    if (requested.invalid.length) {
      log.blank();
      log.fail(`Unknown target: ${requested.invalid.map((t) => c.bold(t)).join(', ')}`);
      log.hint(`Valid targets: ${ALL.join(', ')}`);
      log.blank();
      return 1;
    }

    const sp = ctx.json ? null : new Spinner('measuring what can be reclaimed').start();
    const [{ targets, df }, memory] = await Promise.all<any>([
      docker.surveyReclaimable(),
      ctx.json || requested.names.length ? Promise.resolve([]) : docker.memoryUsage(),
    ]);
    sp?.stop(null);

    if (ctx.json) {
      log.raw(JSON.stringify({
        total: targets.reduce((s, t) => s + t.bytes, 0),
        targets: targets.map(({ logs, ...rest }) => rest),
        diskUsage: df,
      }, null, 2));
      return 0;
    }

    // Nothing named: this is the preview the user asked for.
    if (!requested.names.length) {
      renderSurvey(targets, df, memory);
      return 0;
    }

    const chosen = targets.filter((t) => requested.names.includes(t.key));
    const actionable = chosen.filter((t) => t.count > 0);
    const reclaimable = chosen.reduce((s, t) => s + t.bytes, 0);

    log.blank();
    log.raw(rule('about to clean'));
    log.blank();
    log.raw(renderTable(chosen));
    log.blank();

    if (!actionable.length) {
      log.raw(`  ${c.ok(S.tick)} ${c.muted('Nothing to clean in those targets.')}`);
      log.blank();
      return 0;
    }

    const destructive = actionable.filter((t) => t.destructive);
    if (destructive.length) {
      log.raw(box(
        destructive.map((t) => `${c.err(S.warn)} ${bold(t.label)}: ${t.note}`)
          .concat(destructive.flatMap((t) => (t.items || []).slice(0, 8).map((i) => `    ${c.faint(i)}`))),
        { title: 'this can lose data', color: P.err },
      ));
      log.blank();
    }

    log.raw(`  ${c.muted('This would free about')} ${bold(fg(P.ok, bytes(reclaimable)))}`);
    log.blank();
    if (!ctx.yes && !(await confirm('  Go ahead?', { def: false }))) {
      return cancelled();
    }

    log.blank();
    let freed = 0;
    let failed = 0;
    for (const target of actionable) {
      const spin = new Spinner(`${c.muted('cleaning')} ${target.label}`).start();
      const res: any = target.key === 'logs'
        ? await clearLogs(target, spin)
        : await runPrune(target);

      if (res.ok) {
        freed += res.freed || 0;
        spin.succeed(`${bold(target.label)} ${c.faint(res.detail || 'done')}`);
      } else {
        failed++;
        spin.fail(`${bold(target.label)} ${c.err(firstLine(res.error || 'failed'))}`);
      }
    }

    log.blank();
    log.raw(`  ${badge(' RECLAIMED ', P.ok)} ${bold(bytes(freed))}`);
    if (freed < reclaimable * 0.5 && reclaimable > 0) {
      log.raw(`  ${c.faint('Less than the estimate: Docker only frees what nothing else still references.')}`);
    }
    log.blank();
    return failed ? 1 : 0;
  },
};

export function resolveTargets(ctx) {
  const named = ctx.positional.filter(Boolean);
  const names = new Set(named.filter((n) => ALL.includes(n)));
  const invalid = named.filter((n) => !ALL.includes(n));
  if (ctx.flags.safe) for (const t of SAFE) names.add(t);
  if (ctx.flags.all) for (const t of ALL) names.add(t);
  if (ctx.flags.logs) names.add('logs');
  return { names: [...names], invalid };
}

async function runPrune(target) {
  const r = await host.exec(target.command, { timeout: 900000 });
  if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
  const m = /Total reclaimed space:\s*(.+)/i.exec(r.stdout);
  const freed = m ? parseSize(m[1]) : 0;
  return { ok: true, freed, detail: m ? `freed ${bytes(freed)}` : 'done' };
}

async function clearLogs(target, spin) {
  let freed = 0;
  let failures = 0;
  for (const item of target.logs || []) {
    spin.update(`${c.muted('clearing log')} ${c.faint(item.name)}`);
    const r = await docker.clearContainerLogs(item.name);
    if (r.ok) freed += r.cleared || item.bytes;
    else failures++;
  }
  if (failures && !freed) return { ok: false, error: `could not clear ${failures} log file(s)` };
  return {
    ok: true,
    freed,
    detail: `freed ${bytes(freed)}${failures ? `, ${failures} skipped` : ''}`,
  };
}

function renderTable(targets) {
  return table(targets.map((t) => ({
    icon: t.count === 0 ? c.faint(S.ring) : t.destructive ? c.err(S.warn) : c.ok(S.dot),
    label: t.count ? bold(t.label) : c.muted(t.label),
    count: t.count ? c.muted(String(t.count)) : c.faint('0'),
    size: t.bytes ? bold(fg(t.destructive ? P.warn : P.ok, bytes(t.bytes))) : c.faint('—'),
    note: c.faint(t.note),
  })), [
    { key: 'icon', label: '', grow: false },
    { key: 'label', label: 'target', min: 16 },
    { key: 'count', label: 'items', align: 'right', grow: false },
    { key: 'size', label: 'reclaimable', align: 'right', grow: false },
    { key: 'note', label: '', min: 10 },
  ]);
}

function renderSurvey(targets, df, memory) {
  const safeTotal = targets.filter((t) => SAFE.includes(t.key)).reduce((s, t) => s + t.bytes, 0);
  const allTotal = targets.reduce((s, t) => s + t.bytes, 0);

  log.blank();
  log.raw(rule('reclaimable disk'));
  log.blank();
  log.raw(renderTable(targets));
  log.blank();

  if (df?.length) {
    const used = df.reduce((s, r) => s + parseSize(r.Size), 0);
    if (used > 0) {
      log.raw(`  ${meter(allTotal, used, { size: 30, color: P.ok })} ` +
        `${bold(bytes(allTotal))} ${c.muted('of')} ${bold(bytes(used))} ${c.muted('used by Docker is reclaimable')}`);
      log.blank();
    }
  }

  // Biggest log files, since one runaway container is usually the whole problem.
  const logsTarget = targets.find((t) => t.key === 'logs');
  if (logsTarget?.logs?.length) {
    const top = logsTarget.logs.slice(0, 5).filter((l) => l.bytes > 1e6);
    if (top.length) {
      log.raw(`  ${c.muted('largest log files')}`);
      for (const item of top) {
        log.raw(`    ${c.faint(S.bullet)} ${bold(item.service || item.name)} ${c.faint(item.name)} ${fg(P.warn, bytes(item.bytes))}`);
      }
      log.blank();
    }
  }

  if (memory?.length) {
    const top = memory.slice(0, 5).filter((m) => m.bytes > 0);
    if (top.length) {
      log.raw(`  ${c.muted('memory in use')} ${c.faint('(pruning does not free this, restarting the container does)')}`);
      for (const m of top) {
        log.raw(`    ${c.faint(S.bullet)} ${bold(m.name)} ${fg(P.info, m.mem)} ${c.faint(m.memPerc + ' of host, cpu ' + m.cpu)}`);
      }
      log.blank();
    }
  }

  log.raw(box([
    `${c.bold('blankey clean --safe')}    ${c.muted('frees')} ${bold(fg(P.ok, bytes(safeTotal)))} ${c.muted('with no risk of data loss')}`,
    `${c.bold('blankey clean --all')}     ${c.muted('frees')} ${bold(fg(P.warn, bytes(allTotal)))} ${c.muted('including unused images and volumes')}`,
    `${c.bold('blankey clean logs')}      ${c.muted('or name any single target')}`,
  ], { title: 'what next' }));
  log.blank();
}
