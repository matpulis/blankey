import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

/**
 * Noticing that a newer blankey exists, and installing it.
 *
 * Two rules shape all of this. It must never slow a command down: the check
 * runs in a detached child that the parent does not wait for, and what you see
 * comes from a cache written by a previous run. And it must never install
 * anything without being asked, because updating is `curl | sh` with root, not
 * something to do behind someone's back.
 *
 * Everything here is deliberately local. The Docker host may be somewhere else
 * entirely; the blankey being upgraded is the one on this machine.
 */

export interface Release {
  version: string;
  /** The release page, so a human can read what changed before saying yes. */
  url: string;
  publishedAt: string | null;
}

export interface UpdateCache {
  checkedAt: string;
  latest: string | null;
  url: string | null;
  publishedAt: string | null;
}

// ------------------------------------------------------------------ versions

export function parseVersion(value: unknown): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? '').trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' };
}

/** -1, 0 or 1. Unparseable versions compare equal, so nothing is offered. */
export function compareVersions(a: unknown, b: unknown): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left.nums[i]! !== right.nums[i]!) return left.nums[i]! < right.nums[i]! ? -1 : 1;
  }
  // 1.2.0 is newer than 1.2.0-beta.1, which is what semver says and what
  // anyone reading a release list expects.
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export const isNewer = (candidate: unknown, current: unknown): boolean =>
  compareVersions(candidate, current) > 0;

// ------------------------------------------------------------------ settings

export interface UpdateSettings {
  enabled: boolean;
  /** `owner/name` on GitHub. Empty means there is nothing to check against. */
  repo: string;
  installUrl: string;
  ttlMs: number;
}

/** Accept a full GitHub URL as well as `owner/name`, since both get pasted in. */
export function normalizeRepo(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');
}

export function updateSettings(cfg: any): UpdateSettings {
  const s = (cfg && cfg.selfUpdate) || {};
  const repo = normalizeRepo(s.repo);
  return {
    enabled: s.check !== false && !process.env.BLANKEY_NO_UPDATE_CHECK && Boolean(repo),
    repo,
    installUrl: String(s.installUrl || '')
      || (repo ? `https://raw.githubusercontent.com/${repo}/main/install.sh` : ''),
    ttlMs: Math.max(1, Number(s.everyHours) || 24) * 60 * 60 * 1000,
  };
}

// --------------------------------------------------------------------- cache

function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'blankey');
}

export const cacheFile = (): string => path.join(cacheDir(), 'update-check.json');

export async function readCache(): Promise<UpdateCache | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as UpdateCache : null;
  } catch {
    return null;
  }
}

export async function writeCache(entry: UpdateCache): Promise<void> {
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(cacheFile(), JSON.stringify(entry, null, 2), 'utf8');
  } catch {
    // A cache that cannot be written just means checking again next time.
  }
}

export function isStale(cache: UpdateCache | null, ttlMs: number, now = Date.now()): boolean {
  if (!cache?.checkedAt) return true;
  const at = new Date(cache.checkedAt).getTime();
  return !Number.isFinite(at) || now - at > ttlMs;
}

// ------------------------------------------------------------------ fetching

/**
 * Run a command on *this* machine. Deliberately not `host.exec`, which follows
 * the configured SSH host: the install being checked is the local one.
 */
