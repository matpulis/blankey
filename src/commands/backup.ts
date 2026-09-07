import { log, cancelled } from '../ui/log.js';
import { c, P, fg, bold, badge } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { Spinner } from '../ui/spinner.js';
import { confirm, select, ask } from '../ui/prompt.js';
import { table } from '../ui/table.js';
import { rule, box } from '../ui/box.js';
import { stackLabel } from '../context.js';
import * as docker from '../docker.js';
import * as backup from '../backup.js';
import * as schedule from '../schedule.js';
import { withLock } from '../lock.js';
import { backupProblems, S3_PROVIDERS } from '../config.js';
import { bytes, relTime, groupBy, firstLine, lastLines } from '../util.js';

const SUBCOMMANDS = ['list', 'restore', 'prune', 'schedule', 'unschedule', 'status', 'check'];

export default {
  name: 'backup',
  aliases: ['bak'],
  group: 'Maintenance',
  describe: 'Archive Docker volumes to S3, on demand or on a schedule',
  usage: 'backup [project...] [--all] | backup <list|restore|prune|schedule|status|check>',
  valueFlags: ['stack', 'at', 'every', 'from', 'volume', 'retention'],
  options: [
    ['-a, --all', 'back up every project'],
    ['-s, --stack <name>', 'a specific stack'],
    ['    --stop', 'stop the stack while it is archived (safest for databases)'],
    ['-n, --dry-run', 'show what would be uploaded and what retention would drop'],
    ['-y, --yes', 'skip confirmations'],
    ['    --json', 'machine-readable output'],
  ],
  details:
    'Volumes are archived and uploaded by containers running on the Docker host,\n' +
    'so nothing has to be installed there and it works the same over SSH.\n' +
    '\n' +
    'Subcommands:\n' +
    '  list [project]           what is in the bucket\n' +
    '  restore <project>        put a backup back (destructive, asks first)\n' +
    '  prune                    apply retention now\n' +
    '  schedule [daily|hourly|weekly|"cron"] [--at HH:MM]\n' +
    '  unschedule               remove the scheduled job\n' +
    '  status                   what is scheduled and when it next runs\n' +
    '  check                    verify the bucket is reachable and writable\n' +
    '\n' +
    'A tar of a live volume is only crash-consistent. For a database, either pass\n' +
    '--stop, or dump it in a hooks.preBackup script and back the dump up instead.',
  examples: [
    ['blankey backup --all', 'back up every project now'],
    ['blankey backup shop-api --stop', 'quiesce the stack first'],
    ['blankey backup schedule daily --at 03:30', 'install (or replace) the nightly job'],
    ['blankey backup restore shop-api', 'pick a backup and put it back'],
  ],
  async run(ctx) {
    const sub = SUBCOMMANDS.includes(ctx.positional[0]) ? ctx.positional[0] : null;
    const rest = sub ? ctx.positional.slice(1) : ctx.positional;

    if (sub === 'schedule') return scheduleCmd(ctx, rest);
    if (sub === 'unschedule') return unscheduleCmd(ctx);
    if (sub === 'status') return statusCmd(ctx);

    const problems = backupProblems(ctx.cfg.backup);
    if (problems.length) {
      renderSetupHelp(ctx, problems);
      return 1;
    }

    if (sub === 'check') return checkCmd(ctx);
    if (sub === 'list') return listCmd(ctx, rest);
    if (sub === 'prune') return pruneCmd(ctx);
    if (sub === 'restore') return restoreCmd(ctx, rest);
    return runBackup(ctx, rest);
  },
};

// ------------------------------------------------------------------- run

