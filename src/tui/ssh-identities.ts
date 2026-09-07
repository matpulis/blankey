import { menu, input, confirm, notice, busy, CANCEL, type ScreenLike, type MenuItem, type Cancelled } from './widgets.js';
import { pickHostFile, discardUsedCopies, type PickedFile } from './files.js';
import { T } from './theme.js';
import { c, fg, bold } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import * as host from '../host.js';
import * as git from '../git.js';
import { discover } from '../discover.js';
import {
  listIdentities, getIdentity, generateIdentity, importIdentity, removeIdentity, updateIdentityComment,
  normalizeIdentityName, incomingIdentitiesDir,
  type Identity,
} from '../ssh-identities.js';
import type { Config } from '../types.js';

/**
 * SSH identities: key pairs blankey generates or imports for cloning and
 * pulling private repos. Like an SSL configuration (see tui/certs.ts), each
 * one is entirely files under blankey's own directory; nothing is written
 * into a repo, and nothing lives in blankey.yml. Attaching one to a project
 * is done through `git config core.sshCommand` in that repo's own
 * `.git/config`, which is never tracked.
 */

async function askName(screen: ScreenLike, breadcrumb: string[], existing: Identity[]): Promise<string | Cancelled> {
  const raw = await input(screen, {
    breadcrumb,
    label: 'Name',
    help: 'How this is picked from the list, a deploy key for shop-api, say.',
    placeholder: 'shop-api-deploy',
    validate: (t) => {
      const name = normalizeIdentityName(t);
      if (!name) return 'Enter a name';
      if (existing.some((i) => i.name === name)) return `"${name}" already exists`;
      return null;
    },
  });
  return raw === CANCEL ? CANCEL : normalizeIdentityName(raw as string);
}

/** Pick a key file from the drop folder, from a typed path, or skip it. */
function pickKeyFile(
  screen: ScreenLike, breadcrumb: string[], cfg: Config, label: string, help: string,
  { optional = false, exclude }: { optional?: boolean; exclude?: string } = {},
): Promise<PickedFile | null | Cancelled> {
  return pickHostFile(screen, breadcrumb, {
    dir: incomingIdentitiesDir(cfg),
    label,
    help,
    placeholder: '/root/.ssh/id_deploy',
    exclude,
    ...(optional ? { skipLabel: 'Skip, derive it from the private key' } : {}),
  });
}

function deployKeyNotice(identity: Identity): { title: string; message: string; detail: string[] } {
  return {
    title: 'Add it as a deploy key',
    message: `"${identity.name}" is ready`,
    detail: [
      c.muted('Paste this into your git host (GitHub/GitLab call it a "deploy key") before cloning with it:'),
      '',
      fg(T.info, identity.publicKey || '(could not read the public key)'),
      '',
      identity.fingerprint ? c.faint(identity.fingerprint) : '',
      '',
      c.muted('Any project can use it from here on. Manage Projects ' + S.chevron + ' Add a project offers it when cloning over SSH.'),
    ].filter(Boolean),
  };
}

