import * as host from './host.js';
import { q, outcome, type Outcome } from './host.js';
import { lines } from './util.js';
import type { ExecResult, GitStatus, GitPosition, Commit } from './types.js';

const G = 'git --no-pager';

async function git(dir: string, args: string, opts: Record<string, any> = {}): Promise<ExecResult> {
  return host.exec(`${G} ${args}`, { cwd: dir, timeout: 60000, ...opts });
}

/** Snapshot a repo without touching the network. */
export async function status(dir: string): Promise<GitStatus> {
  const isRepo = await host.exists(host.join(dir, '.git'));
  if (!isRepo) return { isRepo: false };

  const [head, branch, upstream, dirty, remote] = await Promise.all([
    git(dir, 'rev-parse --short HEAD'),
    git(dir, 'rev-parse --abbrev-ref HEAD'),
    git(dir, 'rev-parse --abbrev-ref --symbolic-full-name @{u}'),
    git(dir, 'status --porcelain'),
    git(dir, 'remote get-url origin'),
  ]);

  const out: GitStatus = {
    isRepo: true,
    head: head.code === 0 ? head.stdout : null,
    branch: branch.code === 0 ? branch.stdout : null,
    upstream: upstream.code === 0 ? upstream.stdout : null,
    remote: remote.code === 0 ? remote.stdout : null,
    dirty: dirty.code === 0 ? lines(dirty.stdout).length : 0,
    ahead: 0,
    behind: 0,
    subject: null,
    author: null,
    date: null,
  };

  if (out.upstream) {
    const counts = await git(dir, `rev-list --left-right --count ${q(out.upstream)}...HEAD`);
    if (counts.code === 0) {
      const [behind, ahead] = counts.stdout.split(/\s+/).map(Number);
      out.behind = behind || 0;
      out.ahead = ahead || 0;
    }
  }

  const last = await git(dir, 'log -1 --format=%s%x1f%an%x1f%aI');
  if (last.code === 0) {
    const [subject, author, date] = last.stdout.split(String.fromCharCode(31));
    out.subject = subject || null;
    out.author = author || null;
    out.date = date || null;
  }
  return out;
}

/** Refresh remote refs so ahead/behind counts mean something. */
export async function fetch(dir: string, { prune = true }: { prune?: boolean } = {}): Promise<Outcome> {
  return outcome(await git(dir, `fetch --all --tags ${prune ? '--prune' : ''}`, { timeout: 120000 }));
}

/**
 * Pull with the configured strategy. `ff-only` is the default because a deploy
 * host should never end up with a merge commit nobody asked for.
 */
export async function pull(dir: string, { strategy = 'ff-only', branch }: { strategy?: string; branch?: string } = {}): Promise<any> {
  const before = await git(dir, 'rev-parse HEAD');
  let cmd;
  if (strategy === 'rebase') cmd = 'pull --rebase --autostash';
  else if (strategy === 'reset') {
    const up = await git(dir, 'rev-parse --abbrev-ref --symbolic-full-name @{u}');
    if (up.code !== 0) return { ok: false, error: 'no upstream configured' };
    const f = await fetch(dir);
    if (!f.ok) return { ok: false, error: f.error };
    cmd = `reset --hard ${q(up.stdout)}`;
  } else cmd = 'pull --ff-only';

  if (branch) {
    const co = await git(dir, `checkout ${q(branch)}`);
    if (co.code !== 0) return { ok: false, error: co.stderr || co.stdout };
  }

  const r = await git(dir, cmd, { timeout: 180000 });
  const after = await git(dir, 'rev-parse HEAD');
  return {
    ...outcome(r),
    changed: before.stdout !== after.stdout,
    from: before.stdout.slice(0, 7),
    to: after.stdout.slice(0, 7),
    output: r.stdout || r.stderr,
  };
}

/** Commits between two refs, newest first. Used in deploy summaries. */
export async function logBetween(dir: string, from?: string | null, to?: string | null, limit = 20): Promise<string[]> {
  if (!from || !to || from === to) return [];
  const r = await git(dir, `log --oneline --no-decorate -${limit} ${q(from + '..' + to)}`);
  return r.code === 0 ? lines(r.stdout) : [];
}

export async function changedFiles(dir: string, from?: string | null, to?: string | null): Promise<string[]> {
  if (!from || !to || from === to) return [];
  const r = await git(dir, `diff --name-only ${q(from + '..' + to)}`);
  return r.code === 0 ? lines(r.stdout) : [];
}

/** Roll a repo back to a specific commit, the escape hatch after a bad deploy. */
export async function checkoutCommit(dir: string, sha: string): Promise<Outcome> {
  return outcome(await git(dir, `reset --hard ${q(sha)}`, { timeout: 60000 }));
}

/**
 * Where a repo is sitting right now, in a form that can be restored exactly:
 * a branch name when one is checked out, otherwise the detached commit.
 */
export async function currentPosition(dir: string): Promise<GitPosition> {
  const [branch, sha] = await Promise.all([
    git(dir, 'symbolic-ref -q --short HEAD'),
    git(dir, 'rev-parse HEAD'),
  ]);
  return {
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    sha: sha.code === 0 ? sha.stdout.trim() : null,
  };
}

