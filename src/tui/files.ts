import { menu, input, notice, busy, CANCEL, type ScreenLike, type MenuItem, type Cancelled } from './widgets.js';
import { c } from '../ui/colors.js';
import { bytes } from '../util.js';
import * as host from '../host.js';

/**
 * Picking a file that lives on the Docker host.
 *
 * Both registries that take files from the operator, SSL configurations and
 * SSH identities, work the same way: a drop folder to upload into, listed so
 * you can pick what arrived, with typing a path as the fallback for a file
 * already somewhere else. That flow is here rather than in each of them,
 * because the thing people get wrong is the same either way: these paths are
 * on the Docker host, not on the workstation running blankey.
 */

export interface PickedFile {
  path: string;
  /** Came from the drop folder, so the original is a spare copy to clean up. */
  fromIncoming: boolean;
}

/** Ask for a path on the Docker host, and keep asking until one exists. */
export async function askFilePath(
  screen: ScreenLike,
  breadcrumb: string[],
  { label, help, placeholder, value = '' }: { label: string; help: string; placeholder: string; value?: string },
): Promise<string | Cancelled> {
  let current = value;
  for (;;) {
    const picked = await input(screen, {
      breadcrumb,
      label,
      help,
      value: current,
      placeholder,
      validate: (t) => (t.trim() ? null : 'Enter a path'),
    });
    if (picked === CANCEL) return CANCEL;
    const p = (picked as string).trim();

    busy(screen, breadcrumb, 'checking the file');
    if (await host.exists(p)) return p;

    current = p;
    await notice(screen, {
      breadcrumb,
      tone: 'danger',
      message: 'File not found',
      detail: [
        c.faint(p),
        '',
        c.muted('That is checked on the Docker host itself (or the SSH target), not your workstation.'),
      ],
      action: 'Try again',
    });
  }
}

export interface DropFolderOptions {
  /** The folder to upload into. Created if it is not there yet. */
  dir: string;
  label: string;
  help: string;
  placeholder: string;
  /** A file already chosen for another slot, so the same one is not offered twice. */
  exclude?: string;
  /** Offer to carry on without a file. Returns null when taken. */
  skipLabel?: string;
}

/**
 * Pick a file: whatever has been uploaded to the drop folder, a path already
 * on this host, or nothing at all when `skipLabel` is given.
 *
 * The folder itself is always the first thing on screen, so there is never a
 * guess about where a certificate or a key is supposed to go.
 */
export async function pickHostFile(
  screen: ScreenLike,
  breadcrumb: string[],
  { dir, label, help, placeholder, exclude, skipLabel }: DropFolderOptions,
): Promise<PickedFile | null | Cancelled> {
  await host.mkdirp(dir);
  const crumb = [...breadcrumb, label];

  for (;;) {
    const files = (await host.listFilesWithSize(dir)).filter((f) => f.path !== exclude);
    const items: MenuItem<string>[] = [
      { separator: 'drop folder' },
      {
        label: dir,
        disabled: true,
        hint: files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'empty, upload here',
      },
      ...files.map((f) => ({
        label: `  ${f.name}`,
        hint: f.size != null ? bytes(f.size) : '',
        value: `pick:${f.path}`,
      })),
      { separator: '' },
      { label: 'Enter a path instead', value: 'manual', hint: 'already somewhere else on this host' },
      ...(skipLabel ? [{ label: skipLabel, value: 'skip' }] : []),
      { label: 'Check again', value: 'refresh', hint: 'after uploading a file' },
    ];

    const picked = await menu<string>(screen, {
      breadcrumb: crumb, title: label, items, filterable: false, detailTitle: 'About',
    });

    if (picked === CANCEL) return CANCEL;
    if (picked === 'refresh') continue;
    if (picked === 'skip') return null;
    if (picked === 'manual') {
      const path = await askFilePath(screen, crumb, { label, help, placeholder });
      // Backing out of typing a path returns to the list rather than abandoning
      // the whole flow, since the drop folder is still a valid answer.
      if (path === CANCEL) continue;
      return { path: path as string, fromIncoming: false };
    }
    if (typeof picked === 'string' && picked.startsWith('pick:')) {
      return { path: picked.slice(5), fromIncoming: true };
    }
  }
}

/**
 * Remove the drop-folder copies of files that have now been installed
 * elsewhere. Leaving them behind would be a second, easy-to-forget copy of
 * something like a private key.
 */
export async function discardUsedCopies(used: Array<PickedFile | null>): Promise<boolean> {
  let removed = false;
  for (const file of used) {
    if (!file?.fromIncoming) continue;
    await host.remove(file.path);
    removed = true;
  }
  return removed;
}