/** Generate a fresh key pair, or import one already sitting on this host. */
export async function addIdentityFlow(
  screen: ScreenLike, breadcrumb: string[], cfg: Config,
): Promise<Identity | Cancelled> {
  const existing = await listIdentities(cfg);
  const crumb = [...breadcrumb, 'Add SSH identity'];

  const name = await askName(screen, crumb, existing);
  if (name === CANCEL) return CANCEL;

  const commentRaw = await input(screen, {
    breadcrumb: crumb,
    label: 'Comment',
    help: 'Shown on the key itself, and helps tell it apart on the git host\'s deploy-key list later.',
    value: name,
    placeholder: name,
  });
  if (commentRaw === CANCEL) return CANCEL;
  const comment = (commentRaw as string).trim() || name;

  const mode = await menu<'generate' | 'import'>(screen, {
    breadcrumb: crumb,
    title: 'How should this key get here?',
    items: [
      {
        label: 'Generate a new key pair', value: 'generate',
        detail: () => [bold('Generate a new key pair'), '', c.muted('A fresh ed25519 key, made right here. You add the public half as a deploy key afterwards.')],
      },
      {
        label: 'Import an existing key', value: 'import',
        detail: () => [bold('Import an existing key'), '', c.muted('Reuse a key you already have, such as a deploy key downloaded from GitHub.')],
      },
    ],
    filterable: false,
  });
  if (mode === CANCEL) return CANCEL;

  if (mode === 'generate') {
    busy(screen, crumb, 'generating the key');
    try {
      await generateIdentity(cfg, name, { comment });
    } catch (e: any) {
      await notice(screen, { breadcrumb: crumb, tone: 'danger', title: 'Could not generate it', message: e?.message || String(e), action: 'Back' });
      return CANCEL;
    }
  } else {
    const dir = incomingIdentitiesDir(cfg);
    await host.mkdirp(dir);
    await notice(screen, {
      breadcrumb: crumb,
      tone: 'info',
      title: 'Where to put the file',
      message: 'Upload the private key to this folder first',
      detail: [
        fg(T.info, dir),
        '',
        c.muted('Copy it there however you normally get files onto this host: scp, sftp, your provider\'s file manager.'),
        '',
        c.faint('Already have it somewhere else on this host? The next screen also lets you type a path.'),
      ],
      action: 'Continue',
    });

    const priv = await pickKeyFile(screen, crumb, cfg, 'Private key file', 'The key itself, with no passphrase, since nothing here can type one in later.');
    if (priv === CANCEL || priv === null) return CANCEL;

    const pub = await pickKeyFile(screen, crumb, cfg, 'Public key file', 'Its matching .pub file.', { optional: true, exclude: priv.path });
    if (pub === CANCEL) return CANCEL;

    busy(screen, crumb, 'installing the key');
    try {
      await importIdentity(cfg, name, {
        privateSourcePath: priv.path,
        publicSourcePath: pub ? pub.path : undefined,
        comment,
      });
    } catch (e: any) {
      await notice(screen, { breadcrumb: crumb, tone: 'danger', title: 'Could not install it', message: e?.message || String(e), action: 'Back' });
      return CANCEL;
    }

    await discardUsedCopies([priv, pub]);
  }

  const identity = await getIdentity(cfg, name);
  if (!identity) return CANCEL;

  const notice_ = deployKeyNotice(identity);
  await notice(screen, { breadcrumb: crumb, tone: 'success', ...notice_, action: 'Done' });
  return identity;
}

/** Which projects currently pin their git config to this identity. */
async function findProjectsUsingIdentity(cfg: Config, name: string): Promise<string[]> {
  const identity = await getIdentity(cfg, name);
  if (!identity) return [];
  const { projects } = await discover(cfg).catch(() => ({ projects: [] as any[] }));
  const hits: string[] = [];
  for (const project of projects) {
    if (!project.isGit) continue;
    const current = await git.sshIdentityCommand(project.dir);
    if (current && current.includes(identity.privatePath)) hits.push(project.name);
  }
  return hits;
}

function identityDetail(identity: Identity): string[] {
  return [
    bold(identity.name),
    '',
    `${c.muted('comment')}      ${c.faint(identity.comment || 'none')}`,
    `${c.muted('fingerprint')}  ${identity.fingerprint ? c.faint(identity.fingerprint) : fg(T.danger, 'unavailable')}`,
    `${c.muted('private key')}  ${identity.hasFiles ? c.faint(identity.privatePath) : fg(T.danger, `${S.cross} missing`)}`,
    '',
    c.muted('public key'),
    identity.publicKey ? fg(T.info, identity.publicKey) : fg(T.danger, 'missing'),
  ];
}

