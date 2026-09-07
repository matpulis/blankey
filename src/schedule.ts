import * as host from './host.js';
import { q, failureText } from './host.js';
import { lines } from './util.js';

/**
 * Installing a scheduled backup.
 *
 * The requirement is that re-scheduling replaces the existing job rather than
 * stacking a second one. That is guaranteed structurally: both mechanisms write
 * to a single well-known path (a systemd unit pair, or one file in
 * /etc/cron.d), so writing is inherently a replace. Appending to a user crontab
 * (the usual way people do this) is exactly what produces duplicates, so it is
 * never used here.
 *
 * Installing also removes the other mechanism's artifacts, so switching between
 * systemd and cron cannot leave both firing.
 */

const UNIT = (name) => `/etc/systemd/system/${name}.service`;
const TIMER = (name) => `/etc/systemd/system/${name}.timer`;
const CRON = (name) => `/etc/cron.d/${name}`;

/** Translate a friendly schedule into both a cron expression and OnCalendar. */
export function normalizeSchedule(spec, { at = '03:00' }: any = {}) {
  const [hh, mm] = String(at).split(':');
  const hour = Math.min(23, Math.max(0, Number(hh) || 0));
  const minute = Math.min(59, Math.max(0, Number(mm) || 0));
  const value = String(spec || 'daily').trim();

  if (/^(\S+\s+){4}\S+$/.test(value)) {
    // Already a cron expression; systemd gets a nearby equivalent only for the
    // simple cases, otherwise cron is used.
    return { kind: 'cron', cron: value, onCalendar: null, label: value };
  }
  switch (value.toLowerCase()) {
    case 'hourly':
      return { kind: 'hourly', cron: `${minute} * * * *`, onCalendar: `*-*-* *:${pad(minute)}:00`, label: `every hour at :${pad(minute)}` };
    case 'weekly':
      return { kind: 'weekly', cron: `${minute} ${hour} * * 1`, onCalendar: `Mon *-*-* ${pad(hour)}:${pad(minute)}:00`, label: `every Monday at ${pad(hour)}:${pad(minute)}` };
    case 'daily':
    default:
      return { kind: 'daily', cron: `${minute} ${hour} * * *`, onCalendar: `*-*-* ${pad(hour)}:${pad(minute)}:00`, label: `every day at ${pad(hour)}:${pad(minute)}` };
  }
}

const pad = (n) => String(n).padStart(2, '0');

/** Does the host run systemd, and can we write to system paths? */
export async function inspectHost() {
  const [systemd, uid, blankey, bk] = await Promise.all([
    host.exec('systemctl --version', { timeout: 15000 }),
    host.exec('id -u', { timeout: 10000 }),
    host.exec('command -v blankey', { timeout: 10000 }),
    host.exec('command -v bk', { timeout: 10000 }),
  ]);
  const binary = (blankey.code === 0 && blankey.stdout.trim())
    || (bk.code === 0 && bk.stdout.trim())
    || null;
  return {
    systemd: systemd.code === 0,
    root: uid.stdout.trim() === '0',
    binary,
  };
}

/** Run a command as root, escalating only when needed. */
async function asRoot(cmd, { root }) {
  if (root) return host.exec(cmd, { timeout: 60000 });
  const r = await host.exec(`sudo -n sh -c ${q(cmd)}`, { timeout: 60000 });
  return r;
}

async function writeAsRoot(path, content, ctx) {
  const marker = 'BLANKEY_UNIT_EOF';
  const script = `cat > ${q(path)} <<'${marker}'\n${content}\n${marker}`;
  return asRoot(script, ctx);
}

