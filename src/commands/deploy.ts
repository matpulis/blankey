import { log, cancelled, commitList } from '../ui/log.js';
import { c, P, fg, bold, badge, strip } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { Spinner, progress } from '../ui/spinner.js';
import { confirm } from '../ui/prompt.js';
import { table } from '../ui/table.js';
import { rule } from '../ui/box.js';
import { stackLabel } from '../context.js';
import { shaChange, subjectCell } from '../ui/render.js';
import * as docker from '../docker.js';
import * as git from '../git.js';
import * as host from '../host.js';
import { recordDeploy, lastGoodSha, historyFor, fillSubjects } from '../state.js';
import { onCleanup } from '../cleanup.js';
import type { DeployResult } from '../types.js';
import { duration, sleep, relTime, firstLine } from '../util.js';

const options = [
  ['-s, --stack <name>', 'deploy a specific stack'],
  ['-a, --all', 'deploy every discovered project'],
  ['    --at <ref>', 'one-shot: deploy this commit, then put the repo back'],
  ['    --changed', 'skip stacks with no new commits'],
  ['    --no-git', 'do not touch git, just rebuild and restart'],
  ['    --no-pull', 'skip pulling images from the registry'],
  ['    --build', 'force an image rebuild'],
  ['    --no-build', 'never build, even when the compose file declares one'],
  ['    --no-rollback', 'leave a failed deploy in place instead of reverting'],
  ['    --prune', 'remove dangling images afterwards'],
  ['    --timeout <s>', 'seconds to wait for containers to become healthy'],
  ['-n, --dry-run', 'show what would happen without changing anything'],
];

export const deploy = {
  name: 'deploy',
  aliases: ['d'],
  group: 'Deployments',
  describe: 'Pull, rebuild, restart and verify a stack end to end',
  usage: 'deploy [project[:stack]...] [--all] [--changed] [--at <ref>]',
  valueFlags: ['stack', 'timeout', 'branch', 'at'],
  options,
  details:
    'The pipeline is: hooks.preDeploy, git pull, image pull, build, up -d, health\n' +
    'check, hooks.postDeploy. If the health check fails after git moved the repo\n' +
    'forward, blankey reverts to the previous commit and brings the old version\n' +
    'back up, then reports what happened.\n' +
    '\n' +
    '--at <ref> is a one-shot deploy: the repo is checked out at that commit, tag\n' +
    'or branch, built and started from it, then returned to exactly where it was\n' +
    '(branch included). The containers keep running that build while the working\n' +
    'tree looks untouched. It refuses to run on a dirty tree, always rebuilds, and\n' +
    'restores the repo even if the deploy fails or you press Ctrl+C.',
  examples: [
    ['blankey deploy shop-api', 'deploy one repo'],
    ['blankey deploy --all --changed', 'redeploy only what actually moved'],
    ['blankey deploy shop-api:staging --build', 'force a rebuild of the staging stack'],
    ['blankey deploy shop-api --at v1.4.2', 'run a tag once, leave the repo alone'],
    ['blankey deploy shop-api --at 1fc22c6', 'put a known-good build back without rewinding the repo'],
  ],
  async run(ctx) {
    const targets = await ctx.targets(ctx.positional, { stackFlag: ctx.flags.stack, all: ctx.flags.all });
    if (!targets.length) return 0;

    const dry = Boolean(ctx.flags.dryRun);
    if (targets.length > 3 && !ctx.yes && !dry) {
      log.blank();
      for (const t of targets) log.item(stackLabel(t.project, t.stack));
      log.blank();
      if (!(await confirm(`Deploy ${bold(String(targets.length))} stacks?`, { def: true }))) {
        return cancelled();
      }
    }

    log.blank();
    log.raw(rule(dry ? 'deploy (dry run)' : 'deploy'));

    const results: any[] = [];
    let index = 0;
    for (const target of targets) {
      index++;
      if (targets.length > 1) {
        log.raw('\n' + c.faint(progress(index - 1, targets.length, stackLabel(target.project, target.stack))));
      }
      results.push(await deployOne(ctx, target, { dry }));
    }

    log.blank();
    renderSummary(results, dry);
    return results.some((r) => r.status === 'failed') ? 1 : 0;
  },
};

