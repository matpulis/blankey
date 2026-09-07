import { menu, input, confirm, notice, busy, CANCEL, type ScreenLike, type Cancelled } from './widgets.js';
import { T } from './theme.js';
import { c, fg, bold } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { pMap, unique } from '../util.js';
import * as host from '../host.js';
import * as docker from '../docker.js';
import * as git from '../git.js';
import { classifyComposeFile } from '../discover.js';
import { scanProjects } from './discovery.js';
import { overlayPath } from '../routes.js';
import { listIdentities, sshCommandFor, type Identity } from '../ssh-identities.js';
import { addIdentityFlow } from './ssh-identities.js';
import type { Config, Project } from '../types.js';

/**
 * Adding and removing whole project repos. Cloning goes through the same
 * SSH identities as everything else (see ssh-identities.ts); nothing about
 * a clone is special-cased here beyond picking which one to use. Removing a
 * project stops and deletes its containers and volumes before the folder
 * itself goes, and never without the operator typing the project's name.
 */

const isSshUrl = (url: string): boolean => /^[\w.-]+@[\w.-]+:/.test(url) || url.startsWith('ssh://');

function deriveProjectName(url: string): string {
  const last = url.trim().split(/[/:]/).filter(Boolean).pop() || '';
  return last.replace(/\.git$/i, '');
}

/** Ask for a project name, and keep asking until the target folder is free. */
async function askProjectName(screen: ScreenLike, breadcrumb: string[], cfg: Config, initial: string): Promise<string | Cancelled> {
  let value = initial;
  for (;;) {
    const raw = await input(screen, {
      breadcrumb,
      label: 'Project name',
      help: 'Becomes the folder name under ' + cfg.projectsDir + '.',
      value,
      validate: (t) => {
        const name = t.trim();
        if (!name) return 'Enter a name';
        if (/[\\/]/.test(name)) return 'No slashes, this is a single folder name';
        if (name.startsWith('.')) return 'Cannot start with a dot';
        return null;
      },
    });
    if (raw === CANCEL) return CANCEL;
    const name = (raw as string).trim();
    busy(screen, breadcrumb, 'checking the folder');
    if (await host.exists(host.join(cfg.projectsDir, name))) {
      value = name;
      await notice(screen, {
        breadcrumb, tone: 'danger', message: `${name} already exists`,
        detail: [c.faint(host.join(cfg.projectsDir, name)), '', c.muted('Pick a different name.')],
        action: 'Try again',
      });
      continue;
    }
    return name;
  }
}

/**
 * Which SSH identity to clone with. Auto-picks the only one that exists,
 * asks when there is a real choice, and offers to set one up on the spot
 * when there is not, since cloning over SSH almost always needs one added as a
 * deploy key on the git host first.
 */
async function pickIdentityForClone(screen: ScreenLike, breadcrumb: string[], cfg: Config): Promise<Identity | null | Cancelled> {
  let identities = await listIdentities(cfg);

  if (!identities.length) {
    const setup = await confirm(screen, {
      breadcrumb,
      message: 'No SSH identities yet',
      detail: [
        c.muted('Cloning over SSH usually needs a key added as a deploy key on the git host first.'),
        c.muted('Skipping clones using this host\'s own default SSH configuration instead.'),
      ],
      confirmLabel: 'Add one now',
      cancelLabel: 'Skip',
      def: true,
    });
    if (setup === CANCEL) return CANCEL;
    if (setup !== true) return null;
    const added = await addIdentityFlow(screen, breadcrumb, cfg);
    return added === CANCEL ? null : added;
  }

  if (identities.length === 1) return identities[0]!;

  for (;;) {
    const picked = await menu<string>(screen, {
      breadcrumb: [...breadcrumb, 'SSH identity'],
      title: 'Which SSH identity should git use?',
      items: [
        ...identities.map((i) => ({
          label: i.name,
          hint: i.hasFiles ? (i.fingerprint || i.comment) : 'missing files',
          value: `id:${i.name}`,
          disabled: !i.hasFiles,
        })),
        { separator: '' },
        { label: "None, use this host's default SSH configuration", value: 'none' },
        { label: 'Add a new SSH identity', value: 'add' },
      ],
      filterable: false,
    });
    if (picked === CANCEL) return CANCEL;
    if (picked === 'none') return null;
    if (picked === 'add') {
      const added = await addIdentityFlow(screen, breadcrumb, cfg);
      if (added === CANCEL) { identities = await listIdentities(cfg); continue; }
      return added;
    }
    return identities.find((i) => i.name === picked.slice(3)) ?? null;
  }
}

