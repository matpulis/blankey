/**
 * Work that must still happen if the user hits Ctrl+C.
 *
 * A one-shot deploy moves the repo to another commit and has to put it back.
 * Leaving a repo detached at a commit nobody asked for is exactly the kind of
 * mess this tool exists to prevent, so the restore is registered here and the
 * signal handler in bin/blankey.js drains it before exiting.
 */
type CleanupTask = () => unknown | Promise<unknown>;

const tasks = new Set<CleanupTask>();

export function onCleanup(fn: CleanupTask): () => void {
  tasks.add(fn);
  return () => tasks.delete(fn);
}

export const pendingCleanups = (): number => tasks.size;

export async function runCleanups(): Promise<number> {
  const pending = [...tasks];
  tasks.clear();
  for (const fn of pending) {
    try {
      await fn();
    } catch {
      // Best effort: one failing restore must not block the others.
    }
  }
  return pending.length;
}