async function deployOne(ctx: any, { project, stack }: any, { dry }: { dry: boolean }): Promise<DeployResult> {
  const label = stackLabel(project, stack);
  const started = Date.now();
  const result: DeployResult = { project: project.name, stack: stack.name, label, status: 'ok', steps: [], commits: [] };
  const oneShotRef = ctx.flags.at ? String(ctx.flags.at) : null;
  // A one-shot deploy pins the tree itself, so the normal fetch/pull is skipped.
  const useGit = ctx.flags.git !== false && project.isGit && !oneShotRef;
  const timeout = Number(ctx.flags.timeout || ctx.cfg.defaults.healthTimeout || 90) * 1000;

  log.blank();
  log.raw(`  ${bold(fg(P.brand2, label))} ${c.faint(stack.dir)}`);

  const sp = new Spinner('').start(`${c.muted('preparing')} ${label}`);
  const step = (name, fn) => runStep(sp, result, name, fn, dry);

  // Set once the tree has been moved for a one-shot deploy; putting it back is
  // idempotent so the catch block and the finally block can both ask for it.
  let ephemeral: any = null;
  let unregisterCleanup: any = null;
  const restoreTree = async () => {
    if (!ephemeral || ephemeral.restored) return null;
    ephemeral.restored = true;
    unregisterCleanup?.();
    return git.restorePosition(stack.dir, ephemeral.origin);
  };

  try {
    if (project.hooks.preDeploy) {
      await step('preDeploy hook', () => runHook(stack.dir, project.hooks.preDeploy));
    }

    // Record the commit even when git is skipped, so a --no-git deploy still
    // shows (and can later be rolled back to) the point it ran from.
    let fromSha = project.isGit ? await git.currentSha(stack.dir) : null;
    let toSha = fromSha;

    if (oneShotRef) {
      if (!project.isGit) {
        sp.fail(`${bold(label)} ${c.err('--at needs a git repository')}`);
        result.status = 'failed';
        result.error = `${project.name} is not a git repository`;
        return result;
      }

      if (ctx.flags.git !== false) {
        await step('git fetch', async () => {
          const r = await git.fetch(stack.dir);
          if (!r.ok) throw new Error(r.error ?? 'fetch failed');
          return 'remote refs updated';
        });
      }

      // Moving the tree back and forth over uncommitted work is not something
      // to do on the user's behalf, so this one refuses rather than forcing.
      const st = await git.status(stack.dir);
      if (st.dirty) {
        sp.stop(null);
        log.fail(`  ${label} has ${st.dirty} uncommitted change(s), so it cannot be moved temporarily.`);
        log.hint('Commit or stash them first, then retry.');
        result.status = 'skipped';
        result.reason = 'dirty working tree';
        return result;
      }

      const sha = await git.resolveRef(stack.dir, oneShotRef);
      if (!sha) {
        sp.fail(`${bold(label)} ${c.err(`${oneShotRef} is not a commit, tag or branch`)}`);
        result.status = 'failed';
        result.error = `unknown ref: ${oneShotRef}`;
        return result;
      }

      const origin = await git.currentPosition(stack.dir);
      result.ephemeral = true;
      result.ref = oneShotRef;
      result.deployedSha = sha.slice(0, 7);
      result.subject = await git.subjectOf(stack.dir, sha);
      result.restoreTo = origin.branch || (origin.sha || '').slice(0, 7);
      // The tree starts and ends in the same place: only the containers move.
      result.fromSha = origin.sha ? origin.sha.slice(0, 7) : null;
      result.toSha = result.fromSha;
      // A one-shot usually goes backwards (put a known-good build back), so
      // measure the distance in whichever direction it actually is.
      const ahead = await git.logBetween(stack.dir, origin.sha, sha, 10);
      const behind = ahead.length ? [] : await git.logBetween(stack.dir, sha, origin.sha, 10);
      result.commits = ahead.length ? ahead : behind;
      result.direction = ahead.length ? 'ahead of tree' : behind.length ? 'behind tree' : null;

      await step(`checkout ${oneShotRef}`, async () => {
        const co = await git.checkoutRef(stack.dir, oneShotRef);
        if (!co.ok) throw new Error(co.error ?? 'checkout failed');
        ephemeral = { ref: oneShotRef, sha, origin, restored: false };
        unregisterCleanup = onCleanup(() => git.restorePosition(stack.dir, origin));
        return `${result.restoreTo} ${S.arrow} ${result.deployedSha} ${c.faint('(temporary)')}`;
      });
    }

    // A repo with no upstream, or one that has opted out, still deploys: it
    // just builds from whatever is in the working tree instead of pulling.
    const pullable = useGit && project.autoUpdate && await git.tracksRemote(stack.dir);
    if (useGit && !pullable) {
      result.steps.push({
        name: 'git',
        detail: project.autoUpdate ? 'local repo, nothing to pull' : 'updates disabled for this repo',
      });
      result.localOnly = true;
    }

    if (pullable) {
      await step('git fetch', async () => {
        const r = await git.fetch(stack.dir);
        if (!r.ok) throw new Error(r.error ?? 'fetch failed');
        return 'remote refs updated';
      });

      const st = await git.status(stack.dir);
      if (ctx.flags.changed && st.behind === 0 && !ctx.flags.build && !ctx.flags.force) {
        sp.skip(`${label} ${c.faint('already up to date')}`);
        result.status = 'skipped';
        result.reason = 'no new commits';
        return result;
      }
      if (st.dirty && !ctx.yes && !dry) {
        sp.stop(null);
        log.warn(`  ${st.dirty} uncommitted change(s) in ${label}`);
        const go = await confirm('  Continue anyway?', { def: false });
        if (!go) {
          result.status = 'skipped';
          result.reason = 'dirty working tree';
          return result;
        }
        sp.start(`${c.muted('deploying')} ${label}`);
      }

      await step('git pull', async () => {
        const r = await git.pull(stack.dir, {
          strategy: ctx.cfg.defaults.gitStrategy,
          branch: ctx.flags.branch,
        });
        if (!r.ok) throw new Error(r.error ?? 'pull failed');
        toSha = await git.currentSha(stack.dir);
        return r.changed ? `${r.from} ${S.arrow} ${r.to}` : 'already current';
      });

      if (fromSha && toSha && fromSha !== toSha) {
        result.commits = await git.logBetween(stack.dir, fromSha, toSha, 10);
        result.changedFiles = await git.changedFiles(stack.dir, fromSha, toSha);
      }
    }

    result.fromSha = fromSha ? fromSha.slice(0, 7) : null;
    result.toSha = toSha ? toSha.slice(0, 7) : null;
    if (!result.subject && toSha) result.subject = await git.subjectOf(stack.dir, toSha);

    const hasBuild = stack.services.some((s) => s.build);
    const shouldBuild = ctx.flags.build === true
      // A one-shot deploy is pointless without rebuilding: the whole point is to
      // run the image that this particular commit produces.
      || (ctx.flags.build !== false && hasBuild && (ephemeral || !useGit || fromSha !== toSha));

    if (ctx.flags.pull !== false) {
      await step('pull images', async () => {
        const r = await docker.composeStream(stack, 'pull --ignore-buildable --quiet', {
          onLine: (line) => sp.update(`${c.muted('pulling')} ${label} ${c.faint(line.slice(0, 50))}`),
        });
        // A pull failure is not fatal on its own: the image may be local-only.
        return r.code === 0 ? 'images current' : c.warn('pull skipped');
      });
    }

    if (shouldBuild) {
      await step('build', async () => {
        const r = await docker.composeStream(stack, 'build --pull', {
          onLine: (line) => sp.update(`${c.muted('building')} ${label} ${c.faint(line.slice(0, 50))}`),
        });
        if (r.code !== 0) throw new Error(r.tail.slice(-4).join('\n'));
        return 'images built';
      });
    }

    await step('up', async () => {
      const args = ['up', '-d', ctx.cfg.defaults.removeOrphans ? '--remove-orphans' : '']
        .filter(Boolean).join(' ');
      const r = await docker.composeStream(stack, args, {
        onLine: (line) => sp.update(`${c.muted('starting')} ${label} ${c.faint(line.slice(0, 50))}`),
      });
      if (r.code !== 0) throw new Error(r.tail.slice(-6).join('\n'));
      return 'containers started';
    });

    await step('health', async () => {
      const health = await waitHealthy(stack, { timeout, onTick: (msg) => sp.update(`${c.muted('waiting')} ${label} ${c.faint(msg)}`) });
      if (!health.ok) throw Object.assign(new Error(health.reason), { health: true });
      if (stack.healthcheck) {
        const probe = await httpProbe(stack.healthcheck, timeout);
        if (!probe.ok) throw Object.assign(new Error(`healthcheck ${stack.healthcheck} ${probe.detail}`), { health: true });
        return `containers healthy, ${stack.healthcheck} ${probe.detail}`;
      }
      return health.detail;
    });

    if (project.hooks.postDeploy) {
      await step('postDeploy hook', () => runHook(stack.dir, project.hooks.postDeploy));
    }

    if (ctx.flags.prune || ctx.cfg.defaults.prune) {
      await step('prune', async () => {
        const r = await host.exec('docker image prune -f', { timeout: 120000 });
        return r.code === 0 ? (r.stdout.split('\n').pop() || 'pruned') : 'prune skipped';
      });
    }

    result.took = Date.now() - started;
    sp.succeed(`${bold(label)} ${c.ok('deployed')}`);
  } catch (e) {
    result.status = 'failed';
    result.error = e.message;
    result.took = Date.now() - started;
    sp.fail(`${bold(label)} ${c.err(result.failedStep || 'failed')}`);
    for (const line of String(e.message).split('\n').slice(-6)) {
      if (line.trim()) log.raw('    ' + c.faint(line.trim()));
    }

    const wantRollback = ctx.flags.rollback !== false && (ctx.cfg.defaults.rollbackOnFailure ?? true);

    if (ephemeral && !dry) {
      // Recovery for a one-shot is to put the tree back and rebuild whatever was
      // running before, so a failed experiment does not leave the site down.
      const rb = new Spinner(`${c.warn('restoring')} ${label} ${c.faint(result.deployedSha + ' ' + S.arrow + ' ' + result.restoreTo)}`).start();
      const back = await restoreTree();
      if (!back?.ok) {
        rb.fail(`${label} could not restore the tree: ${back?.error || 'unknown error'}`);
      } else if (!wantRollback) {
        rb.warn(`${label} ${c.warn('tree restored, containers left as they are')}`);
        result.status = 'restored';
      } else {
        const r = await docker.compose(stack, 'up -d --build --remove-orphans', { timeout: 900000 });
        if (r.code === 0) {
          rb.warn(`${label} ${c.warn('restored to ' + result.restoreTo)}`);
          result.status = 'rolled-back';
        } else rb.fail(`${label} tree restored but compose failed to bring it back`);
      }
    } else if (!ephemeral && wantRollback && !dry
        && e.health && result.fromSha && result.toSha && result.fromSha !== result.toSha) {
      const rb = new Spinner(`${c.warn('rolling back')} ${label} ${c.faint(result.toSha + ' ' + S.arrow + ' ' + result.fromSha)}`).start();
      const back = await git.checkoutCommit(stack.dir, result.fromSha);
      if (back.ok) {
        const r = await docker.compose(stack, 'up -d --remove-orphans', { timeout: 600000 });
        if (r.code === 0) {
          rb.warn(`${label} ${c.warn('rolled back to ' + result.fromSha)}`);
          result.status = 'rolled-back';
        } else rb.fail(`${label} rollback started but compose failed`);
      } else rb.fail(`${label} rollback failed: ${back.error}`);
    }
  } finally {
    // Whatever happened above, the repo goes back where it was found.
    const back = await restoreTree();
    if (back && !back.ok) {
      log.fail(`  ${label}: could not restore ${result.restoreTo} (${back.error})`);
      log.hint(`Fix it by hand: git -C ${stack.dir} checkout ${result.restoreTo}`);
      result.restoreFailed = true;
    } else if (back && result.status === 'ok') {
      log.raw(`  ${c.faint(S.arrow)} ${c.muted('working tree back on ')}${bold(result.restoreTo)}` +
        `${c.faint(', containers running ' + result.deployedSha)}`);
    }
  }

  if (!dry) {
    await recordDeploy(ctx.cfg, {
      project: project.name,
      stack: stack.name,
      ok: result.status === 'ok',
      status: result.status,
      fromSha: result.fromSha,
      toSha: result.toSha,
      ephemeral: Boolean(result.ephemeral),
      ref: result.ref || null,
      deployedSha: result.deployedSha || result.toSha || null,
      subject: result.subject || null,
      commits: result.commits.length,
      took: result.took,
      error: result.error || null,
    });
  }
  return result;
}