/** Paste a git URL, name the folder, pick an identity if it's over SSH, then clone. */
export async function addProjectFlow(screen: ScreenLike, cfg: Config, breadcrumb: string[]): Promise<null> {
  const crumb = [...breadcrumb, 'Add a project'];

  const urlRaw = await input(screen, {
    breadcrumb: crumb,
    label: 'Repository URL',
    help: 'A git clone URL, SSH (git@host:owner/repo.git) or HTTPS.',
    placeholder: 'git@github.com:me/shop-api.git',
    validate: (t) => (t.trim() ? null : 'Enter a repository URL'),
  });
  if (urlRaw === CANCEL) return null;
  const url = (urlRaw as string).trim();

  const name = await askProjectName(screen, crumb, cfg, deriveProjectName(url));
  if (name === CANCEL) return null;

  let identity: Identity | null = null;
  if (isSshUrl(url)) {
    const picked = await pickIdentityForClone(screen, crumb, cfg);
    if (picked === CANCEL) return null;
    identity = picked;
  }

  const dir = host.join(cfg.projectsDir, name as string);
  const go = await confirm(screen, {
    breadcrumb: crumb,
    message: `Clone into ${dir}?`,
    detail: [
      `${c.muted('repository')}  ${c.faint(url)}`,
      `${c.muted('identity')}    ${identity ? c.faint(`${identity.name}  ${identity.fingerprint || ''}`) : c.faint("this host's default SSH configuration")}`,
    ],
    confirmLabel: 'Clone it',
    cancelLabel: 'Cancel',
    def: true,
  });
  if (go !== true) return null;

  busy(screen, crumb, 'cloning');
  const sshCommand = identity ? sshCommandFor(cfg, identity.name) : undefined;
  const result = await git.clone(url, dir, { sshCommand });
  if (!result.ok) {
    await notice(screen, {
      breadcrumb: crumb,
      tone: 'danger',
      title: 'Clone failed',
      message: result.error || 'git clone failed',
      detail: identity
        ? [c.muted(`Double check the "${identity.name}" public key was added as a deploy key on the git host.`)]
        : [],
      action: 'Back',
    });
    return null;
  }
  if (sshCommand) await git.setSshIdentity(dir, sshCommand);

  const files = await host.listFiles(dir);
  const hasCompose = files.some((f) => classifyComposeFile(f));

  await notice(screen, {
    breadcrumb: crumb,
    tone: 'success',
    message: `Cloned into ${dir}`,
    detail: [
      c.faint(dir),
      ...(identity ? [c.muted(`Pinned to the "${identity.name}" SSH identity for future pulls.`)] : []),
      '',
      hasCompose
        ? c.muted('Found a compose file, so this shows up as a project right away.')
        : fg(T.warn, `${S.warn} No compose file found yet. Add a docker-compose.yml before this appears as a project.`),
    ],
    action: 'Done',
  });
  return null;
}

async function pickWholeProject(screen: ScreenLike, cfg: Config, breadcrumb: string[]): Promise<Project | Cancelled | null> {
  const scan = await scanProjects(screen, cfg, breadcrumb);
  if (!scan) return null;
  const { projects } = scan;
  const picked = await menu<string>(screen, {
    breadcrumb,
    title: 'Which project?',
    items: projects.map((p) => ({
      label: p.name,
      hint: `${p.stacks.length} stack${p.stacks.length === 1 ? '' : 's'}`,
      value: p.name,
      detail: () => [bold(p.name), '', c.faint(p.dir), '', c.muted(`stacks: ${p.stacks.map((s) => s.name).join(', ')}`)],
    })),
  });
  if (picked === CANCEL) return CANCEL;
  return projects.find((p) => p.name === picked) ?? null;
}