export function unitFiles(name, { binary, configPath, schedule, args }) {
  const configFlag = configPath ? ` --config ${configPath}` : '';
  const command = `${binary} backup --all --yes --quiet${configFlag}${args ? ' ' + args : ''}`;

  const service = [
    '# Managed by blankey. Rewritten in place by `blankey backup schedule`.',
    '[Unit]',
    'Description=blankey volume backup to S3',
    'After=docker.service network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${command}`,
    // blankey takes its own lock, but this stops systemd starting a second run.
    'TimeoutStartSec=6h',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');

  const timer = [
    '# Managed by blankey. Rewritten in place by `blankey backup schedule`.',
    '[Unit]',
    'Description=blankey volume backup schedule',
    '',
    '[Timer]',
    `OnCalendar=${schedule.onCalendar}`,
    'Persistent=true',
    'RandomizedDelaySec=300',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');

  const cron = [
    '# Managed by blankey. Rewritten in place by `blankey backup schedule`.',
    'SHELL=/bin/sh',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `${schedule.cron} root ${command} >> /var/log/blankey-backup.log 2>&1`,
    '',
  ].join('\n');

  return { service, timer, cron, command };
}

/** Remove every scheduling artifact, both mechanisms. Safe to call repeatedly. */
export async function removeSchedule(cfg, ctx) {
  const name = cfg.backup.schedule.unit || 'blankey-backup';
  const removed: any[] = [];

  if (ctx.systemd) {
    const active = await host.exec(`systemctl list-unit-files ${q(name + '.timer')}`, { timeout: 20000 });
    if (active.code === 0 && active.stdout.includes(name)) {
      await asRoot(`systemctl disable --now ${q(name + '.timer')}`, ctx);
      removed.push(`${name}.timer`);
    }
  }
  for (const path of [TIMER(name), UNIT(name)]) {
    if (await host.exists(path)) {
      await asRoot(`rm -f ${q(path)}`, ctx);
      removed.push(path);
    }
  }
  if (await host.exists(CRON(name))) {
    await asRoot(`rm -f ${q(CRON(name))}`, ctx);
    removed.push(CRON(name));
  }
  if (ctx.systemd && removed.length) await asRoot('systemctl daemon-reload', ctx);
  return removed;
}

/**
 * Install the schedule. Always clears any previous job first, including one
 * installed through the other mechanism, so exactly one ends up armed.
 */
export async function installSchedule(cfg, { schedule, ctx, configPath, args, mechanism }) {
  const name = cfg.backup.schedule.unit || 'blankey-backup';
  if (!ctx.binary) {
    return { ok: false, error: 'blankey is not on PATH on the Docker host, so a scheduled job could not find it' };
  }

  const useSystemd = mechanism === 'systemd'
    || (mechanism !== 'cron' && ctx.systemd && Boolean(schedule.onCalendar));

  // Replace, never accumulate.
  const removed = await removeSchedule(cfg, ctx);

  const files = unitFiles(name, { binary: ctx.binary, configPath, schedule, args });

  if (useSystemd) {
    let r = await writeAsRoot(UNIT(name), files.service, ctx);
    if (r.code !== 0) return { ok: false, error: failureText(r), removed };
    r = await writeAsRoot(TIMER(name), files.timer, ctx);
    if (r.code !== 0) return { ok: false, error: failureText(r), removed };
    r = await asRoot('systemctl daemon-reload', ctx);
    if (r.code !== 0) return { ok: false, error: failureText(r), removed };
    r = await asRoot(`systemctl enable --now ${q(name + '.timer')}`, ctx);
    if (r.code !== 0) return { ok: false, error: failureText(r), removed };
    return { ok: true, mechanism: 'systemd', unit: `${name}.timer`, removed, command: files.command };
  }

  const r = await writeAsRoot(CRON(name), files.cron, ctx);
  if (r.code !== 0) return { ok: false, error: failureText(r), removed };
  await asRoot(`chmod 644 ${q(CRON(name))}`, ctx);
  return { ok: true, mechanism: 'cron', unit: CRON(name), removed, command: files.command };
}

/** What, if anything, is currently scheduled. */
export async function scheduleStatus(cfg: any): Promise<{ name: string; systemd: any; cron: any; installed: number }> {
  const name = cfg.backup.schedule.unit || 'blankey-backup';
  const out: { name: string; systemd: any; cron: any; installed: number } = { name, systemd: null, cron: null, installed: 0 };

  const timerPath = TIMER(name);
  if (await host.exists(timerPath)) {
    const [show, list] = await Promise.all([
      host.exec(`systemctl show ${q(name + '.timer')} --property=ActiveState --property=UnitFileState --value`, { timeout: 20000 }),
      host.exec(`systemctl list-timers ${q(name + '.timer')} --no-pager`, { timeout: 20000 }),
    ]);
    // One value per line, in the order the properties were asked for, so this
    // is read positionally and must not have blanks filtered out of it.
    const [activeState, unitFileState] = show.stdout.split('\n').map((s) => s.trim());
    const next = /(\w{3} \d{4}-\d{2}-\d{2} [\d:]+ \w+)/.exec(list.stdout || '');
    const onCalendar = await host.exec(`grep -m1 OnCalendar= ${q(timerPath)}`, { timeout: 15000 });
    out.systemd = {
      path: timerPath,
      active: activeState === 'active',
      enabled: unitFileState === 'enabled',
      next: next ? next[1] : null,
      onCalendar: onCalendar.code === 0 ? onCalendar.stdout.split('=')[1] : null,
    };
    out.installed++;
  }

  const cronPath = CRON(name);
  if (await host.exists(cronPath)) {
    const text = await host.readFile(cronPath);
    // Skip the header comments and the SHELL=/PATH= assignments: what is left
    // is the schedule line itself.
    const line = lines(text).find((l) => !l.startsWith('#') && !l.includes('='));
    out.cron = { path: cronPath, line: line ?? null };
    out.installed++;
  }
  return out;
}