async function runStep(sp: any, result: DeployResult, name: string, fn: () => any, dry: boolean) {
  sp.update(`${c.muted(name)} ${c.faint('...')}`);
  if (dry) {
    result.steps.push({ name, detail: c.faint('skipped (dry run)') });
    return;
  }
  try {
    const detail = await fn();
    result.steps.push({ name, detail: detail || 'done' });
  } catch (e) {
    result.failedStep = name;
    throw e;
  }
}

async function runHook(dir, cmd) {
  const r = await host.exec(cmd, { cwd: dir, timeout: 600000 });
  if (r.code !== 0) throw new Error(`hook failed: ${r.stderr || r.stdout}`);
  return 'hook ok';
}

/** Poll compose until every container is running and no healthcheck is failing. */
export async function waitHealthy(stack, { timeout = 90000, onTick }: any = {}) {
  const deadline = Date.now() + timeout;
  const emptyGrace = Date.now() + Math.min(15000, timeout);
  let last = 'starting';
  while (Date.now() < deadline) {
    const containers = await docker.stackPs(stack);

    // `up` succeeded but Compose reports nothing: waiting out the full timeout
    // would only delay the same failure, so give up early and say why.
    if (!containers.length && Date.now() > emptyGrace) {
      return { ok: false, reason: 'compose reports no containers for this stack after starting it' };
    }
    const summary = docker.summarize(containers, stack.services.map((s) => s.name));
    const waiting = containers.filter((ct) => ct.health === 'starting');
    const bad = containers.filter((ct) => ct.health === 'unhealthy');
    const dead = containers.filter((ct) => ct.state === 'exited' && ct.exitCode !== 0);
    const looping = containers.filter((ct) => ct.state === 'restarting');

    if (dead.length) {
      return { ok: false, reason: `${dead.map((x) => x.service || x.name).join(', ')} exited with a non-zero status` };
    }
    // A container still restarting after the grace period is crash-looping;
    // waiting for the full timeout just delays the same answer.
    if (looping.length && Date.now() > emptyGrace) {
      return { ok: false, reason: `${looping.map((x) => x.service || x.name).join(', ')} is stuck restarting` };
    }
    if (bad.length) {
      return { ok: false, reason: `${bad.map((x) => x.service || x.name).join(', ')} reported unhealthy` };
    }
    if (!waiting.length && summary.running >= Math.min(summary.total, containers.length) && containers.length) {
      return { ok: true, detail: `${summary.running}/${summary.total} containers healthy` };
    }
    last = waiting.length ? `${waiting.length} container(s) still starting` : 'containers coming up';
    onTick?.(last + ` ${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s`);
    await sleep(1500);
  }
  return { ok: false, reason: `timed out after ${Math.round(timeout / 1000)}s (${last})` };
}

