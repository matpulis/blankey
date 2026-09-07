import process from 'node:process';
import { log } from '../ui/log.js';
import { c, fg, bold, gradient } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { table } from '../ui/table.js';
import { termWidth, meter } from '../ui/box.js';
import { stackCell, stateDot, stateText, ratio, urlCell, containerColor } from '../ui/render.js';
import * as docker from '../docker.js';
import * as host from '../host.js';
import { groupBy, sleep } from '../util.js';

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';
const HOME = '\x1b[H';
// Erasing each line as it is written avoids both leftover text and the flicker
// a full-screen clear causes on every refresh.
const CLEAR_LINE = '\x1b[K';
const CTRL_C = '\x03';

export default {
  name: 'watch',
  aliases: ['top'],
  group: 'Monitor',
  describe: 'Full-screen live dashboard that refreshes on its own',
  usage: 'watch [--interval <seconds>]',
  valueFlags: ['interval'],
  options: [['-i, --interval <s>', 'seconds between refreshes (default 5)']],
  flagAliases: { i: 'interval' },
  details: 'Press q or Ctrl+C to leave, r to refresh immediately.',
  async run(ctx) {
    const interval = Math.max(1, Number(ctx.flags.interval) || 5) * 1000;
    const projects = await ctx.projects();
    if (!projects.length) {
      log.warn('Nothing to watch yet.');
      return 0;
    }

    const out = process.stdout;
    if (!out.isTTY) {
      log.fail('watch needs an interactive terminal.');
      log.hint('Use `blankey status` for one-shot output.');
      return 1;
    }

    let running = true;
    let forceRefresh = false;
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    const cleanup = () => {
      running = false;
      if (stdin.setRawMode) stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      out.write(SHOW + ALT_OFF);
    };

    const onKey = (buf) => {
      const k = buf.toString();
      if (k === 'q' || k === CTRL_C) cleanup();
      if (k === 'r') forceRefresh = true;
    };

    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);
    process.on('SIGINT', cleanup);
    out.write(ALT_ON + HIDE);

    let tick = 0;
    try {
      while (running) {
        const frame = await renderFrame(ctx, projects, ++tick, interval);
        if (!running) break;
        out.write(HOME + frame);
        const until = Date.now() + interval;
        while (running && Date.now() < until && !forceRefresh) await sleep(120);
        forceRefresh = false;
      }
    } finally {
      cleanup();
    }
    return 0;
  },
};

async function renderFrame(ctx, projects, tick, interval) {
  const [containers, info] = await Promise.all([
    docker.listAllContainers(),
    tick === 1 ? docker.dockerInfo() : Promise.resolve(null),
  ]);
  (renderFrame as any).info = info || (renderFrame as any).info;
  const byProject = groupBy(containers, (ct) => ct.project);

  const rows: any[] = [];
  for (const p of projects) {
    for (const s of p.stacks) {
      rows.push({ p, s, summary: docker.summarizeStack(byProject.get(s.projectName) || [], s) });
    }
  }

  const running = rows.filter((r) => r.summary.state === 'running').length;
  const width = termWidth();
  const lines: any[] = [];

  lines.push('');
  const where = host.isRemote() ? host.remoteLabel() : 'local docker';
  const clock = new Date().toLocaleTimeString();
  const left = `  ${bold(gradient('blankey watch'))} ${c.faint(S.bullet)} ${c.muted(where)}`;
  lines.push(left + c.faint(`   ${clock}  every ${interval / 1000}s`));
  lines.push('  ' + meter(running, Math.max(rows.length, 1), { size: Math.min(48, width - 6) }) +
    `  ${bold(String(running))}${c.faint('/' + rows.length)} ${c.muted('running')}`);
  lines.push('');

  lines.push(table(rows.map((r) => ({
    dot: stateDot(r.summary.state),
    name: stackCell(r.p, r.s),
    state: stateText(r.summary.state),
    up: ratio(r.summary.running, r.summary.total),
    detail: detailFor(r.summary),
    urls: urlCell(r.s.routes, { max: 1 }),
  })), [
    { key: 'dot', label: '', grow: false },
    { key: 'name', label: 'stack', min: 12 },
    { key: 'state', label: 'state', grow: false },
    { key: 'up', label: 'up', align: 'right', grow: false },
    { key: 'detail', label: 'containers', min: 10 },
    { key: 'urls', label: 'url', min: 10 },
  ], { maxWidth: width }));

  lines.push('');
  const bad = rows.filter((r) => ['unhealthy', 'partial', 'restarting'].includes(r.summary.state));
  if (bad.length) {
    lines.push(`  ${c.err(S.warn)} ${bad.map((r) => bold(r.p.name)).join(', ')} ${c.muted('need attention')}`);
    lines.push('');
  }
  lines.push(c.faint(`  q quit   r refresh   ${S.bullet}   ${containers.length} containers on this host`));
  lines.push('');
  return lines.map((line) => line + CLEAR_LINE).join('\n') + '\x1b[0J';
}

function detailFor(summary) {
  const names = summary.containers
    .slice(0, 4)
    .map((ct) => fg(containerColor(ct), ct.service || ct.name));
  if (summary.containers.length > 4) names.push(c.faint(`+${summary.containers.length - 4}`));
  return names.join(c.faint(' ')) || c.faint('—');
}