/**
 * Remove a project entirely: stop and remove its containers and named
 * volumes while the compose files are still there to describe them, then
 * delete the folder. Two separate confirmations, one that names exactly
 * what is about to be destroyed, and one that requires typing the project's
 * name, because this cannot be undone.
 */
export async function removeProjectFlow(screen: ScreenLike, cfg: Config, breadcrumb: string[]): Promise<null> {
  const crumb = [...breadcrumb, 'Remove a project'];
  const project = await pickWholeProject(screen, cfg, crumb);
  if (project === CANCEL || !project) return null;

  busy(screen, crumb, 'checking what would be removed');
  const [gitStatus, perStack] = await Promise.all([
    project.isGit ? git.status(project.dir) : Promise.resolve(null),
    pMap(project.stacks, async (s) => ({ stack: s, containers: await docker.stackPs(s).catch(() => []) }), 4),
  ]);
  const totalContainers = perStack.reduce((n, x) => n + x.containers.length, 0);
  const runningContainers = perStack.reduce((n, x) => n + x.containers.filter((ct: any) => ct.state === 'running').length, 0);
  const volumes = unique(project.stacks.flatMap((s) => s.volumes));

  const warnings: string[] = [];
  if (gitStatus?.dirty) warnings.push(`${gitStatus.dirty} uncommitted change${gitStatus.dirty === 1 ? '' : 's'} would be lost`);
  if (gitStatus?.ahead) warnings.push(`${gitStatus.ahead} commit${gitStatus.ahead === 1 ? '' : 's'} not pushed anywhere would be lost`);

  const go = await confirm(screen, {
    breadcrumb: crumb,
    message: `Remove "${project.name}"?`,
    detail: [
      fg(T.danger, S.warn) + ' ' + bold('This stops and removes its containers and named volumes, then deletes the folder.'),
      '',
      `${c.muted('folder')}      ${c.faint(project.dir)}`,
      `${c.muted('containers')}  ${c.faint(`${runningContainers} running, ${totalContainers} total`)}`,
      `${c.muted('volumes')}     ${volumes.length ? fg(T.danger, volumes.join(', ')) : c.faint('none named')}`,
      ...(warnings.length ? ['', ...warnings.map((w) => fg(T.danger, `${S.cross} ${w}`))] : []),
    ],
    danger: true,
    confirmLabel: 'Continue',
    cancelLabel: 'Keep it',
  });
  if (go !== true) return null;

  const typed = await input(screen, {
    breadcrumb: crumb,
    label: `Type "${project.name}" to confirm`,
    help: 'This cannot be undone.',
    validate: (t) => (t.trim() === project.name ? null : `Type ${project.name} exactly`),
  });
  if (typed === CANCEL) return null;

  // Stop and remove containers and volumes while the compose files are still
  // on disk, since compose needs them to know what to tear down. The folder is
  // only ever deleted after every stack has actually gone.
  const failures: string[] = [];
  for (const stack of project.stacks) {
    busy(screen, crumb, `stopping ${stack.projectName}`);
    const r = await docker.composeStream(stack, 'down --volumes --remove-orphans', {})
      .catch((e: any) => ({ code: 1, tail: [String(e?.message || e)] }));
    if (r.code !== 0) failures.push(`${stack.name}: ${(r.tail ?? []).slice(-3).join(' ') || 'failed'}`);
  }
  if (failures.length) {
    await notice(screen, {
      breadcrumb: crumb,
      tone: 'danger',
      title: 'Could not remove everything',
      message: 'Docker teardown failed for one or more stacks',
      detail: [...failures.map((f) => c.faint(f)), '', c.muted('Nothing on disk was touched. Resolve this and try again.')],
      action: 'Back',
    });
    return null;
  }

  busy(screen, crumb, 'removing generated files');
  for (const stack of project.stacks) await host.remove(overlayPath(cfg, project, stack));

  busy(screen, crumb, 'deleting the folder');
  await host.remove(project.dir);

  await notice(screen, {
    breadcrumb: crumb,
    tone: 'success',
    message: `"${project.name}" removed`,
    detail: [
      c.muted(`Stopped and removed ${totalContainers} container(s)${volumes.length ? ` and ${volumes.length} volume(s)` : ''}.`),
      c.faint(project.dir),
    ],
    action: 'Done',
  });
  return null;
}