/** HTTP probe runs on the Docker host, so it works for internal-only URLs too. */
export async function httpProbe(url, timeout = 30000) {
  const deadline = Date.now() + Math.min(timeout, 60000);
  let detail = 'unreachable';
  while (Date.now() < deadline) {
    const r = await host.exec(
      `curl -fsS -o /dev/null -m 10 -w "%{http_code}" ${host.q(url)}`,
      { timeout: 20000 },
    );
    if (r.code === 0) return { ok: true, detail: `HTTP ${r.stdout.trim()}` };
    detail = r.stdout.trim() ? `HTTP ${r.stdout.trim()}` : (firstLine(r.stderr) || 'unreachable');
    await sleep(2000);
  }
  return { ok: false, detail };
}

function renderSummary(results: DeployResult[], dry: boolean) {
  const rows = results.map((r) => ({
    icon: r.status === 'ok' ? c.ok(S.tick)
      : r.status === 'skipped' ? c.faint(S.ring)
        : ['rolled-back', 'restored'].includes(r.status) ? c.warn(S.warn) : c.err(S.cross),
    name: bold(r.label) + (r.ephemeral ? c.faint(' one-shot') : ''),
    result: r.status === 'ok' ? c.ok('deployed')
      : r.status === 'skipped' ? c.faint(r.reason || 'skipped')
        : r.status === 'rolled-back' ? c.warn('rolled back')
          : r.status === 'restored' ? c.warn('tree restored') : c.err('failed'),
    change: shaChange(r),
    commits: r.commits?.length
      ? c.muted(`${r.commits.length} ${r.direction || `commit${r.commits.length === 1 ? '' : 's'}`}`)
      : c.faint('—'),
    took: r.took ? c.faint(duration(r.took)) : '',
  }));

  log.raw(rule(dry ? 'dry run summary' : 'summary'));
  log.blank();
  log.raw(table(rows, [
    { key: 'icon', label: '', grow: false },
    { key: 'name', label: 'stack', min: 12 },
    { key: 'result', label: 'result', grow: false },
    { key: 'change', label: 'commit', grow: false },
    { key: 'commits', label: 'changes', grow: false },
    { key: 'took', label: 'took', align: 'right', grow: false },
  ]));
  log.blank();

  for (const r of results.filter((x) => x.commits?.length)) {
    log.raw(`  ${bold(r.label)}`);
    commitList(r.commits);
    log.blank();
  }

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) {
    log.raw(`  ${badge(' FAILED ', P.err)} ${failed.map((f) => f.label).join(', ')}`);
    log.hint(`blankey logs ${failed[0].project} ${S.bullet} blankey rollback ${failed[0].project}`);
    log.blank();
  }
}