async function runBackup(ctx, names) {
  const targets = await ctx.targets(names, { stackFlag: ctx.flags.stack, all: ctx.flags.all });
  const dry = Boolean(ctx.flags.dryRun);

  const sp = ctx.json ? null : new Spinner('finding volumes').start();
  const plan: any[] = [];
  for (const { project, stack } of targets) {
    const volumes = await backup.stackVolumes(stack);
    plan.push({ project, stack, volumes });
  }
  sp?.stop(null);

  const total = plan.reduce((n, p) => n + p.volumes.length, 0);
  if (!total) {
    log.blank();
    log.warn('None of those stacks declare a named volume, so there is nothing to archive.');
    log.hint('Bind mounts are not backed up: they are already files on the host.');
    log.blank();
    return 0;
  }

  if (ctx.json && dry) {
    log.raw(JSON.stringify(plan.map((p) => ({
      project: p.project.name, stack: p.stack.name, volumes: p.volumes,
    })), null, 2));
    return 0;
  }

  log.blank();
  log.raw(rule(dry ? 'backup (dry run)' : 'backup'));
  log.blank();
  const withVolumes = plan.filter((p) => p.volumes.length);
  for (const p of withVolumes) {
    log.raw(`  ${bold(stackLabel(p.project, p.stack))} ${c.faint(p.volumes.length + ' volume(s)')}`);
    for (const v of p.volumes) log.raw(`    ${c.faint(S.bullet)} ${c.muted(v)}`);
  }
  const empty = plan.length - withVolumes.length;
  if (empty) log.raw(`  ${c.faint(`${empty} stack(s) skipped: no named volumes`)}`);
  log.blank();
  log.raw(`  ${c.muted('destination')} ${fg(P.info, `s3://${ctx.cfg.backup.s3.bucket}/${ctx.cfg.backup.prefix}`)} ${c.faint(ctx.cfg.backup.s3.endpoint)}`);
  log.raw(`  ${c.muted('retention')}   ${c.faint(`${ctx.cfg.backup.retentionDays} days, keeping at least ${ctx.cfg.backup.keepMinimum} per volume`)}`);
  log.blank();

  if (dry) {
    await previewRetention(ctx);
    log.hint('Run without --dry-run to upload.');
    log.blank();
    return 0;
  }

  // One backup at a time, host-wide: a scheduled run must never overlap a
  // manual one and end up archiving a volume mid-write twice.
  return underBackupLock(ctx, () => performBackup(ctx, plan));
}

/**
 * Run something under the host-wide backup lock, reporting a held lock rather
 * than failing silently. "It exited 1 and printed nothing" is the worst
 * possible answer to "why did my restore not happen".
 */
async function underBackupLock(ctx, fn: () => Promise<number>): Promise<number> {
  const result = await withLock(ctx.cfg, 'backup', fn);
  if (!result.ran) {
    log.blank();
    log.fail(`Another backup is ${result.reason}.`);
    log.hint('Wait for it to finish, or remove .blankey/locks/backup if it died.');
    log.blank();
    return 1;
  }
  return result.result ?? 1;
}

async function performBackup(ctx, plan) {
  const results: any[] = [];
  let uploaded = 0;

  for (const { project, stack, volumes } of plan.filter((p) => p.volumes.length)) {
    const label = stackLabel(project, stack);
    const stopFirst = ctx.flags.stop || ctx.cfg.backup.stopStack;
    let restarted = false;

    if (stopFirst) {
      const sp = new Spinner(`${c.muted('stopping')} ${label}`).start();
      const r = await docker.compose(stack, 'stop', { timeout: 300000 });
      r.code === 0 ? sp.succeed(`${label} ${c.faint('stopped')}`) : sp.fail(`${label} could not be stopped`);
      restarted = r.code === 0;
    }

    for (const volume of volumes) {
      const at = backup.stamp();
      const fileName = `${volume}-${at}.tar.gz`;
      const key = backup.objectKey(ctx.cfg, { project: project.name, stack: stack.name, volume, at });
      const sp = new Spinner(`${c.muted('archiving')} ${bold(volume)}`).start();

      const archived = await backup.archiveVolume(ctx.cfg, volume, fileName);
      if (!archived.ok) {
        sp.fail(`${bold(volume)} ${c.err('archive failed')}`);
        log.raw(`    ${c.faint(lastLines(archived.error, 2))}`);
        results.push({ volume, project: project.name, ok: false, error: archived.error });
        continue;
      }

      sp.update(`${c.muted('uploading')} ${bold(volume)} ${c.faint(bytes(archived.size || 0))}`);
      const sent = await backup.uploadArchive(ctx.cfg, fileName, key);
      await backup.removeStaged(ctx.cfg, fileName);

      if (!sent.ok) {
        sp.fail(`${bold(volume)} ${c.err('upload failed')}`);
        log.raw(`    ${c.faint(lastLines(sent.error, 2))}`);
        results.push({ volume, project: project.name, ok: false, error: sent.error });
        continue;
      }
      uploaded += archived.size || 0;
      sp.succeed(`${bold(volume)} ${c.faint(bytes(archived.size || 0) + '  ' + key)}`);
      results.push({ volume, project: project.name, ok: true, size: archived.size, key });
    }

    if (stopFirst && restarted) {
      const sp = new Spinner(`${c.muted('starting')} ${label}`).start();
      const r = await docker.compose(stack, 'start', { timeout: 300000 });
      r.code === 0 ? sp.succeed(`${label} ${c.faint('back up')}`) : sp.fail(`${label} did not restart`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  log.blank();
  log.raw(`  ${badge(' UPLOADED ', failed.length ? P.warn : P.ok)} ${bold(bytes(uploaded))} ` +
    `${c.muted(`across ${results.filter((r) => r.ok).length} volume(s)`)}`);
  log.blank();

  const pruned = await applyRetention(ctx, { announce: true });
  if (pruned.removed) log.blank();

  if (failed.length) {
    log.fail(`${failed.length} volume(s) failed: ${failed.map((f) => f.volume).join(', ')}`);
    log.blank();
    return 1;
  }
  return 0;
}

// ------------------------------------------------------------- retention

async function applyRetention(ctx, { announce = false, dry = false }: any = {}) {
  const listing = await backup.listObjects(ctx.cfg, backup.volumePrefix(ctx.cfg));
  if (!listing.ok) {
    if (announce) log.warn(`Could not list the bucket for retention: ${firstLine(listing.error)}`);
    return { removed: 0, freed: 0 };
  }
  const plan = backup.planRetention(listing.objects, {
    retentionDays: Number(ctx.flags.retention) || ctx.cfg.backup.retentionDays,
    keepMinimum: ctx.cfg.backup.keepMinimum,
  });

  if (!plan.remove.length) {
    if (announce) log.raw(`  ${c.faint(S.ring)} ${c.muted(`nothing older than ${ctx.cfg.backup.retentionDays} days`)}`);
    return { removed: 0, freed: 0, plan };
  }
  if (dry) return { removed: 0, freed: plan.freed, plan };

  const sp = new Spinner(`${c.muted('applying retention')}`).start();
  let removed = 0;
  let freed = 0;
  for (const obj of plan.remove) {
    sp.update(`${c.muted('deleting')} ${c.faint(obj.key)}`);
    const r = await backup.deleteObject(ctx.cfg, obj.key);
    if (r.ok) {
      removed++;
      freed += obj.size || 0;
    }
  }
  sp.succeed(`${c.muted('retention')} ${bold(String(removed))} ${c.muted('old backup(s) removed')} ${c.faint(bytes(freed))}`);
  return { removed, freed, plan };
}

async function previewRetention(ctx) {
  const sp = new Spinner('checking what retention would drop').start();
  const result = await applyRetention(ctx, { dry: true });
  sp.stop(null);
  const plan = result.plan;
  if (!plan || !plan.remove.length) {
    log.raw(`  ${c.faint(S.ring)} ${c.muted('retention would remove nothing')}`);
    return;
  }
  log.raw(`  ${c.warn(S.warn)} ${c.muted('retention would remove')} ${bold(String(plan.remove.length))} ` +
    `${c.muted('backup(s), freeing')} ${bold(bytes(plan.freed))}`);
  for (const obj of plan.remove.slice(0, 5)) {
    log.raw(`    ${c.faint(S.bullet)} ${c.faint(obj.key)} ${c.faint(relTime(obj.at) + ' old')}`);
  }
  if (plan.remove.length > 5) log.raw(`    ${c.faint(`+${plan.remove.length - 5} more`)}`);
}

async function pruneCmd(ctx) {
  log.blank();
  log.raw(rule('retention'));
  log.blank();
  log.raw(`  ${c.muted('policy')} ${c.faint(`delete backups older than ${ctx.cfg.backup.retentionDays} days, always keep the newest ${ctx.cfg.backup.keepMinimum} per volume`)}`);
  log.blank();
  await previewRetention(ctx);
  log.blank();
  if (ctx.flags.dryRun) return 0;
  if (!ctx.yes && !(await confirm('  Delete them?', { def: false }))) {
    return cancelled();
  }
  const done = await applyRetention(ctx, { announce: true });
  log.blank();
  return done.removed >= 0 ? 0 : 1;
}

// ------------------------------------------------------------------ list

async function listCmd(ctx, names) {
  const project = names[0];
  const prefix = project
    ? backup.volumePrefix(ctx.cfg, { project }).replace(/\/$/, '')
    : backup.volumePrefix(ctx.cfg);

  const sp = ctx.json ? null : new Spinner('listing backups').start();
  const listing = await backup.listObjects(ctx.cfg, prefix);
  sp?.stop(null);

  if (!listing.ok) {
    log.blank();
    log.fail(`Could not list the bucket: ${lastLines(listing.error, 2)}`);
    log.blank();
    return 1;
  }
  if (ctx.json) {
    log.raw(JSON.stringify(listing.objects, null, 2));
    return 0;
  }
  if (!listing.objects.length) {
    log.blank();
    log.raw(`  ${c.faint('no backups yet under ')}${c.muted(prefix)}`);
    log.blank();
    return 0;
  }

  const groups = groupBy(listing.objects, (o) => o.key.slice(0, o.key.lastIndexOf('/')));
  log.blank();
  log.raw(rule(`${listing.objects.length} backup(s)`));
  log.blank();
  for (const [folder, objects] of groups) {
    const parts = folder.split('/');
    const volume = parts[parts.length - 1];
    const owner = parts.slice(1, -1).join(':');
    log.raw(`  ${bold(fg(P.brand2, volume))} ${c.faint(owner)} ${c.faint(bytes(objects.reduce((s, o) => s + o.size, 0)) + ' total')}`);
    log.raw(table(objects.slice(0, 10).map((o) => ({
      when: c.muted(o.at ? o.at.toISOString().replace('T', ' ').slice(0, 16) : '?'),
      age: c.faint(o.at ? relTime(o.at) : ''),
      size: c.muted(bytes(o.size)),
      key: c.faint(o.key.split('/').pop()),
    })), [
      { key: 'when', label: '', grow: false },
      { key: 'age', label: '', align: 'right', grow: false },
      { key: 'size', label: '', align: 'right', grow: false },
      { key: 'key', label: '', min: 10 },
    ], { head: false, indent: 4 }));
    if (objects.length > 10) log.raw(`    ${c.faint(`+${objects.length - 10} older`)}`);
    log.blank();
  }
  log.raw(`  ${c.faint('blankey backup restore <project>  to put one back')}`);
  log.blank();
  return 0;
}

// --------------------------------------------------------------- restore

async function restoreCmd(ctx, names) {
  const { project, stack } = await ctx.target(names[0], { stackFlag: ctx.flags.stack });
  const prefix = backup.volumePrefix(ctx.cfg, { project: project.name, stack: stack.name }).replace(/\/$/, '');

  const sp = new Spinner('listing backups').start();
  const listing = await backup.listObjects(ctx.cfg, prefix);
  sp.stop(null);
  if (!listing.ok || !listing.objects.length) {
    log.blank();
    log.fail(`No backups found under ${prefix}`);
    log.blank();
    return 1;
  }

  let chosen: any = null;
  if (ctx.flags.from) {
    chosen = listing.objects.find((o) => o.key === ctx.flags.from || o.key.includes(String(ctx.flags.from)));
    if (!chosen) {
      log.fail(`No backup matching ${ctx.flags.from}`);
      return 1;
    }
  } else {
    const groups = groupBy(listing.objects, (o) => o.key.split('/').slice(-2)[0]);
    const choices: any[] = [];
    for (const [volume, objects] of groups) {
      if (ctx.flags.volume && volume !== ctx.flags.volume) continue;
      choices.push({ separator: volume });
      for (const o of objects.slice(0, 8)) {
        choices.push({
          label: `${o.at ? o.at.toISOString().replace('T', ' ').slice(0, 16) : '?'}  ${bytes(o.size)}`,
          value: o,
          hint: o.at ? relTime(o.at) + ' old' : '',
        });
      }
    }
    chosen = await select('Restore which backup?', choices);
  }
  if (!chosen) {
    return cancelled();
  }

  const volume = chosen.key.split('/').slice(-2)[0];
  log.blank();
  log.raw(box([
    `${c.err(S.warn)} ${bold('This replaces everything in the volume ' + volume)}`,
    `${c.muted('from')} ${c.faint(chosen.key)}`,
    `${c.muted('taken')} ${c.faint(chosen.at ? chosen.at.toISOString() + '  (' + relTime(chosen.at) + ' old)' : 'unknown')}`,
    `${c.muted('The stack is stopped, the volume is emptied, the archive is extracted.')}`,
    `${c.muted('Current contents are not backed up first and cannot be recovered.')}`,
  ], { title: 'restore', color: P.err }));
  log.blank();

  if (!ctx.yes) {
    const typed = await ask(`  Type ${bold(volume)} to confirm`, { def: '' });
    if (typed !== volume) {
      return cancelled();
    }
  }

  return underBackupLock(ctx, async () => {
    const fileName = chosen.key.split('/').pop();
    let spin = new Spinner(`${c.muted('downloading')} ${c.faint(fileName)}`).start();
    const got = await backup.downloadArchive(ctx.cfg, chosen.key, fileName);
    if (!got.ok) {
      spin.fail(`download failed: ${lastLines(got.error)}`);
      return 1;
    }
    spin.succeed(`${c.muted('downloaded')} ${c.faint(fileName)}`);

    spin = new Spinner(`${c.muted('stopping')} ${stackLabel(project, stack)}`).start();
    await docker.compose(stack, 'stop', { timeout: 300000 });
    spin.succeed(`${stackLabel(project, stack)} ${c.faint('stopped')}`);

    spin = new Spinner(`${c.muted('restoring')} ${bold(volume)}`).start();
    const done = await backup.restoreVolume(ctx.cfg, volume, fileName);
    await backup.removeStaged(ctx.cfg, fileName);
    if (!done.ok) {
      spin.fail(`restore failed: ${lastLines(done.error)}`);
      log.warn('The stack is still stopped. Investigate before starting it.');
      return 1;
    }
    spin.succeed(`${bold(volume)} ${c.faint('restored')}`);

    spin = new Spinner(`${c.muted('starting')} ${stackLabel(project, stack)}`).start();
    const up = await docker.compose(stack, 'up -d', { timeout: 600000 });
    up.code === 0
      ? spin.succeed(`${stackLabel(project, stack)} ${c.ok('back up')}`)
      : spin.fail(`${stackLabel(project, stack)} did not start`);
    log.blank();
    return up.code === 0 ? 0 : 1;
  });
}

// --------------------------------------------------------------- schedule

async function scheduleCmd(ctx, rest) {
  const problems = backupProblems(ctx.cfg.backup);
  if (problems.length) {
    renderSetupHelp(ctx, problems);
    return 1;
  }
  const spec = rest[0] || ctx.flags.every || 'daily';
  const normalized = schedule.normalizeSchedule(spec, { at: ctx.flags.at || '03:00' });
  const hostInfo = await schedule.inspectHost();

  log.blank();
  log.raw(rule('scheduled backup'));
  log.blank();
  if (!hostInfo.binary) {
    log.fail('blankey is not on PATH on the Docker host.');
    log.hint('Install it there (npm link), or a scheduled job will not find it.');
    log.blank();
    return 1;
  }

  const mechanism = ctx.cfg.backup.schedule.mechanism === 'auto'
    ? (hostInfo.systemd && normalized.onCalendar ? 'systemd' : 'cron')
    : ctx.cfg.backup.schedule.mechanism;

  log.raw(`  ${c.muted('when')}       ${bold(normalized.label)}`);
  log.raw(`  ${c.muted('mechanism')}  ${c.muted(mechanism)} ${c.faint(mechanism === 'systemd' ? '(timer unit)' : '(/etc/cron.d file)')}`);
  log.raw(`  ${c.muted('retention')}  ${c.faint(`${ctx.cfg.backup.retentionDays} days, applied after each run`)}`);
  log.raw(`  ${c.muted('binary')}     ${c.faint(hostInfo.binary)}`);
  if (!hostInfo.root) log.raw(`  ${c.warn(S.warn)} ${c.muted('not root: sudo -n will be used to write the job')}`);
  log.blank();
  log.raw(`  ${c.faint('Re-running this replaces the existing job. It never adds a second one.')}`);
  log.blank();

  if (!ctx.yes && !(await confirm('  Install it?', { def: true }))) {
    return cancelled();
  }

  const configPath = await remoteConfigPath(ctx);
  const sp = new Spinner('installing').start();
  const result = await schedule.installSchedule(ctx.cfg, {
    schedule: normalized,
    ctx: hostInfo,
    configPath,
    mechanism,
    args: '',
  });
  if (!result.ok) {
    sp.fail(`could not install: ${firstLine(result.error)}`);
    log.blank();
    return 1;
  }
  sp.succeed(`${bold(result.unit)} ${c.faint('installed')}`);
  if (result.removed?.length) {
    log.raw(`  ${c.faint('replaced: ' + result.removed.join(', '))}`);
  }
  log.raw(`  ${c.faint('runs: ' + result.command)}`);
  log.blank();
  return statusCmd(ctx);
}

async function unscheduleCmd(ctx) {
  const hostInfo = await schedule.inspectHost();
  const sp = new Spinner('removing scheduled backup').start();
  const removed = await schedule.removeSchedule(ctx.cfg, hostInfo);
  removed.length
    ? sp.succeed(`removed ${removed.join(', ')}`)
    : sp.skip('nothing was scheduled');
  log.blank();
  return 0;
}

async function statusCmd(ctx) {
  const state = await schedule.scheduleStatus(ctx.cfg);
  if (ctx.json) {
    log.raw(JSON.stringify(state, null, 2));
    return 0;
  }
  log.blank();
  log.raw(rule('backup schedule'));
  log.blank();
  if (!state.installed) {
    log.raw(`  ${c.faint(S.ring)} ${c.muted('no scheduled backup')}`);
    log.blank();
    log.hint('blankey backup schedule daily --at 03:30');
    log.blank();
    return 0;
  }

  if (state.systemd) {
    const st = state.systemd;
    log.raw(`  ${st.active ? badge(' ARMED ', P.ok) : badge(' INACTIVE ', P.warn)} ${bold(state.name + '.timer')}`);
    log.raw(`    ${c.muted('schedule')} ${c.faint(st.onCalendar || '?')}`);
    if (st.next) log.raw(`    ${c.muted('next run')} ${fg(P.info, st.next)}`);
    log.raw(`    ${c.muted('enabled')}  ${st.enabled ? c.ok('yes') : c.warn('no')}`);
    log.raw(`    ${c.faint(st.path)}`);
  }
  if (state.cron) {
    log.raw(`  ${badge(' ARMED ', P.ok)} ${bold(state.cron.path)}`);
    if (state.cron.line) log.raw(`    ${c.faint(state.cron.line)}`);
  }
  log.blank();

  // The whole point of the single-file design: this should never be 2.
  if (state.installed > 1) {
    log.raw(`  ${c.err(S.warn)} ${c.err('Both a systemd timer and a cron entry exist, so backups would run twice.')}`);
    log.hint('blankey backup unschedule, then schedule again');
    log.blank();
    return 1;
  }
  log.raw(`  ${c.faint('blankey backup status  |  blankey backup unschedule  |  blankey backup list')}`);
  log.blank();
  return 0;
}

/** The unit needs a config the Docker host can read. */
async function remoteConfigPath(ctx) {
  const local = ctx.cfg.__file;
  if (!local) return null;
  const hostModule = await import('../host.js');
  return (await hostModule.exists(local)) ? local : null;
}

// ------------------------------------------------------------------ check

async function checkCmd(ctx) {
  log.blank();
  log.raw(rule('backup destination'));
  log.blank();
  const s3 = ctx.cfg.backup.s3;
  log.raw(`  ${c.muted('bucket')}    ${bold(s3.bucket)}`);
  log.raw(`  ${c.muted('endpoint')}  ${c.faint(s3.endpoint)}`);
  log.raw(`  ${c.muted('region')}    ${c.faint(s3.region || '(none)')}`);
  log.raw(`  ${c.muted('prefix')}    ${c.faint(ctx.cfg.backup.prefix)}`);
  log.raw(`  ${c.muted('staging')}   ${c.faint(ctx.cfg.backup.dir)}`);
  log.blank();

  const sp = new Spinner('checking access').start();
  const access = await backup.checkAccess(ctx.cfg);
  if (!access.ok) {
    sp.fail('the bucket is not reachable with those credentials');
    log.raw(`    ${c.faint(access.error)}`);
    log.blank();
    return 1;
  }
  sp.succeed('bucket reachable and readable');
  log.blank();
  return 0;
}

function renderSetupHelp(ctx, problems) {
  log.blank();
  log.raw(box([
    ...problems.map((p) => `${c.err(S.cross)} ${c.muted('missing')} ${bold(p)}`),
    '',
    c.muted('Add to ' + (ctx.cfg.__file || 'your config') + ':'),
    c.faint('  backup:'),
    c.faint('    s3:'),
    c.faint('      provider: hetzner        # or digitalocean'),
    c.faint('      region: fsn1             # ' + S3_PROVIDERS.hetzner.regions),
    c.faint('      bucket: my-backups'),
    '',
    c.muted('Keys are better kept out of the file. Either set them there, or export:'),
    c.faint('  BLANKEY_S3_ACCESS_KEY_ID, BLANKEY_S3_SECRET_ACCESS_KEY'),
  ], { title: 'backup is not configured yet', color: P.warn }));
  log.blank();
}
