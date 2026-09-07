import { c, fg, badge, P, bold } from './colors.js';
import { S } from './symbols.js';
import { meter } from './box.js';
import { ellipsis } from '../util.js';

export const STATE_STYLE = {
  running: { color: P.ok, label: 'running', dot: S.dot },
  starting: { color: P.info, label: 'starting', dot: S.ring },
  partial: { color: P.warn, label: 'partial', dot: S.dot },
  unhealthy: { color: P.err, label: 'unhealthy', dot: S.dot },
  restarting: { color: P.warn, label: 'restarting', dot: S.dot },
  stopped: { color: P.faint, label: 'stopped', dot: S.ring },
  unknown: { color: P.faint, label: 'unknown', dot: S.ring },
};

export function stateDot(state) {
  const s = STATE_STYLE[state] || STATE_STYLE.unknown;
  return fg(s.color, s.dot);
}

export function stateText(state) {
  const s = STATE_STYLE[state] || STATE_STYLE.unknown;
  return fg(s.color, s.label);
}

export function stateBadge(state) {
  const s = STATE_STYLE[state] || STATE_STYLE.unknown;
  return badge(s.label.toUpperCase(), s.color);
}

/** `3/4` with the numerator coloured by how healthy the ratio is. */
export function ratio(running, total) {
  if (!total) return c.faint('0/0');
  const color = running === 0 ? P.faint : running < total ? P.warn : P.ok;
  return fg(color, String(running)) + c.faint('/' + total);
}

export function healthMeter(summary) {
  const style = STATE_STYLE[summary.state] || STATE_STYLE.unknown;
  return meter(summary.running, summary.total || 1, { size: 8, color: style.color });
}

/** Compact git indicator: branch, drift arrows and a dirty marker. */
export function gitCell(git) {
  if (!git || !git.isRepo) return c.faint('—');
  const parts: any[] = [];
  parts.push(c.muted(git.branch || 'detached'));

  // No upstream is a normal setup, not a problem. Say so, rather than showing a
  // tick that implies the repo is in sync with something.
  if (!git.upstream) {
    parts.push(c.faint('local'));
    if (git.dirty) parts.push(fg(P.pink, `${S.bullet}${git.dirty}`));
    return parts.join(' ');
  }

  if (git.behind) parts.push(fg(P.warn, `${S.down}${git.behind}`));
  if (git.ahead) parts.push(fg(P.info, `${S.up}${git.ahead}`));
  if (git.dirty) parts.push(fg(P.pink, `${S.bullet}${git.dirty}`));
  if (!git.behind && !git.ahead && !git.dirty) parts.push(fg(P.ok, S.tick));
  return parts.join(' ');
}

/**
 * The sha with the start of its message, because a sha on its own tells you
 * nothing about which commit it is. The authored age is left out here: the git
 * column already shows drift, which is the signal that matters in a table.
 */
export function commitCell(git, max = 30) {
  if (!git || !git.isRepo || !git.head) return c.faint('—');
  const subject = git.subject ? '  ' + subjectCell(git.subject, max) : '';
  return c.faint(git.head) + subject;
}

/** The commit message, so a sha can actually be identified at a glance. */
export function subjectCell(subject, max = 0) {
  if (!subject) return c.faint('—');
  return c.muted(ellipsis(subject, max));
}

/**
 * Which commit a stack moved to, and where from when it moved at all.
 *
 * A one-shot deploy never moves the tree, so showing `from → to` for one would
 * be a lie: the containers run `deployedSha` while the repo stays where it was.
 */
export function shaChange(record: {
  ephemeral?: boolean; deployedSha?: string | null; restoreTo?: string | null;
  fromSha?: string | null; toSha?: string | null;
}): string {
  if (record.ephemeral) {
    const where = record.restoreTo ?? record.toSha ?? '?';
    return fg(P.info, record.deployedSha || '—') + c.faint(` on ${where}`);
  }
  if (record.fromSha && record.toSha && record.fromSha !== record.toSha) {
    return c.faint(`${record.fromSha} ${S.arrow} `) + fg(P.info, record.toSha);
  }
  return c.faint(record.toSha || '—');
}

export function stackCell(project, stack) {
  if (stack.name === 'default') return c.bold(project.name);
  return c.bold(project.name) + c.faint(':') + fg(P.accent, stack.name);
}

export function urlCell(routes, { max = 2 }: any = {}) {
  const urls = routes.flatMap((r) => r.urls);
  if (!urls.length) return c.faint('—');
  const shown = urls.slice(0, max).map((u) => fg(P.info, u.replace(/^https?:\/\//, '')));
  if (urls.length > max) shown.push(c.faint(`+${urls.length - max}`));
  return shown.join(c.faint(', '));
}

export function modeTag(stack) {
  if (stack.mode === 'overlay') return c.faint('overlay');
  if (stack.mode === 'standalone') return c.faint('standalone');
  return c.faint('base');
}

/**
 * How one container is doing, as a colour. Stopped reads as absent rather than
 * broken; a container that is up but failing its healthcheck is the one worth
 * making loud.
 */
export function containerColor(ct): string {
  if (ct.state !== 'running') return P.faint;
  if (ct.health === 'unhealthy') return P.err;
  if (ct.health === 'starting') return P.info;
  return P.ok;
}

/** The same judgement as a single character: filled when up, hollow when not. */
export function containerDot(ct): string {
  const color = containerColor(ct);
  const filled = ct.state === 'running' && ct.health !== 'starting';
  return fg(color, filled ? S.dot : S.ring);
}

export function containerLine(ct) {
  // Docker already spells the health out inside Status, so say it once.
  const status = String(ct.status || ct.state).replace(/\s*\((healthy|unhealthy|health: starting|starting)\)\s*$/i, '');
  const health = ct.health
    ? (ct.health === 'unhealthy' ? fg(P.err, ` (${ct.health})`) : c.faint(` (${ct.health})`))
    : '';
  return `${containerDot(ct)} ${bold(ct.service || ct.name)}${health} ${c.faint(status)}`;
}

/** The published ports of a container, or a dash when it publishes none. */
export const portsCell = (ct): string => (ct.ports ? fg(P.info, String(ct.ports)) : c.faint('—'));

/**
 * The three columns every container table uses. Defined once so `ps`, `info`
 * and the grouped view cannot drift apart.
 */
export const containerRow = (ct) => ({
  line: containerLine(ct),
  image: c.faint(ct.image),
  ports: portsCell(ct),
});

export const CONTAINER_COLUMNS = [
  { key: 'line', label: 'container', min: 18 },
  { key: 'image', label: 'image', min: 12 },
  { key: 'ports', label: 'ports', min: 8 },
];