async function manageOneIdentity(screen: ScreenLike, breadcrumb: string[], cfg: Config, name: string): Promise<void> {
  const crumb = [...breadcrumb, name];
  for (;;) {
    const identity = await getIdentity(cfg, name);
    if (!identity) return;

    const picked = await menu<string>(screen, {
      breadcrumb: crumb,
      title: name,
      items: [
        { label: 'View public key', value: 'view', hint: 'to paste as a deploy key' },
        { label: 'Edit comment', hint: identity.comment || 'none', value: 'comment' },
        { separator: '' },
        { label: 'Remove', value: 'remove' },
      ],
      detailTitle: 'Identity',
      filterable: false,
    });

    if (picked === CANCEL) return;

    if (picked === 'view') {
      await notice(screen, { breadcrumb: crumb, tone: 'info', ...deployKeyNotice(identity), action: 'Back' });
      continue;
    }

    if (picked === 'comment') {
      const raw = await input(screen, {
        breadcrumb: [...crumb, 'Comment'], label: 'Comment', value: identity.comment, placeholder: name,
      });
      if (raw !== CANCEL) await updateIdentityComment(cfg, name, (raw as string).trim() || name);
      continue;
    }

    if (picked === 'remove') {
      busy(screen, crumb, 'checking which projects use it');
      const usedBy = await findProjectsUsingIdentity(cfg, name);
      const go = await confirm(screen, {
        breadcrumb: crumb,
        message: `Remove "${name}"?`,
        detail: usedBy.length
          ? [
            fg(T.warn, S.warn) + ' ' + bold(`Used by ${usedBy.length} project${usedBy.length === 1 ? '' : 's'}:`),
            ...usedBy.map((x) => c.muted(`  ${x}`)),
            '',
            c.muted('Those repos stop being able to pull over SSH until pointed at another identity.'),
          ]
          : [c.muted('Deletes the key pair from this host. Nothing else is touched.')],
        danger: true,
        confirmLabel: 'Remove',
        cancelLabel: 'Keep it',
      });
      if (go !== true) continue;
      busy(screen, crumb, 'removing');
      await removeIdentity(cfg, name);
      await notice(screen, { breadcrumb, tone: 'success', message: `"${name}" removed`, action: 'Done' });
      return;
    }
  }
}

/** The full SSH identities screen, reached from Settings. */
export async function sshIdentitiesEditor(
  screen: ScreenLike, { cfg, breadcrumb = ['Settings'] }: { cfg: Config; breadcrumb?: string[] },
): Promise<void> {
  const crumb = [...breadcrumb, 'SSH identities'];
  for (;;) {
    busy(screen, crumb, 'reading identities');
    const identities = await listIdentities(cfg);
    const items: MenuItem<string>[] = [];

    if (identities.length) items.push({ separator: 'saved' });
    for (const identity of identities) {
      items.push({
        label: identity.name,
        hint: identity.hasFiles ? (identity.fingerprint || identity.comment) : 'missing files',
        badge: identity.hasFiles ? '' : fg(T.danger, S.warn),
        value: `open:${identity.name}`,
        detail: () => identityDetail(identity),
      });
    }

    items.push({ separator: '' });
    items.push({
      label: 'Add an SSH identity',
      value: 'add',
      detail: () => [
        bold('Add an SSH identity'),
        '',
        c.muted('A key pair for cloning and pulling private repos over SSH: generated fresh, or imported from one you already have.'),
      ],
    });

    const picked = await menu<string>(screen, {
      breadcrumb: crumb,
      items,
      title: 'SSH identities',
      emptyMessage: 'none yet',
      detailTitle: 'Identity',
    });

    if (picked === CANCEL) return;
    if (picked === 'add') { await addIdentityFlow(screen, breadcrumb, cfg); continue; }
    if (typeof picked === 'string' && picked.startsWith('open:')) {
      await manageOneIdentity(screen, breadcrumb, cfg, picked.slice(5));
      continue;
    }
  }
}