export const pull = {
  name: 'pull',
  aliases: ['update'],
  group: 'Deployments',
  describe: 'Update repos from git without restarting anything',
  usage: 'pull [project...] [--all] [--dry-run] [--branch <name>]',
  valueFlags: ['stack', 'branch', 'strategy'],
  options: [
    ['-a, --all', 'update every repo'],
    ['-n, --dry-run', 'only report what would come in'],
    ['    --branch <name>', 'check out a branch before pulling'],
    ['    --strategy <s>', 'ff-only (default), rebase or reset'],
  ],
  details:
    'This only moves the working tree. Containers keep running the build they\n' +
    'already have, so it is safe to run on a whole fleet and deploy later.',
  examples: [
    ['blankey pull --all', 'fast-forward every repo'],
    ['blankey pull --all -n', 'see what is waiting without touching anything'],
    ['blankey pull shop-api --branch release', 'switch branch and update'],
  ],
  async run(ctx) {
    const targets = await ctx.targets(ctx.positional, { stackFlag: ctx.flags.stack, all: ctx.flags.all });
    const dry = Boolean(ctx.flags.dryRun);
    const seen = new Set();
    const rows: any[] = [];
    const incoming = new Map();

    log.blank();
    if (dry) log.raw(rule('dry run: nothing will be changed'));

    for (const { project, stack } of targets) {
      if (seen.has(project.name)) continue;
      seen.add(project.name);

      if (!project.isGit) {
        rows.push({ name: project.name, icon: c.faint(S.ring), result: c.faint('not a git repo'), detail: '' });
        continue;
      }
      if (!project.autoUpdate) {
        rows.push({
          name: project.name, icon: c.faint(S.ring), result: c.faint('updates off'),
          detail: c.faint('updates: false in .blankey.yml'),
        });
        continue;
      }
      // A repo with no upstream has nothing to pull from. That is a normal
      // setup, not a failure, so it is reported as such.
      if (!(await git.tracksRemote(stack.dir))) {
        rows.push({
          name: project.name, icon: c.faint(S.ring), result: c.faint('local only'),
          detail: c.faint('no remote to pull from'),
        });
        continue;
      }

      const sp = new Spinner(`${c.muted(dry ? 'checking' : 'updating')} ${bold(project.name)}`).start();
      const fetched = await git.fetch(stack.dir);
      if (!fetched.ok) {
        sp.fail(`${bold(project.name)} ${c.err('fetch failed')}`);
        rows.push({
          name: project.name, icon: c.err(S.cross), result: c.err('fetch failed'),
          detail: c.faint(firstLine(fetched.error, 50)),
        });
        continue;
      }

      if (dry) {
        const ahead = await git.incoming(stack.dir, 10);
        const st = await git.status(stack.dir);
        incoming.set(project.name, ahead);
        sp.stop(ahead.length ? S.down : S.ring,
          `${bold(project.name)} ${ahead.length ? fg(P.info, ahead.length + ' commit(s) waiting') : c.faint('current')}`,
          ahead.length ? P.info : P.faint);
        rows.push({
          name: project.name,
          icon: ahead.length ? fg(P.info, S.down) : c.faint(S.ring),
          result: ahead.length ? fg(P.info, `${ahead.length} waiting`) : c.faint('current'),
          detail: st.dirty ? c.warn(`${st.dirty} local change(s)`) : c.faint(st.branch || ''),
        });
        continue;
      }

      const r = await git.pull(stack.dir, {
        strategy: ctx.flags.strategy || ctx.cfg.defaults.gitStrategy,
        branch: ctx.flags.branch,
      });
      if (!r.ok) {
        sp.fail(`${bold(project.name)} ${c.err('pull failed')}`);
        rows.push({
          name: project.name, icon: c.err(S.cross), result: c.err('failed'),
          detail: c.faint(firstLine(r.error, 50)),
        });
        continue;
      }
      if (r.changed) {
        const commits = await git.logBetween(stack.dir, r.from, r.to, 10);
        incoming.set(project.name, commits);
        sp.succeed(`${bold(project.name)} ${c.faint(r.from)} ${S.arrow} ${fg(P.info, r.to)}`);
        rows.push({
          name: project.name, icon: c.ok(S.tick), result: c.ok('updated'),
          detail: c.muted(`${commits.length} commit(s)`),
        });
      } else {
        sp.skip(`${bold(project.name)} ${c.faint('already current')}`);
        rows.push({ name: project.name, icon: c.faint(S.ring), result: c.faint('current'), detail: '' });
      }
    }

    log.blank();
    log.raw(table(rows.map((r) => ({ ...r, name: bold(r.name) })), [
      { key: 'icon', label: '', grow: false },
      { key: 'name', label: 'repo', min: 10 },
      { key: 'result', label: 'result', grow: false },
      { key: 'detail', label: '', min: 6 },
    ]));
    log.blank();

    for (const [name, commits] of incoming) {
      if (!commits.length) continue;
      log.raw(`  ${bold(name)}`);
      commitList(commits);
      log.blank();
    }

    const moved = [...incoming.entries()].filter(([, v]) => v.length).map(([k]) => k);
    if (dry && moved.length) {
      log.hint(`blankey pull ${ctx.flags.all ? '--all' : moved[0]}  to apply`);
      log.blank();
    } else if (moved.length) {
      log.hint(`updated but still running the old build ${S.arrow} blankey deploy ${ctx.flags.all ? '--all --changed' : moved[0]}`);
      log.blank();
    }
    return rows.some((r) => strip(r.result).includes('failed')) ? 1 : 0;
  },
};