function localExec(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout?.on('data', (d) => { if (out.length < 1_000_000) out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

/**
 * Why a check came back empty. "No releases" and "cannot reach GitHub" need
 * very different advice, and the first is what everyone sees the day they turn
 * this on, so they are not collapsed into one failure.
 */
export type LatestResult =
  | { ok: true; release: Release }
  | { ok: false; reason: 'unreachable' | 'no-releases' | 'malformed'; status?: number };

/** The newest published release. Never throws. */
export async function fetchLatest(repo: string, { timeoutMs = 10000 }: { timeoutMs?: number } = {}): Promise<LatestResult> {
  if (!repo) return { ok: false, reason: 'no-releases' };
  // Overridable for GitHub Enterprise, and so this is testable without the
  // real API on the other end.
  const api = (process.env.BLANKEY_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
  const url = `${api}/repos/${repo}/releases/latest`;
  const seconds = String(Math.max(1, Math.round(timeoutMs / 1000)));

  // No `-f`: a 404 has to come back as a 404 rather than as a dead connection,
  // so the status is appended to the body and split off again below.
  const raw = await localExec('curl', [
    '-sSL', '--max-time', seconds,
    '-w', '\\n%{http_code}',
    '-H', 'Accept: application/vnd.github+json',
    url,
  ], timeoutMs + 2000);
  if (raw === null) return { ok: false, reason: 'unreachable' };

  const cut = raw.lastIndexOf('\n');
  const status = Number(raw.slice(cut + 1).trim());
  const body = cut >= 0 ? raw.slice(0, cut) : '';

  // GitHub answers 404 for a repo with no releases, one whose only releases are
  // prereleases, and one that is private or absent. All of them mean the same
  // thing here: there is nothing to offer yet.
  if (status === 404) return { ok: false, reason: 'no-releases', status };
  if (status !== 200) return { ok: false, reason: 'unreachable', status };

  try {
    const data = JSON.parse(body);
    const version = String(data.tag_name || data.name || '').trim();
    if (!parseVersion(version)) return { ok: false, reason: 'malformed' };
    return {
      ok: true,
      release: {
        version,
        url: String(data.html_url || `https://github.com/${repo}/releases`),
        publishedAt: data.published_at ? String(data.published_at) : null,
      },
    };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/** Check now and record the answer. Used by the background refresh. */
export async function refresh(cfg: any): Promise<Release | null> {
  const { repo } = updateSettings(cfg);
  const result = await fetchLatest(repo);
  const release = result.ok ? result.release : null;
  // Recorded either way, so a repo with no releases yet is not re-checked on
  // every single command.
  await writeCache({
    checkedAt: new Date().toISOString(),
    latest: release?.version ?? null,
    url: release?.url ?? null,
    publishedAt: release?.publishedAt ?? null,
  });
  return release;
}

// ------------------------------------------------------------------ noticing

/** What the last check found, if it is newer than what is running. */
export async function pendingUpdate(cfg: any, current: string): Promise<Release | null> {
  const { enabled } = updateSettings(cfg);
  if (!enabled) return null;
  const cache = await readCache();
  if (!cache?.latest || !isNewer(cache.latest, current)) return null;
  return { version: cache.latest, url: cache.url ?? '', publishedAt: cache.publishedAt };
}

/**
 * Kick off a check that outlives this process.
 *
 * Detached and unref'd, so the command the user actually asked for exits the
 * moment it is done. Nothing is awaited and nothing is reported: the result is
 * for the *next* run to notice.
 */
export function scheduleRefresh(configFile?: string | null): void {
  const entry = process.argv[1];
  if (!entry) return;
  const args = [entry, 'update', '--refresh'];
  // The child re-reads the config on its own, and would search the default
  // locations without this. A `--config` the parent was given has to be
  // handed on, or the child checks against the wrong repo or none at all.
  if (configFile && !configFile.startsWith('(')) args.push('--config', configFile);
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, BLANKEY_NO_UPDATE_CHECK: '1' },
    });
    child.unref();
  } catch {
    // Not being able to spawn is not worth telling anyone about.
  }
}

/**
 * Show a pending update, and start a check when the last one has gone stale.
 *
 * Silent unless there is genuinely something to say, and never on machine-read
 * output, so `--json` stays parseable and `--quiet` stays quiet.
 */
export async function noticeUpdate(
  cfg: any,
  current: string,
  { json = false, quiet = false, tty = process.stdout.isTTY }: { json?: boolean; quiet?: boolean; tty?: boolean } = {},
): Promise<Release | null> {
  try {
    const { enabled, ttlMs } = updateSettings(cfg);
    if (!enabled || json || quiet || !tty) return null;

    const cache = await readCache();
    if (isStale(cache, ttlMs)) scheduleRefresh(cfg?.__file);

    if (!cache?.latest || !isNewer(cache.latest, current)) return null;
    return { version: cache.latest, url: cache.url ?? '', publishedAt: cache.publishedAt };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- upgrading

export interface UpgradePlan { ok: boolean; command?: string; reason?: string }

/** The exact command an upgrade would run, so it can be shown before it runs. */
export function upgradePlan(cfg: any, version: string): UpgradePlan {
  const { installUrl } = updateSettings(cfg);
  if (!installUrl) {
    return { ok: false, reason: 'no installUrl or repo is configured under selfUpdate' };
  }
  const ref = version.startsWith('v') ? version : `v${version}`;
  return { ok: true, command: `curl -fsSL ${installUrl} | sh -s -- --ref ${ref}` };
}

/**
 * Hand the terminal to the installer and wait for it.
 *
 * stdio is inherited on purpose: the installer needs a real terminal for its
 * own output and, more importantly, for sudo to be able to ask for a password.
 */
export function runUpgrade(command: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}
