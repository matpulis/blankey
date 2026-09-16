import { log, cancelled } from '../ui/log.js';
import { c, P, fg, bold } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { confirm } from '../ui/prompt.js';
import { box, rule } from '../ui/box.js';
import { Spinner } from '../ui/spinner.js';
import { relTime } from '../util.js';
import {
  updateSettings, fetchLatest, refresh, readCache, isNewer,
  upgradePlan, runUpgrade,
} from '../update.js';

export default {
  name: 'update',
  aliases: ['upgrade', 'self-update'],
  group: 'Setup',
  describe: 'Check whether a newer blankey is out, and install it',
  usage: 'update [--check] [--yes]',
  needsConfig: false,
  options: [
    ['    --check', 'only report, and exit 1 when an update is available'],
    ['    --force', 'reinstall even when already on the newest version'],
    ['-y, --yes', 'install without asking'],
    ['    --json', 'machine-readable result'],
  ],
  details:
    'This upgrades blankey itself, not your projects. It re-runs the installer\n' +
    'pinned to the new release, which is the same thing you would type by hand.\n' +
    '\n' +
    'blankey also mentions a new version on its own after a command, at most once\n' +
    'a day. That check runs in the background and never delays anything. Turn it\n' +
    'off with selfUpdate.check: false, or BLANKEY_NO_UPDATE_CHECK=1.',
  examples: [
    ['blankey update', 'check, then offer to install'],
    ['blankey update --check', 'just tell me, for a script or a cron'],
    ['blankey update -y', 'install it without asking'],
  ],
  async run(ctx) {
    const { VERSION } = await import('../cli.js');
    const settings = updateSettings(ctx.cfg);

    // The background refresh spawned by another run lands here. Say nothing,
    // touch nothing else, exit.
    if (ctx.flags.refresh) {
      await refresh(ctx.cfg);
      return 0;
    }

    if (!settings.repo) {
      if (ctx.json) {
        log.raw(JSON.stringify({ current: VERSION, configured: false }, null, 2));
        return 0;
      }
      log.blank();
      log.warn('No update source is configured, so there is nothing to check against.');
      log.blank();
      log.raw(box([
        c.muted('Point it at the repository releases are published to:'),
        '',
        c.faint('selfUpdate:'),
        c.faint('  repo: matpulis/blankey'),
        '',
        c.muted('Then `blankey update` follows its GitHub releases.'),
      ], { title: 'not configured', color: P.warn }));
      log.blank();
      return 0;
    }

    const sp = ctx.json ? null : new Spinner(`checking ${c.faint(settings.repo)}`).start();
    const result = await fetchLatest(settings.repo);
    sp?.stop(null);

    if (!result.ok) {
      const cache = await readCache();
      if (ctx.json) {
        log.raw(JSON.stringify({
          current: VERSION, latest: null, updateAvailable: false, reason: result.reason,
        }, null, 2));
        return 1;
      }

      log.blank();
      // Having published nothing yet is not an error, and is what everyone
      // sees on the day they point this at a repository.
      if (result.reason === 'no-releases') {
        log.warn(`${bold(settings.repo)} has no published releases, so there is nothing to compare against.`);
        log.blank();
        log.raw(box([
          c.muted('A git tag on its own is not enough: this reads GitHub\'s release feed.'),
          '',
          c.faint('  git tag -a v0.1.0 -m "v0.1.0" && git push origin v0.1.0'),
          c.faint(`  gh release create v0.1.0 --generate-notes`),
          '',
          c.muted('A private repository, or one whose only releases are prereleases, looks'),
          c.muted('the same from here.'),
        ], { title: 'nothing released yet', color: P.warn }));
        log.blank();
        return 1;
      }

      log.fail(`Could not reach ${bold(settings.repo)}.`);
      log.hint(result.status ? `GitHub answered ${result.status}.` : 'Check the network.');
      if (cache?.latest) log.hint(`Last seen ${cache.latest}, ${relTime(cache.checkedAt)} ago`);
      log.blank();
      return 1;
    }

    const release = result.release;

    const available = isNewer(release.version, VERSION);

    if (ctx.json) {
      log.raw(JSON.stringify({
        current: VERSION,
        latest: release.version,
        updateAvailable: available,
        url: release.url,
        publishedAt: release.publishedAt,
      }, null, 2));
      return available ? 1 : 0;
    }

    log.blank();
    log.raw(rule('blankey update'));
    log.blank();
    log.raw(`  ${c.muted('installed')}  ${bold('v' + VERSION.replace(/^v/, ''))}`);
    log.raw(`  ${c.muted('latest')}     ${available ? fg(P.ok, release.version) : c.muted(release.version)}` +
      (release.publishedAt ? c.faint(`  released ${relTime(release.publishedAt)} ago`) : ''));
    if (release.url) log.raw(`  ${c.muted('notes')}      ${fg(P.info, release.url)}`);
    log.blank();

    if (!available && !ctx.flags.force) {
      log.raw(`  ${c.ok(S.tick)} ${c.muted('Already on the newest release.')}`);
      log.blank();
      return 0;
    }

    // --check is the scriptable form: report, do nothing, signal with the code.
    if (ctx.flags.check) {
      log.raw(`  ${fg(P.info, S.up)} ${bold('An update is available.')} ${c.faint('blankey update  to install it')}`);
      log.blank();
      return 1;
    }

    const plan = upgradePlan(ctx.cfg, release.version);
    if (!plan.ok) {
      log.fail(`Cannot install it automatically: ${plan.reason}.`);
      log.hint(`Install it by hand from ${release.url}`);
      log.blank();
      return 1;
    }

    log.raw(box([
      c.muted('This runs the installer, pinned to that release:'),
      '',
      c.bold(plan.command!),
      '',
      c.muted('It needs root to write to /usr/local, so it may ask for a sudo password.'),
      c.muted('Your projects and configuration are not touched.'),
    ], { title: 'what will happen', color: P.warn }));
    log.blank();

    if (!ctx.yes && !(await confirm('  Install it?', { def: true }))) return cancelled();

    log.blank();
    const code = await runUpgrade(plan.command!);
    log.blank();

    if (code !== 0) {
      log.fail(`The installer exited with ${code}. blankey has not been changed.`);
      log.hint(`Run it by hand to see what happened: ${plan.command}`);
      log.blank();
      return code;
    }

    // The new binary reports its own version; this process is still the old one.
    await refresh(ctx.cfg);
    log.ok(`Updated to ${bold(release.version)}.`);
    log.hint('blankey --version  to confirm');
    log.blank();
    return 0;
  },
};