export const rollback = {
  name: 'rollback',
  group: 'Deployments',
  describe: 'Return a stack to the commit it ran before the last deploy',
  usage: 'rollback <project[:stack]> [--to <sha>]',
  valueFlags: ['stack', 'to'],
  options: [['    --to <sha>', 'roll back to a specific commit instead']],
  async run(ctx) {
    const { project, stack } = await ctx.target(ctx.positional[0], { stackFlag: ctx.flags.stack });
    const label = stackLabel(project, stack);
    if (!project.isGit) {
      log.fail(`${label} is not a git repo, so there is nothing to roll back to.`);
      return 1;
    }
    const target = ctx.flags.to || (await lastGoodSha(ctx.cfg, project.name, stack.name));
    if (!target) {
      log.fail(`No previous deploy recorded for ${label}.`);
      log.hint('Pass --to <sha> to choose a commit yourself.');
      return 1;
    }
    const current = await git.currentSha(stack.dir);
    const [fromSubject, toSubject] = await Promise.all([
      current ? git.subjectOf(stack.dir, current) : Promise.resolve(null),
      git.subjectOf(stack.dir, String(target)),
    ]);
    // Nothing to undo when the last good deploy is what is already checked out.
    if (current && current.startsWith(String(target))) {
      log.blank();
      log.ok(`${label} is already on ${c.bold(String(target).slice(0, 7))}${toSubject ? c.faint('  ' + toSubject) : ''}.`);
      log.hint(`blankey checkout ${project.name} --list  to pick a different commit`);
      log.blank();
      return 0;
    }

    log.blank();
    log.raw(`  ${bold(label)}`);
    log.raw(`    ${c.muted('from')} ${c.faint(current?.slice(0, 7))} ${fromSubject ? c.muted(fromSubject) : ''}`);
    log.raw(`    ${c.muted('to')}   ${fg(P.warn, String(target).slice(0, 7))} ${toSubject ? c.muted(toSubject) : ''}`);
    log.blank();
    if (!ctx.yes && !(await confirm('  Roll back and restart?', { def: false }))) {
      return cancelled();
    }
    const sp = new Spinner(`${c.muted('rolling back')} ${label}`).start();
    const back = await git.checkoutCommit(stack.dir, target);
    if (!back.ok) {
      sp.fail(`rollback failed: ${back.error}`);
      return 1;
    }
    const r = await docker.composeStream(stack, 'up -d --build --remove-orphans', {
      onLine: (line) => sp.update(`${c.muted('restarting')} ${label} ${c.faint(line.slice(0, 50))}`),
    });
    if (r.code !== 0) {
      sp.fail(`${label} restart failed`);
      for (const line of r.tail.slice(-6)) log.raw('    ' + c.faint(line));
      return 1;
    }
    sp.succeed(`${bold(label)} ${c.warn('rolled back to ' + String(target).slice(0, 7))}${toSubject ? c.faint('  ' + toSubject) : ''}`);
    await recordDeploy(ctx.cfg, {
      project: project.name, stack: stack.name, ok: true, status: 'rollback',
      fromSha: current?.slice(0, 7), toSha: String(target).slice(0, 7),
      subject: toSubject,
    });
    log.blank();
    return 0;
  },
};

