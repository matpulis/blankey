import { log, cancelled, commitList } from '../ui/log.js';
import { c, P, fg, bold, badge } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { Spinner } from '../ui/spinner.js';
import { confirm, select } from '../ui/prompt.js';
import { table } from '../ui/table.js';
import { rule, box } from '../ui/box.js';
import { stackLabel } from '../context.js';
import * as git from '../git.js';
import * as docker from '../docker.js';
import { recordDeploy, historyFor } from '../state.js';
import { relTime, firstLine } from '../util.js';

/**
 * Move a repo to any commit, tag or branch without running the deploy pipeline.
 * Pinning to a commit checks out detached on purpose: the branch pointer is left
 * untouched, so `blankey checkout <project> <branch>` always undoes it.
 */
export const checkout = {
  name: 'checkout',
  aliases: ['co', 'pin'],
  group: 'Deployments',
  describe: 'Put a repo on a specific commit, tag or branch',
  usage: 'checkout <project[:stack]> [ref] [--restart|--deploy] [--list]',
  valueFlags: ['stack', 'limit'],
  flagAliases: { l: 'list' },
  options: [
    ['-s, --stack <name>', 'stack to restart afterwards'],
    ['-l, --list', 'list recent commits and deploys to pick from'],
    ['    --restart', 'recreate the containers after moving (no rebuild)'],
    ['    --deploy', 'run the full deploy pipeline after moving'],
    ['    --force', 'move even with uncommitted changes (they are discarded)'],
    ['    --limit <n>', 'how many commits to list (default 15)'],
  ],
  details:
    'With no ref, or with --list, it shows recent commits and marks the one you\n' +
    'are on plus the ones blankey has deployed, so you can pick a known-good\n' +
    'point after a bad release. Nothing restarts unless you ask it to.',
  examples: [
    ['blankey checkout shop-api --list', 'see where you could go back to'],
    ['blankey checkout shop-api 1fc22c6 --restart', 'pin to a commit and restart'],
    ['blankey checkout shop-api main', 'return to the branch you were tracking'],
  ],
  async run(ctx) {
    const { project, stack } = await ctx.target(ctx.positional[0], { stackFlag: ctx.flags.stack });
    const label = stackLabel(project, stack);
    if (!project.isGit) {
      log.blank();
      log.fail(`${label} is not a git repository.`);
      log.blank();
      return 1;
    }

    let ref = ctx.positional[1];
    const status = await git.status(project.dir);
    const deploys = await historyFor(ctx.cfg, project.name, null);
    const deployedShas = new Set(deploys.filter((d) => d.ok && d.toSha).map((d) => d.toSha));

    if (!ref || ctx.flags.list) {
      const commits = await git.recentCommits(project.dir, Number(ctx.flags.limit) || 15);
      renderCommits(project, status, commits, deployedShas);
      if (ctx.flags.list || !commits.length) return 0;

      const picked = await select('Check out which commit?', [
        ...commits.slice(0, 10).map((cm) => ({
          label: `${cm.short}  ${cm.subject.slice(0, 48)}`,
          value: cm.full,
          hint: deployedShas.has(cm.short) ? 'deployed' : '',
        })),
        { label: c.faint('cancel'), value: null },
      ]);
      if (!picked) {
        return cancelled();
      }
      ref = picked;
    }

    const sha = await git.resolveRef(project.dir, ref);
    if (!sha) {
      log.blank();
      log.fail(`${c.bold(String(ref))} is not a commit, tag or branch in ${project.name}.`);
      log.hint(`blankey checkout ${project.name} --list`);
      log.blank();
      return 1;
    }

    const current = await git.currentSha(project.dir);
    const subject = await git.subjectOf(project.dir, sha);
    if (current === sha) {
      log.blank();
      log.ok(`${label} is already on ${c.bold(sha.slice(0, 7))}${subject ? c.faint('  ' + subject) : ''}.`);
      log.blank();
      return 0;
    }

    if (status.dirty && !ctx.flags.force) {
      log.blank();
      log.fail(`${label} has ${status.dirty} uncommitted change(s).`);
      log.hint('Commit or stash them, or pass --force to discard them.');
      log.blank();
      return 1;
    }

    // Show what actually changes before touching anything.
    const goingBack = await git.logBetween(project.dir, sha, current, 10);
    const goingForward = await git.logBetween(project.dir, current, sha, 10);
    log.blank();
    log.raw(`  ${bold(label)}  ${c.faint(current?.slice(0, 7))} ${S.arrow} ${fg(P.info, sha.slice(0, 7))}${subject ? c.muted('  ' + subject) : ''}`);
    if (goingBack.length) {
      log.raw(`  ${c.warn(`rewinding past ${goingBack.length} commit(s)`)}`);
      commitList(goingBack);
    }
    if (goingForward.length) {
      log.raw(`  ${c.info(`advancing ${goingForward.length} commit(s)`)}`);
      commitList(goingForward);
    }
    log.blank();

    if (!ctx.yes && !(await confirm('  Check it out?', { def: true }))) {
      return cancelled();
    }

    const sp = new Spinner(`${c.muted('checking out')} ${label}`).start();
    const res = await git.checkoutRef(project.dir, ref, { force: Boolean(ctx.flags.force) });
    if (!res.ok) {
      sp.fail(`checkout failed: ${firstLine(res.error)}`);
      return 1;
    }
    sp.succeed(`${bold(label)} now on ${fg(P.info, sha.slice(0, 7))}${res.detached ? c.faint(' (detached)') : c.faint(' (' + ref + ')')}${subject ? c.muted('  ' + subject) : ''}`);

    let code = 0;
    if (ctx.flags.deploy) {
      const { deploy } = await import('./deploy.js');
      // The repo is already where it should be, so do not let git move it again.
      code = await deploy.run({
        ...ctx,
        positional: [`${project.name}:${stack.name}`],
        flags: { ...ctx.flags, git: false, all: false },
        yes: true,
      });
    } else if (ctx.flags.restart) {
      const sp2 = new Spinner(`${c.muted('restarting')} ${label}`).start();
      const r = await docker.composeStream(stack, 'up -d --remove-orphans', {
        onLine: (line) => sp2.update(`${c.muted('restarting')} ${label} ${c.faint(line.slice(0, 50))}`),
      });
      if (r.code !== 0) {
        sp2.fail(`${label} restart failed`);
        for (const line of r.tail.slice(-6)) log.raw('    ' + c.faint(line));
        code = 1;
      } else {
        sp2.succeed(`${bold(label)} restarted`);
      }
      await recordDeploy(ctx.cfg, {
        project: project.name, stack: stack.name, ok: code === 0, status: 'checkout',
        fromSha: current?.slice(0, 7), toSha: sha.slice(0, 7), subject,
      });
    }

    if (!ctx.flags.deploy && !ctx.flags.restart) {
      log.blank();
      log.raw(box([
        `${c.muted('The files moved, but the containers are still running the old build.')}`,
        `${c.bold('blankey deploy ' + project.name)}   ${c.muted('rebuild and restart')}`,
        `${c.bold('blankey up ' + project.name)}       ${c.muted('recreate without rebuilding')}`,
      ], { title: 'nothing restarted yet', color: P.warn }));
    }
    log.blank();
    return code;
  },
};