/** Put a repo back where `currentPosition` found it. */
export async function restorePosition(dir: string, position: GitPosition | null): Promise<Outcome> {
  const ref = position?.branch || position?.sha;
  if (!ref) return { ok: false, error: 'no position recorded' };
  return outcome(await git(dir, `checkout --force ${q(ref)}`, { timeout: 120000 }));
}

/**
 * Whether this repo has somewhere to pull from.
 *
 * A repo with no remote, or a branch with no upstream, is a perfectly normal
 * setup: code edited on the server, or deployed by pushing into it. Treating
 * that as a failed pull is wrong, so callers ask first.
 */
export async function tracksRemote(dir: string): Promise<boolean> {
  const upstream = await git(dir, 'rev-parse --abbrev-ref --symbolic-full-name @{u}');
  return upstream.code === 0 && Boolean(upstream.stdout.trim());
}

/**
 * The first line of a commit message. Shown next to a sha so a human can tell
 * which commit it is without going and looking it up.
 */
export async function subjectOf(dir: string, ref: string): Promise<string | null> {
  const r = await git(dir, `log -1 --format=%s ${q(ref)}`);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Resolve any ref (sha, tag, branch, HEAD~2) to a full commit sha. */
export async function resolveRef(dir: string, ref: string): Promise<string | null> {
  const r = await git(dir, `rev-parse --verify ${q(String(ref) + '^{commit}')}`);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function isBranch(dir: string, ref: string): Promise<boolean> {
  const r = await git(dir, `show-ref --verify --quiet ${q('refs/heads/' + ref)}`);
  return r.code === 0;
}

export async function isDetached(dir: string): Promise<boolean> {
  const r = await git(dir, 'symbolic-ref -q HEAD');
  return r.code !== 0;
}

/**
 * Move the working tree to a ref. Branches are checked out normally; anything
 * else is checked out detached, so pinning to a commit never rewrites the
 * branch and `checkout <branch>` always undoes it.
 */
export async function checkoutRef(dir: string, ref: string, { force = false }: { force?: boolean } = {}): Promise<Outcome & { detached: boolean }> {
  const branch = await isBranch(dir, ref);
  const flags = force ? '--force ' : '';
  const cmd = branch ? `checkout ${flags}${q(ref)}` : `checkout ${flags}--detach ${q(ref)}`;
  return { ...outcome(await git(dir, cmd, { timeout: 120000 })), detached: !branch };
}

const UNIT = String.fromCharCode(31);

/** Recent commits for the pick-a-commit UI. */
export async function recentCommits(dir: string, limit = 20, ref = 'HEAD'): Promise<Commit[]> {
  const fmt = ['%h', '%H', '%s', '%an', '%aI'].join('%x1f');
  const r = await git(dir, `log --no-decorate -${limit} --format=${q(fmt)} ${q(ref)}`);
  if (r.code !== 0) return [];
  return lines(r.stdout).map((line) => {
    const [short, full, subject, author, date] = line.split(UNIT);
    return { short, full, subject, author, date };
  });
}

/** Commits the remote has that the working tree does not. */
export async function incoming(dir: string, limit = 20): Promise<string[]> {
  const up = await git(dir, 'rev-parse --abbrev-ref --symbolic-full-name @{u}');
  if (up.code !== 0) return [];
  const r = await git(dir, `log --oneline --no-decorate -${limit} ${q('HEAD..' + up.stdout.trim())}`);
  return r.code === 0 ? lines(r.stdout) : [];
}

export async function currentSha(dir: string): Promise<string | null> {
  const r = await git(dir, 'rev-parse HEAD');
  return r.code === 0 ? r.stdout : null;
}

export async function branches(dir: string): Promise<string[]> {
  const r = await git(dir, 'branch --format=%(refname:short)');
  return r.code === 0 ? lines(r.stdout) : [];
}

/**
 * `sshCommand`, when given, is the exact `ssh` invocation to authenticate
 * with. That is how one of blankey's saved SSH identities is used for a clone,
 * since the repo does not exist yet for `core.sshCommand` to be set inside
 * it the normal way (see `setSshIdentity`). It is not persisted by the clone
 * itself; call `setSshIdentity` afterwards to keep using it for future pulls.
 */
export async function clone(
  url: string, dir: string, { branch, sshCommand }: { branch?: string; sshCommand?: string } = {},
): Promise<Outcome> {
  const b = branch ? `-b ${q(branch)} ` : '';
  const cfgFlag = sshCommand ? `-c ${q('core.sshCommand=' + sshCommand)} ` : '';
  return outcome(await host.exec(`git ${cfgFlag}clone ${b}${q(url)} ${q(dir)}`, { timeout: 600000 }));
}

/**
 * Pin a repo to a specific SSH identity for every future fetch and pull.
 * `core.sshCommand` lives in `.git/config`, which git already reads on its
 * own and which is never tracked, so this never touches the working tree.
 */
export async function setSshIdentity(dir: string, sshCommand: string): Promise<Outcome> {
  return outcome(await git(dir, `config core.sshCommand ${q(sshCommand)}`));
}

export async function clearSshIdentity(dir: string): Promise<void> {
  await git(dir, 'config --unset core.sshCommand');
}

/** The ssh command a repo is currently pinned to, or null when it uses the host's default. */
export async function sshIdentityCommand(dir: string): Promise<string | null> {
  const r = await git(dir, 'config --get core.sshCommand');
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
