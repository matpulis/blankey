import process from 'node:process';
import os from 'node:os';
import * as host from './host.js';
import { onCleanup } from './cleanup.js';
import { log } from './ui/log.js';

/**
 * A lock file on the Docker host, so a scheduled run and a manual one cannot
 * touch the same thing at once.
 *
 * `mkdir` is the primitive: it is atomic on every POSIX filesystem and fails if
 * the directory already exists, which is exactly the test-and-set needed. The
 * owner writes its identity inside so a stale lock can be recognised and broken
 * rather than blocking forever.
 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface LockOwner { pid: number; host: string; at: string; name: string }

/** Discriminated, so callers can only reach `release` once the lock is held. */
export type LockResult =
  | { ok: false; reason: string; heldBy?: LockOwner | null; ageMs?: number | null }
  | { ok: true; release: () => Promise<void>; dir: string };

function lockDir(cfg: any, name: string): string {
  return host.join(cfg.projectsDir, '.blankey', 'locks', name);
}

export async function acquire(cfg: any, name: string, { staleAfter = STALE_AFTER_MS }: { staleAfter?: number } = {}): Promise<LockResult> {
  const dir = lockDir(cfg, name);
  const infoPath = host.join(dir, 'owner.json');

  await host.mkdirp(host.join(cfg.projectsDir, '.blankey', 'locks'));
  let created = await host.mkdirExclusive(dir);

  if (!created) {
    const held = await readOwner(infoPath);
    const age = held?.at ? Date.now() - new Date(held.at).getTime() : null;

    if (held && age !== null && age < staleAfter) {
      return {
        ok: false,
        heldBy: held,
        ageMs: age,
        reason: `already running (started ${new Date(held.at).toISOString()} on ${held.host}, pid ${held.pid})`,
      };
    }
    // Stale or unreadable: take it over rather than blocking forever.
    log.debug(`breaking stale lock ${dir}`);
    await host.remove(dir);
    created = await host.mkdirExclusive(dir);
    if (!created) return { ok: false, reason: 'could not take the lock' };
  }

  const owner = { pid: process.pid, host: os.hostname(), at: new Date().toISOString(), name };
  await host.writeFile(infoPath, JSON.stringify(owner, null, 2));

  let released = false;
  // Declared first so the cleanup registration below can be referenced from
  // inside release without a temporal dead zone.
  let unregister: (() => void) | undefined;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    const drop = unregister;
    if (drop) drop();
    await host.remove(dir);
  };
  // Ctrl+C must not leave the lock behind.
  unregister = onCleanup(release);

  return { ok: true, release, dir };
}

async function readOwner(infoPath: string): Promise<any> {
  const text = await host.readFile(infoPath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export type LockRun<T> =
  | { ran: false; reason: string; heldBy?: LockOwner | null; result?: undefined }
  | { ran: true; result: T; reason?: undefined };

/** Run `fn` under a lock, releasing it whatever happens. */
export async function withLock<T>(
  cfg: any,
  name: string,
  fn: () => Promise<T> | T,
  opts: { staleAfter?: number } = {},
): Promise<LockRun<T>> {
  const lock = await acquire(cfg, name, opts);
  if (!lock.ok) return { ran: false, reason: lock.reason, heldBy: lock.heldBy };
  try {
    return { ran: true, result: await fn() };
  } finally {
    await lock.release();
  }
}