export const history = {
  name: 'history',
  aliases: ['hist'],
  group: 'Deployments',
  describe: 'Show recent deploys recorded on this host',
  usage: 'history [project[:stack]] [--limit N]',
  valueFlags: ['stack', 'limit'],
  options: [['    --limit <n>', 'how many entries to show (default 20)']],
  async run(ctx) {
    const spec = ctx.positional[0];
    let project: any = null;
    let stackName = ctx.flags.stack || null;
    if (spec) {
      const t = await ctx.target(spec, { stackFlag: ctx.flags.stack });
      project = t.project.name;
      stackName = t.stack.name;
    }
    const entries = (await historyFor(ctx.cfg, project, stackName)).slice(0, Number(ctx.flags.limit) || 20);
    // Discovery can fail (no projects directory), which only means the older
    // entries stay unnamed, not that the history cannot be shown.
    const dirs = await ctx.projects()
      .then((list: any[]) => new Map(list.map((p) => [p.name, p.dir])))
      .catch(() => new Map<string, string>());
    await fillSubjects(entries, (name) => dirs.get(name));
    if (ctx.json) {
      log.raw(JSON.stringify(entries, null, 2));
      return 0;
    }
    log.blank();
    if (!entries.length) {
      log.raw(`  ${c.faint('No deploys recorded yet.')}`);
      log.blank();
      return 0;
    }
    log.raw(table(entries.map((d) => ({
      icon: d.ok ? c.ok(S.tick) : c.err(S.cross),
      when: c.faint(relTime(d.at)),
      name: bold(d.stack === 'default' ? d.project : `${d.project}:${d.stack}`) +
        (d.ephemeral ? c.faint(' one-shot') : ''),
      status: d.status === 'ok' ? c.ok('deployed')
        : d.status === 'rollback' ? c.warn('rollback')
          : d.status === 'checkout' ? c.info('checkout') : c.err(d.status),
      change: shaChange(d),
      message: subjectCell(d.subject),
      took: d.took ? c.faint(duration(d.took)) : '',
      error: d.error ? c.faint(firstLine(d.error, 40)) : '',
    })), [
      { key: 'icon', label: '', grow: false },
      { key: 'when', label: 'when', align: 'right', grow: false },
      { key: 'name', label: 'stack', min: 10 },
      { key: 'status', label: 'status', grow: false },
      { key: 'change', label: 'commit', grow: false },
      { key: 'message', label: 'message', min: 8, max: 32 },
      { key: 'took', label: 'took', align: 'right', grow: false },
      { key: 'error', label: 'note', min: 6 },
    ]));
    log.blank();
    return 0;
  },
};