function renderCommits(project, status, commits, deployedShas) {
  log.blank();
  log.raw(rule(`${project.name} ${S.bullet} ${status.branch || 'detached'}`));
  log.blank();
  if (!commits.length) {
    log.raw(`  ${c.faint('no commits found')}`);
    log.blank();
    return;
  }
  log.raw(table(commits.map((cm) => {
    const isHead = status.head === cm.short;
    return {
      marker: isHead ? fg(P.brand, S.play) : ' ',
      sha: isHead ? bold(fg(P.brand2, cm.short)) : fg(P.info, cm.short),
      when: c.faint(relTime(cm.date)),
      subject: isHead ? bold(cm.subject) : c.muted(cm.subject),
      author: c.faint(cm.author),
      tag: deployedShas.has(cm.short) ? badge('DEPLOYED', P.ok) : isHead ? c.faint('current') : '',
    };
  }), [
    { key: 'marker', label: '', grow: false },
    { key: 'sha', label: 'commit', grow: false },
    { key: 'when', label: 'age', align: 'right', grow: false },
    { key: 'subject', label: 'subject', min: 20 },
    { key: 'author', label: 'author', max: 16 },
    { key: 'tag', label: '', grow: false },
  ]));
  log.blank();
  log.raw(`  ${c.faint(`blankey checkout ${project.name} <commit> --restart`)}`);
  log.blank();
}
