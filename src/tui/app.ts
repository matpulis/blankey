import process from 'node:process';
import { Screen } from './screen.js';
import {
  menu, input, confirm, notice, pager, busy, CANCEL, checklist,
  style, bar, type ScreenLike, type MenuItem, type Cancelled,
} from './widgets.js';
import { settingsEditor, setupWizard, traefikSetupWizard, tilde } from './settings.js';
import { runInPane } from './runner.js';
import { routingEditor, offerRoutingBeforeDeploy } from './routing.js';
import { sslConfigsEditor } from './certs.js';
import { sshIdentitiesEditor } from './ssh-identities.js';
import { addProjectFlow, removeProjectFlow } from './projects.js';
import { T } from './theme.js';
import { c, fg, bold, gradient } from '../ui/colors.js';
import { elideMiddle } from '../ui/style.js';
import { S } from '../ui/symbols.js';
import { findCommand } from '../commands/index.js';
import { createContext } from '../context.js';
import { loadConfig } from '../config.js';
import { discover } from '../discover.js';
import { scanProjects } from './discovery.js';
import * as host from '../host.js';
import * as docker from '../docker.js';
import * as git from '../git.js';
import { stateDot } from '../ui/render.js';
import { relTime, pMap } from '../util.js';
import { readState } from '../state.js';
import type { Config, Project, Stack, Container, StackSummary } from '../types.js';

/**
 * The interactive program.
 *
 * Every entry dispatches into the same command objects the flag-driven CLI
 * uses: a direct in-process function call (see `findCommand` and
 * `runCommand` below), never a subprocess of blankey itself, so behaviour
 * cannot drift between the two. Most commands run this way with their output
 * captured and rendered into a scrolling panel right here (see runInPane),
 * so using a feature never feels like leaving the app. Only the handful of
 * things that genuinely need the real terminal, a shell or a followed log,
 * are marked `needsTerminal` and hand it over via Screen.suspend.
 */

export interface MenuAction {
  label: string;
  hint?: string;
  command?: string;
  action?: string;
  positional?: string[];
  flags?: Record<string, any>;
  needs?: 'stack';
  service?: boolean;
  prompt?: 'ref' | 'env';
  danger?: boolean;
  confirmFirst?: string;
  /** Offer to set up routing first when the stack has none. */
  offersRouting?: boolean;
  /** Disabled until the proxy has been scaffolded, since it would just error out. */
  requiresTraefik?: boolean;
  /** Removed from the menu entirely once the proxy is already scaffolded. */
  onlyBeforeScaffold?: boolean;
  /** Longer explanation shown in the detail pane. */
  about?: string;
  /**
   * Hand the real terminal over instead of rendering into a panel. Only for
   * things that read keys of their own: a shell, a followed log, a full-screen
   * view. Everything else stays inside the program.
   */
  needsTerminal?: boolean;
  /** Hold the screen after it finishes, so its output can actually be read. */
  pauseAfter?: boolean;
}

export interface MenuSeparator {
  separator: string;
}

export interface MenuGroup {
  id: string;
  label: string;
  hint: string;
  icon: string;
  items: Array<MenuAction | MenuSeparator>;
}

const isMenuSeparator = (item: MenuAction | MenuSeparator): item is MenuSeparator =>
  'separator' in item;

const MENU: MenuGroup[] = [
  {
    id: 'traefik',
    label: 'Traefik',
    hint: 'the edge proxy',
    icon: S.bullet,
    items: [
      { label: 'Scaffold the proxy', action: 'traefik-init', onlyBeforeScaffold: true, about: 'A short wizard for the network, image, dashboard host and Let\'s Encrypt account, then writes the compose file, static and dynamic config, ACME storage and the shared network.' },
      { separator: 'routing' },
      { label: 'Routing for a project', action: 'routing', about: 'Give a project a hostname. The labels are generated outside the repo, so the compose file in git stays clean.' },
      { label: 'Live routes', command: 'traefik', positional: ['routes'], requiresTraefik: true, about: 'What the proxy is actually serving right now, read from its API.' },
      { label: "Let's Encrypt certificates", command: 'traefik', positional: ['certs'], requiresTraefik: true, about: 'Certificates issued automatically, read from the ACME account.' },
      { label: 'SSL configurations', action: 'ssl-configs', about: 'Reusable certificate and key pairs (a Cloudflare origin certificate, for instance) that any route can use instead of automatic Let\'s Encrypt.' },
      { separator: 'the proxy container' },
      { label: 'Proxy status', command: 'traefik', positional: ['status'] },
      { label: 'Start the proxy', command: 'traefik', positional: ['up'], requiresTraefik: true },
      { label: 'Restart the proxy', command: 'traefik', positional: ['restart'], requiresTraefik: true },
      { label: 'Stop the proxy', command: 'traefik', positional: ['down'], requiresTraefik: true, danger: true, about: 'Every routed site goes offline until it is started again.' },
      { label: 'Proxy logs', command: 'traefik', positional: ['logs'], flags: { follow: true }, requiresTraefik: true, needsTerminal: true, about: 'Streams live until you press Ctrl+C.' },
      { separator: '' },
      { label: 'Traefik settings', action: 'traefik-settings', about: 'Proxy network, image, dashboard host and the Let\'s Encrypt account.' },
    ],
  },
  {
    id: 'deploy',
    label: 'Deployments',
    hint: 'update and release',
    icon: S.bullet,
    items: [
      { label: 'Pull and Deploy a project', command: 'deploy', needs: 'stack', offersRouting: true, about: 'Pulls the repo, then rebuilds, restarts and verifies. Reverts automatically if the health check fails.' },
      { label: 'Deploy a project', command: 'deploy', needs: 'stack', offersRouting: true, flags: { git: false }, about: 'Rebuilds and restarts from the working tree as it is, without pulling. Reverts automatically if the health check fails.' },
      { label: 'Deploy a specific commit', hint: 'one-shot', command: 'deploy', needs: 'stack', prompt: 'ref', about: 'Pick a commit, tag or branch: type it or browse the last 20. Deploys from it, then puts the repo back exactly as it was.' },
      { label: 'Update the repos', action: 'update-repos', about: 'Pick which repos to pull. Shows how many commits each is behind before you choose.' },
      { label: 'Deployment History', command: 'history', about: 'Recent deploys recorded on this host.' },
      { separator: '' },
      { label: 'Deployment Settings', action: 'deploy-settings', about: 'Git strategy, rollback on failure, health timeout, image pruning.' },
    ],
  },
  {
    id: 'projects',
    label: 'Manage Projects',
    hint: 'add and remove repos',
    icon: S.bullet,
    items: [
      { label: 'Add a project', action: 'add-project', about: 'Paste a git URL to clone. Over SSH, you\'ll confirm which saved identity to clone with.' },
      { label: 'Remove a project', action: 'remove-project', danger: true, about: 'Stops and removes its containers and volumes, then deletes the folder. Asks twice, because this cannot be undone.' },
    ],
  },
  {
    id: 'overview',
    label: 'Monitor',
    hint: 'what is running, and where',
    icon: S.bullet,
    items: [
      { label: 'Fleet status', hint: 'every stack', command: 'status', about: 'Containers, git drift, routes and the last deploy for every stack.' },
      { label: 'Live dashboard', hint: 'auto refresh', command: 'watch', needsTerminal: true, about: 'A full-screen view that refreshes itself. Press q to come back.' },
      { label: 'Projects and stacks', command: 'list', flags: { long: true }, about: 'Everything discovered: compose files, services, routes and which stack is the default.' },
      { label: 'Project details', command: 'info', needs: 'stack', about: 'One project in full: containers, git, routes, volumes and recent deploys.' },
      { label: 'Routes', command: 'urls', about: 'Every hostname served across all projects.' },
      { label: 'Check routes respond', command: 'urls', flags: { check: true }, about: 'Requests each URL from the Docker host and reports the status. Finds the site that is quietly 502ing.' },
    ],
  },
  {
    id: 'containers',
    label: 'Containers',
    hint: 'start, stop, inspect',
    icon: S.bullet,
    items: [
      { label: 'Containers by project', command: 'ps', about: 'Every container grouped under the repo that owns it.' },
      { label: 'Open a shell', command: 'exec', needsTerminal: true, about: 'Pick a container and drop into a shell. Exit the shell to come back.' },
      { label: 'Watch logs', hint: 'live', command: 'logs', needs: 'stack', service: true, needsTerminal: true, about: 'Streams live until you press Ctrl+C, which brings you back here.' },
      { label: 'Clear a log file', command: 'logs', needs: 'stack', service: true, flags: { clear: true }, danger: true, about: 'Empties the log file in place. The container keeps logging normally.' },
      { label: 'Start a stack', command: 'up', needs: 'stack', offersRouting: true },
      { label: 'Restart a stack', command: 'restart', needs: 'stack' },
      { label: 'Stop a stack', command: 'stop', needs: 'stack' },
      { label: 'Tear down a stack', command: 'down', needs: 'stack', danger: true, about: 'Stops and removes the containers. Volumes are kept.' },
    ],
  },
  {
    id: 'backups',
    label: 'Backups',
    hint: 'volumes to S3',
    icon: S.bullet,
    items: [
      { label: 'Back up everything', command: 'backup', flags: { all: true }, confirmFirst: 'Back up every project now?' },
      { label: 'Back up one project', command: 'backup', needs: 'stack' },
      { label: 'Preview a backup', hint: 'dry run', command: 'backup', flags: { all: true, dryRun: true } },
      { label: 'List backups', command: 'backup', positional: ['list'] },
      { label: 'Restore a backup', command: 'backup', positional: ['restore'], needs: 'stack', danger: true, about: 'Stops the stack, empties the volume and extracts the archive. The current contents are not saved first.' },
      { label: 'Apply retention now', command: 'backup', positional: ['prune'] },
      { label: 'Schedule backups', action: 'schedule-backup', about: 'Installs a systemd timer or a cron file. Re-running always replaces the existing job.' },
      { label: 'Schedule status', command: 'backup', positional: ['status'] },
      { label: 'Remove the schedule', command: 'backup', positional: ['unschedule'], danger: true },
      { label: 'Check the destination', command: 'backup', positional: ['check'], about: 'Verifies the bucket is reachable before you rely on it.' },
      { separator: '' },
      { label: 'Backup settings', action: 'backup-settings', about: 'Which storage provider, the bucket, credentials and how long backups are kept.' },
    ],
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    hint: 'health and housekeeping',
    icon: S.bullet,
    items: [
      { label: 'Run diagnostics', command: 'doctor', about: 'Checks the host, the proxy and every stack for problems.' },
      { label: 'Deep diagnostics', hint: 'slower', command: 'doctor', flags: { deep: true } },
      { label: 'Disk usage', command: 'clean', about: 'Measures what could be reclaimed. Changes nothing.' },
      { label: 'Clean up safely', command: 'clean', flags: { safe: true }, confirmFirst: 'Remove stopped containers, dangling images, cache, networks and logs?' },
      { label: 'Environment variables', command: 'env', needs: 'stack', about: 'Finds variables a stack needs but does not have.' },
      { label: 'Set a variable', command: 'env', needs: 'stack', prompt: 'env' },
      { label: 'Show configuration', command: 'config' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    hint: 'edit your configuration',
    icon: S.bullet,
    items: [
      { label: 'Projects & Docker host', action: 'core-settings', about: 'Where your repos live, and whether Docker is local or reached over SSH.' },
      { label: 'SSH identities', action: 'ssh-identities', about: 'Key pairs for cloning and pulling private repos: list them, generate a new one, or import one you already have.' },
      { separator: 'open on login' },
      { label: 'Open on login', command: 'autostart', positional: ['status'], about: 'Whether logging in over SSH drops straight into blankey, and where that is configured.' },
      { label: 'Turn on open-on-login', command: 'autostart', positional: ['enable'], confirmFirst: 'Open blankey automatically when you log in?', about: 'Adds a guarded block to your login file. You cannot lock yourself out: `ssh user@host bash` always bypasses it and gives you a plain shell.' },
      { label: 'Turn off open-on-login', command: 'autostart', positional: ['disable'], about: 'Puts the login file back the way it was.' },
      { separator: 'blankey itself' },
      {
        label: 'Update blankey',
        command: 'update',
        // The installer wants a real terminal, both for its own output and so
        // sudo has somewhere to ask for a password.
        needsTerminal: true,
        pauseAfter: true,
        confirmFirst: 'Check for a newer blankey, and install it if one is out?',
        about: 'Asks the release feed for the newest version. If there is one, it re-runs the installer pinned to that release. Your projects, containers and configuration are not touched.',
      },
      { separator: '' },
      { label: 'All settings', action: 'settings', about: 'Every option, including Traefik and Backups, in one place. Nothing is written until you save.' },
      { label: 'Run setup again', action: 'setup' },
      { label: 'Where config comes from', action: 'config-path' },
    ],
  },
];

/** A cheap snapshot of the host, shared by every detail pane. */
interface Snapshot {
  projects: Project[];
  containers: Container[];
  traefikUp: boolean;
  /** The proxy has a compose file on disk, so actions that need it stay enabled. */
  traefikScaffolded: boolean;
  lastDeploy: { at: string; project: string } | null;
  error?: string;
}

async function takeSnapshot(cfg: Config): Promise<Snapshot> {
  try {
    const [scan, containers, traefik, scaffolded, state] = await Promise.all([
      discover(cfg),
      docker.listAllContainers().catch(() => [] as Container[]),
      host.exec('docker ps --filter label=blankey.role=traefik --format "{{.Names}}"', { timeout: 10000 })
        .then((r) => r.code === 0 && Boolean(r.stdout.trim()))
        .catch(() => false),
      host.exists(host.join(cfg.traefik.dir, 'docker-compose.yml')).catch(() => false),
      readState(cfg).catch(() => ({ deploys: [] as any[] })),
    ]);
    const latest = (state as any).deploys?.[0];
    return {
      projects: scan.projects,
      containers,
      traefikUp: traefik,
      traefikScaffolded: scaffolded,
      lastDeploy: latest ? { at: latest.at, project: latest.project } : null,
    };
  } catch (e: any) {
    return { projects: [], containers: [], traefikUp: false, traefikScaffolded: false, lastDeploy: null, error: e?.message };
  }
}

const summarise = (snapshot: Snapshot, stack: Stack): StackSummary =>
  docker.summarizeStack(snapshot.containers, stack);

/** The panel beside the main menu: a live read of the fleet. */
function overviewPane(cfg: Config, snapshot: Snapshot, groupId: string): string[] {
  if (snapshot.error) return [fg(T.danger, `${S.cross} ${snapshot.error}`)];

  const rows = snapshot.projects.flatMap((p) => p.stacks.map((s) => ({ p, s, sum: summarise(snapshot, s) })));
  const running = rows.filter((r) => r.sum.state === 'running').length;
  const degraded = rows.filter((r) => ['partial', 'unhealthy', 'restarting'].includes(r.sum.state)).length;
  const stopped = rows.filter((r) => r.sum.state === 'stopped').length;

  const header = [
    `${fg(T.ok, S.dot)} ${bold(String(running))} ${c.muted('running')}` +
    (degraded ? `   ${fg(T.warn, S.dot)} ${bold(String(degraded))} ${c.muted('degraded')}` : '') +
    (stopped ? `   ${fg(T.faint, S.ring)} ${bold(String(stopped))} ${c.muted('stopped')}` : ''),
    bar(running, Math.max(rows.length, 1), 28) + ` ${c.faint(`${running}/${rows.length} stacks`)}`,
    '',
  ];

  if (groupId === 'traefik') {
    return [
      snapshot.traefikUp
        ? `${fg(T.ok, S.dot)} ${bold('proxy running')}`
        : `${fg(T.danger, S.dot)} ${bold('proxy not running')}`,
      '',
      `${c.muted('network')}   ${c.faint(cfg.traefik.network)}`,
      `${c.muted('dashboard')} ${c.faint(cfg.traefik.dashboardHost || 'not configured')}`,
      `${c.muted('acme')}      ${c.faint(cfg.traefik.acme.email || 'disabled')}`,
      '',
      `${c.muted('routes declared')} ${bold(String(snapshot.projects.flatMap((p) => p.stacks.flatMap((s) => s.routes)).length))}`,
    ];
  }

  if (groupId === 'backups') {
    const configured = Boolean(cfg.backup.s3.bucket && cfg.backup.s3.endpoint);
    const volumes = snapshot.projects.flatMap((p) => p.stacks.flatMap((s) => s.volumes)).length;
    return [
      configured
        ? `${fg(T.ok, S.tick)} ${bold(cfg.backup.s3.bucket)}`
        : `${fg(T.warn, S.warn)} ${bold('not configured yet')}`,
      '',
      `${c.muted('endpoint')}  ${c.faint(cfg.backup.s3.endpoint || 'unset')}`,
      `${c.muted('retention')} ${c.faint(`${cfg.backup.retentionDays} days`)}`,
      `${c.muted('volumes')}   ${c.faint(`${volumes} named across all stacks`)}`,
      '',
      c.faint(configured ? 'Schedule status shows whether a job is armed.' : 'Settings can fill in the bucket and region.'),
    ];
  }

  const list = rows.slice(0, 10).map(({ p, s, sum }) => {
    const name = p.stacks.length > 1 ? `${p.name}:${s.name}` : p.name;
    const url = s.routes.flatMap((r) => r.urls)[0];
    return `${stateDot(sum.state)} ${c.muted(name.padEnd(18).slice(0, 18))} ${c.faint(`${sum.running}/${sum.total || s.services.length}`)}` +
      (url ? `  ${fg(T.info, url.replace(/^https?:\/\//, ''))}` : '');
  });

  return [
    ...header,
    ...(list.length ? list : [c.faint('No projects discovered yet.')]),
    ...(rows.length > 10 ? ['', c.faint(`+${rows.length - 10} more`)] : []),
    '',
    snapshot.traefikUp ? `${fg(T.ok, S.globe)} ${c.muted('traefik up')}` : `${fg(T.faint, S.globe)} ${c.faint('traefik down')}`,
    ...(snapshot.lastDeploy
      ? [`${c.faint(`last deploy ${snapshot.lastDeploy.project} ${relTime(snapshot.lastDeploy.at)} ago`)}`]
      : []),
  ];
}

export async function runApp({ cfg: initialCfg, screen: injected }: { cfg?: Config | null; screen?: any } = {}): Promise<number> {
  const screen: any = injected || new Screen();
  let cfg = initialCfg as Config | null;

  // Every child process inherits this, so a shell opened from inside blankey
  // does not trip the login snippet and launch blankey inside blankey.
  process.env.BLANKEY_ACTIVE = '1';

  screen.start();

  try {
    if (!cfg) {
      const result = await setupWizard(screen, { cfg: null });
      if (!result.saved) {
        screen.stop();
        process.stdout.write(`\n${c.muted('Nothing was set up. Run')} ${bold('blankey init')} ${c.muted('or')} ${bold('blankey')} ${c.muted('again when ready.')}\n\n`);
        return 0;
      }
      cfg = await loadConfig({ file: result.path });
      if (cfg?.ssh?.host) host.useRemote(cfg.ssh);
      await welcome(screen, cfg as Config, result.path as string);
    }

    let snapshot = await withBusy(screen, [], 'reading the fleet', () => takeSnapshot(cfg!));

    for (;;) {
      const picked = await mainMenu(screen, cfg!, snapshot);
      if (picked === CANCEL || picked === '__quit') break;
      if (picked === '__refresh') {
        snapshot = await withBusy(screen, [], 'refreshing', () => takeSnapshot(cfg!));
        continue;
      }

      const group = MENU.find((g) => g.id === picked);
      if (!group) continue;

      const outcome = await groupMenu(screen, cfg!, group, snapshot);
      if (outcome?.reloadConfig) {
        const reloaded = await loadConfig({ file: outcome.reloadConfig });
        if (reloaded) {
          cfg = reloaded as Config;
          if (cfg.ssh?.host) host.useRemote(cfg.ssh);
        }
      }
      // Anything run from a group may have changed the world.
      snapshot = await withBusy(screen, [], 'refreshing', () => takeSnapshot(cfg!));
    }
  } finally {
    screen.stop();
  }
  process.stdout.write(`\n  ${gradient('blankey')} ${c.faint('see you')}\n\n`);
  return 0;
}

async function withBusy<T>(screen: ScreenLike, breadcrumb: string[], message: string, fn: () => Promise<T>): Promise<T> {
  busy(screen, breadcrumb, message);
  return fn();
}

async function welcome(screen: ScreenLike, cfg: Config, path: string): Promise<void> {
  const backups = cfg.backup.s3.bucket
    ? `${c.muted('Backups')}   ${bold(cfg.backup.s3.bucket)}`
    : `${c.muted('Backups')}   ${c.faint('not set up yet')}`;

  await notice(screen, {
    breadcrumb: ['Setup'],
    title: 'Ready',
    tone: 'success',
    message: 'blankey is configured',
    detail: [
      `${c.muted('Config')}    ${c.faint(elideMiddle(tilde(path), 52))}`,
      `${c.muted('Projects')}  ${bold(cfg.projectsDir)}`,
      `${c.muted('Docker')}    ${bold(cfg.ssh?.host || 'local')}`,
      backups,
      '',
      c.muted('From here: Traefik to scaffold the proxy, or Monitor to see what is already running.'),
      c.faint('Settings changes any of this later.'),
    ],
    action: 'Open the menu',
  });
}

function metaLine(cfg: Config, snapshot: Snapshot): string {
  const where = cfg.ssh?.host || 'local docker';
  return `${cfg.projectsDir}   ${S.bullet}   ${where}   ${S.bullet}   ${snapshot.containers.length} containers`;
}

async function mainMenu(screen: ScreenLike, cfg: Config, snapshot: Snapshot): Promise<string | Cancelled> {
  const items: MenuItem<string>[] = MENU.map((group) => ({
    label: `${group.icon}  ${group.label}`,
    hint: group.hint,
    value: group.id,
    keywords: group.items.filter((i): i is MenuAction => !isMenuSeparator(i)).map((i) => i.label).join(' '),
    detail: () => overviewPane(cfg, snapshot, group.id),
  }));
  items.push({ separator: '' });
  items.push({ label: 'Quit', hint: 'q', value: '__quit', detail: () => [c.faint('Leave blankey.')] });

  return menu<string>(screen, {
    items,
    title: 'Menu',
    meta: metaLine(cfg, snapshot),
    detailTitle: 'At a glance',
    shortcuts: { q: '__quit', r: '__refresh' },
    footer: [
      [`${S.up}${S.down}`, 'move'], ['enter', 'open'], ['type', 'search'],
      ['r', 'refresh'], ['q', 'quit'],
    ],
  });
}

function blockedDetail(item: MenuAction): string[] {
  return [
    bold(item.label),
    '',
    fg(T.warn, `${S.warn} The proxy has not been scaffolded yet.`),
    '',
    c.muted('Choose "Scaffold the proxy" first. It walks through the network, image, dashboard host and Let\'s Encrypt account, then writes everything this needs.'),
  ];
}

function actionDetail(item: MenuAction, cfg: Config): string[] {
  const lines: string[] = [];
  lines.push(bold(item.label));
  if (item.about) { lines.push(''); lines.push(c.muted(item.about)); }

  // Deliberately no "blankey <command>" readout here: every menu item calls
  // the same in-process function directly, there is no separate command to
  // name, and showing one only read as if there were.
  if (item.needs === 'stack') {
    lines.push('');
    lines.push(c.faint('You will be asked which project.'));
  }
  if (item.danger) {
    lines.push('');
    lines.push(fg(T.warn, `${S.warn} This changes running services.`));
  }
  return lines;
}

async function groupMenu(
  screen: ScreenLike,
  cfg: Config,
  group: MenuGroup,
  snapshot: Snapshot,
): Promise<{ reloadConfig?: string } | null> {
  let index = 0;
  for (;;) {
    // A first-run-only item (currently just "Scaffold the proxy") is dropped
    // outright once done, rather than left disabled, since there is nothing left
    // to explain about it, so it should not take up space in the list.
    const visible = group.items.filter((item) =>
      isMenuSeparator(item) || !(item.onlyBeforeScaffold && snapshot.traefikScaffolded));
    const items: MenuItem<MenuAction>[] = visible.map((item) => {
      if (isMenuSeparator(item)) return { separator: item.separator };
      const blocked = Boolean(item.requiresTraefik) && !snapshot.traefikScaffolded;
      return {
        label: item.label,
        hint: blocked ? 'needs setup' : (item.hint ?? ''),
        value: item,
        disabled: blocked,
        badge: item.danger ? fg(T.warn, S.warn) : '',
        detail: () => (blocked ? blockedDetail(item) : actionDetail(item, cfg)),
      };
    });

    const picked = await menu<MenuAction>(screen, {
      breadcrumb: [group.label],
      items,
      initial: index,
      title: group.label,
      meta: metaLine(cfg, snapshot),
      detailTitle: 'What this does',
      footer: [[`${S.up}${S.down}`, 'move'], ['enter', 'run'], ['type', 'search'], ['esc', 'back']],
    });
    if (picked === CANCEL) return null;
    index = items.findIndex((it) => it.value === picked);

    const outcome = await runItem(screen, cfg, group, picked as MenuAction, snapshot);
    if (outcome?.reloadConfig) return outcome;
  }
}

async function runItem(
  screen: ScreenLike,
  cfg: Config,
  group: MenuGroup,
  item: MenuAction,
  snapshot: Snapshot,
): Promise<{ reloadConfig?: string } | null> {
  const breadcrumb = [group.label, item.label];
  if (item.action) return runAction(screen, cfg, breadcrumb, item.action, snapshot);

  const positional = [...(item.positional ?? [])];
  const flags: Record<string, any> = { ...(item.flags ?? {}) };

  let routingChanged: string | undefined;
  let target: StackTarget | null = null;
  if (item.needs === 'stack') {
    const picked = await pickStack(screen, cfg, breadcrumb);
    if (picked === CANCEL || !picked) return null;
    target = picked;
    positional.push(target.spec);

    if (item.offersRouting) {
      const routing = await offerRoutingBeforeDeploy(screen, {
        cfg, project: target.project, stack: target.stack,
      });
      // Saved routing changes the config, so the run below must use the new one.
      if (routing.saved && routing.path) routingChanged = routing.path;
    }
    if (item.service) {
      const service = await pickService(screen, breadcrumb, target.stack);
      if (service === CANCEL) return null;
      if (service) positional.push(service as string);
    }
  }

  if (item.prompt === 'ref') {
    const ref = await pickCommitRef(screen, breadcrumb, target?.stack.dir);
    if (ref === CANCEL || ref === null) return null;
    flags.at = ref;
  }

  if (item.prompt === 'env') {
    const key = await input(screen, {
      breadcrumb, label: 'Variable name', placeholder: 'SENTRY_DSN',
      validate: (t) => (t.trim() ? null : 'Enter a name'),
    });
    if (key === CANCEL) return null;
    const value = await input(screen, { breadcrumb, label: `Value for ${(key as string).trim()}`, mask: true });
    if (value === CANCEL) return null;
    flags.set = `${(key as string).trim()}=${value}`;
  }

  const question = item.confirmFirst
    || (item.danger ? `${item.label}${positional.length ? ': ' + positional[positional.length - 1] : ''}?` : null);
  if (question) {
    const ok = await confirm(screen, {
      breadcrumb,
      message: question,
      detail: item.about ? [c.muted(item.about)] : [],
      danger: Boolean(item.danger),
      confirmLabel: 'Run it',
      cancelLabel: 'Cancel',
      def: !item.danger,
    });
    if (ok !== true) return null;
  }

  // Confirmed here, so the command must not ask again.
  flags.yes = true;

  // Routing was just written, so reload before running or the deploy would use
  // the configuration as it was when the menu opened.
  let active = cfg;
  if (routingChanged) {
    const reloaded = await loadConfig({ file: routingChanged });
    if (reloaded) active = reloaded as Config;
  }

  await runCommand(screen, active, item.command!, {
    positional,
    flags,
    title: item.label,
    breadcrumb,
    terminal: item.needsTerminal,
    pause: item.pauseAfter,
  });
  return routingChanged ? { reloadConfig: routingChanged } : null;
}

async function runAction(
  screen: ScreenLike,
  cfg: Config,
  breadcrumb: string[],
  action: string,
  snapshot: Snapshot,
): Promise<{ reloadConfig?: string } | null> {
  if (action === 'routing') {
    const target = await pickStack(screen, cfg, breadcrumb);
    if (target === CANCEL || !target) return null;
    const result = await routingEditor(screen, { cfg, project: target.project, stack: target.stack, breadcrumb });
    return result.saved ? { reloadConfig: result.path } : null;
  }
  if (action === 'update-repos') {
    return updateRepos(screen, cfg, breadcrumb);
  }
  if (action === 'ssl-configs') {
    await sslConfigsEditor(screen, { cfg, breadcrumb });
    return null;
  }
  if (action === 'ssh-identities') {
    await sshIdentitiesEditor(screen, { cfg, breadcrumb });
    return null;
  }
  if (action === 'add-project') {
    return addProjectFlow(screen, cfg, breadcrumb);
  }
  if (action === 'remove-project') {
    return removeProjectFlow(screen, cfg, breadcrumb);
  }
  if (action === 'traefik-init') {
    const result = await traefikSetupWizard(screen, { cfg });
    if (!result.saved || !result.path) return null;

    const reloaded = await loadConfig({ file: result.path });
    const active = (reloaded as Config) || cfg;
    if (active.ssh?.host) host.useRemote(active.ssh);

    // The settings were just confirmed, so this is meant to regenerate the
    // derived files (compose + static config) with them. Anything meant for
    // hand edits, such as the dashboard password, is never touched by force.
    await runCommand(screen, active, 'traefik', {
      positional: ['init'], flags: { yes: true, force: true },
      title: 'Scaffold the proxy', breadcrumb,
    });
    return { reloadConfig: result.path };
  }
  if (action === 'settings' || action === 'traefik-settings' || action === 'backup-settings'
    || action === 'deploy-settings' || action === 'core-settings') {
    const scope: Record<string, { sections: string[]; title: string }> = {
      'traefik-settings': { sections: ['Traefik'], title: 'Traefik settings' },
      'backup-settings': { sections: ['Backups'], title: 'Backup settings' },
      'deploy-settings': { sections: ['Deployments'], title: 'Deployment settings' },
      'core-settings': { sections: ['Projects', 'Docker host'], title: 'Projects & Docker host' },
    };
    const picked = scope[action];
    const result = await settingsEditor(screen, {
      cfg, breadcrumb, filePath: cfg.__file,
      sections: picked?.sections, title: picked?.title ?? 'All settings',
    });
    if (!result.saved || !result.path) return null;

    // "Scaffold the proxy", the only other place that regenerates the derived
    // files, disappears once scaffolded, so this is now the sole path back to
    // applying a changed network, image, dashboard host or ACME account to the
    // actual compose file on disk.
    if (action === 'traefik-settings' && snapshot.traefikScaffolded) {
      const reloaded = await loadConfig({ file: result.path });
      const active = (reloaded as Config) || cfg;
      if (active.ssh?.host) host.useRemote(active.ssh);

      const apply = await confirm(screen, {
        breadcrumb,
        message: 'Apply this to the running scaffold?',
        detail: [
          c.muted('The compose file and static config on disk still reflect the old settings until'),
          c.muted('they are regenerated. Files meant for hand edits are never touched.'),
        ],
        def: true,
      });
      if (apply === true) {
        await runCommand(screen, active, 'traefik', {
          positional: ['init'], flags: { yes: true, force: true },
          title: 'Apply Traefik settings', breadcrumb,
        });
      }
    }
    return { reloadConfig: result.path };
  }
  if (action === 'setup') {
    const result = await setupWizard(screen, { cfg });
    return result.saved ? { reloadConfig: result.path } : null;
  }
  if (action === 'config-path') {
    await pager(screen, {
      breadcrumb,
      title: 'Configuration',
      lines: [
        `${c.muted('loaded from')} ${bold(cfg.__file || 'defaults')}`,
        `${c.muted('projects')}    ${bold(cfg.projectsDir)}`,
        `${c.muted('docker host')} ${bold(cfg.ssh?.host || 'local')}`,
        `${c.muted('proxy net')}   ${bold(cfg.traefik.network)}`,
        `${c.muted('backups')}     ${bold(cfg.backup.s3.bucket || 'not configured')}`,
        '',
        c.faint(`Settings ${S.chevron} Edit settings changes any of this.`),
      ],
    });
    return null;
  }
  if (action === 'schedule-backup') {
    const when = await menu<string>(screen, {
      breadcrumb,
      title: 'How often',
      items: [
        { label: 'Every day', value: 'daily' },
        { label: 'Every week', hint: 'Mondays', value: 'weekly' },
        { label: 'Every hour', value: 'hourly' },
        { label: 'Remove the schedule', value: '__remove' },
      ],
      filterable: false,
      detailTitle: 'Scheduling',
      footer: [[`${S.up}${S.down}`, 'move'], ['enter', 'choose'], ['esc', 'back']],
    });
    if (when === CANCEL) return null;
    if (when === '__remove') {
      await runCommand(screen, cfg, 'backup', {
        positional: ['unschedule'], flags: { yes: true },
        title: 'Remove the schedule', breadcrumb,
      });
      return null;
    }
    let at = '03:00';
    if (when !== 'hourly') {
      const picked = await input(screen, {
        breadcrumb,
        label: 'Time of day',
        help: '24-hour clock, on the Docker host.',
        value: at,
        validate: (t) => (/^\d{1,2}:\d{2}$/.test(t.trim()) ? null : 'Use HH:MM'),
      });
      if (picked === CANCEL) return null;
      at = (picked as string).trim();
    }
    await runCommand(screen, cfg, 'backup', {
      positional: ['schedule', when as string], flags: { at, yes: true },
      title: 'Schedule backups', breadcrumb,
    });
    return null;
  }
  return null;
}

interface RunOptions {
  positional?: string[];
  flags?: Record<string, any>;
  title?: string;
  breadcrumb?: string[];
  /** Give the command the real terminal rather than a panel. */
  terminal?: boolean;
  /** Wait for a keypress before reclaiming the screen, so output can be read. */
  pause?: boolean;
}

/**
 * Run a command. By default its output is captured and drawn inside the
 * program, so nothing about the screen changes except the panel contents.
 * Commands that read keys of their own get the terminal instead.
 */
async function runCommand(
  screen: any,
  cfg: Config,
  name: string,
  { positional = [], flags = {}, title, breadcrumb = [], terminal = false, pause = false }: RunOptions = {},
): Promise<number | undefined> {
  const command = findCommand(name);
  if (!command) return 1;
  const ctx = createContext({ cfg, flags, positional, passthrough: [] });

  if (!terminal) {
    return runInPane(screen, {
      breadcrumb,
      title: title || name,
      meta: metaFor(cfg),
      run: () => command.run(ctx) as Promise<number | void>,
    });
  }

  // Self-terminating by nature (a shell exits, Ctrl+C stops a followed log), so
  // there is usually nothing to prompt about on the way back. An installer that
  // just printed why it failed is the exception, hence .
  return screen.suspend(async () => {
    try {
      return await command.run(ctx);
    } catch (e: any) {
      if (e && e.__handled) return e.exitCode ?? 1;
      process.stderr.write(`\n${c.err('That failed:')} ${e?.message || e}\n`);
      return 1;
    }
  }, { pause });
}

const metaFor = (cfg: Config): string => `${cfg.projectsDir}   ${S.bullet}   ${cfg.ssh?.host || 'local docker'}`;

// ------------------------------------------------------------------ pickers

interface StackTarget { spec: string; project: Project; stack: Stack }

async function pickStack(screen: ScreenLike, cfg: Config, breadcrumb: string[]): Promise<StackTarget | Cancelled | null> {
  const scan = await scanProjects(screen, cfg, breadcrumb);
  if (!scan) return CANCEL;
  const { projects } = scan;

  const containers = await docker.listAllContainers().catch(() => [] as Container[]);
  const snapshot: Snapshot = { projects, containers, traefikUp: false, traefikScaffolded: false, lastDeploy: null };
  const multi = projects.some((p) => p.stacks.length > 1);
  const items: MenuItem<StackTarget>[] = [];

  for (const project of projects) {
    if (multi) items.push({ separator: project.name });
    for (const stack of project.stacks) {
      const sum = summarise(snapshot, stack);
      items.push({
        label: multi ? stack.name : project.name,
        hint: `${sum.running}/${sum.total || stack.services.length}`,
        badge: stateDot(sum.state),
        keywords: `${project.name} ${stack.name}`,
        value: {
          spec: stack.name === project.defaultStack && !multi ? project.name : `${project.name}:${stack.name}`,
          project,
          stack,
        },
        detail: () => stackDetail(project, stack, sum),
      });
    }
  }

  const picked = await menu<StackTarget>(screen, {
    breadcrumb: [...breadcrumb, 'Project'],
    items,
    title: 'Projects',
    detailTitle: 'Stack',
  });
  return picked === CANCEL ? CANCEL : picked;
}

function stackDetail(project: Project, stack: Stack, sum: StackSummary): string[] {
  const lines = [
    bold(fg(T.brandAlt, project.name)) + (stack.name === 'default' ? '' : c.faint(':' + stack.name)),
    c.faint(stack.dir),
    '',
    `${stateDot(sum.state)} ${c.muted(sum.state)}   ${bar(sum.running, sum.total || 1, 14)} ${c.faint(`${sum.running}/${sum.total}`)}`,
    '',
    `${c.muted('compose')}  ${c.faint(stack.files.join(' + '))}`,
    `${c.muted('services')} ${c.faint(stack.services.map((s) => s.name).join(', ') || 'none')}`,
  ];
  if (stack.volumes.length) lines.push(`${c.muted('volumes')}  ${c.faint(stack.volumes.join(', '))}`);
  if (stack.routes.length) {
    lines.push('');
    for (const r of stack.routes.slice(0, 4)) {
      lines.push(`${fg(T.brandAlt, S.globe)} ${fg(T.info, r.urls[0] ?? r.rule)}`);
    }
  }
  if (!project.isGit) {
    lines.push('');
    lines.push(c.faint('Not a git repository, so deploys can only restart it.'));
  }
  return lines;
}

async function pickService(screen: ScreenLike, breadcrumb: string[], stack: Stack): Promise<string | Cancelled> {
  if (!stack.services.length) return '';
  if (stack.services.length === 1) return stack.services[0]!.name;
  const items: MenuItem<string>[] = [
    { label: 'All services', hint: 'interleaved', value: '' },
    { separator: 'services' },
    ...stack.services.map((s) => ({
      label: s.name,
      hint: s.image || (s.build ? 'built here' : ''),
      value: s.name,
      detail: () => [
        bold(s.name),
        '',
        `${c.muted('image')}   ${c.faint(s.image || '(built from source)')}`,
        `${c.muted('ports')}   ${c.faint(s.ports.join(', ') || 'none published')}`,
        `${c.muted('networks')} ${c.faint(s.networks.join(', ') || 'default')}`,
      ],
    })),
  ];
  return menu<string>(screen, {
    breadcrumb: [...breadcrumb, 'Service'],
    items,
    title: 'Services',
    detailTitle: 'Service',
  }) as Promise<string | Cancelled>;
}

/**
 * Choose a commit, tag or branch for a one-shot deploy: either type it, or
 * browse the last 20 commits and pick one. `dir` is missing only when the
 * caller has no repo yet, which should not happen since this only runs after
 * a stack has been picked. CANCEL is returned defensively either way.
 */
async function pickCommitRef(screen: ScreenLike, breadcrumb: string[], dir?: string): Promise<string | Cancelled | null> {
  if (!dir) return CANCEL;

  const mode = await menu<'pick' | 'type'>(screen, {
    breadcrumb,
    title: 'Which commit?',
    items: [
      { label: 'Pick from recent commits', hint: 'last 20', value: 'pick' },
      { label: 'Enter a commit, tag or branch', hint: 'type it', value: 'type' },
    ],
  });
  if (mode === CANCEL) return CANCEL;

  if (mode === 'type') {
    const ref = await input(screen, {
      breadcrumb,
      label: 'Commit, tag or branch',
      help: 'The repo is checked out there, deployed, then put back exactly as it was.',
      placeholder: 'v1.4.2',
      validate: (t) => (t.trim() ? null : 'Enter a commit, tag or branch'),
    });
    return ref === CANCEL ? CANCEL : (ref as string).trim();
  }

  busy(screen, breadcrumb, 'reading commits');
  const commits = await git.recentCommits(dir, 20);
  if (!commits.length) {
    await notice(screen, {
      breadcrumb, tone: 'warn', message: 'No commits found',
      detail: [c.faint(dir)], action: 'Back',
    });
    return CANCEL;
  }

  const picked = await menu<string>(screen, {
    breadcrumb: [...breadcrumb, 'Recent commits'],
    title: 'Recent commits',
    items: commits.map((cm) => ({
      label: `${cm.short}  ${cm.subject}`,
      hint: relTime(cm.date),
      value: cm.full,
      keywords: `${cm.author} ${cm.subject}`,
    })),
  });
  return picked === CANCEL ? CANCEL : picked;
}

/**
 * Pick which repos to pull: fetches each one first so the list can show how
 * many commits it is behind, then hands the chosen names to the real `pull`
 * command so the actual fetch, dirty-tree and no-remote handling stay in one
 * place instead of being duplicated here.
 */
async function updateRepos(
  screen: ScreenLike,
  cfg: Config,
  breadcrumb: string[],
): Promise<{ reloadConfig?: string } | null> {
  const scan = await scanProjects(screen, cfg, breadcrumb, { detail: false });
  if (!scan) return null;
  const { projects } = scan;

  busy(screen, breadcrumb, 'checking for incoming commits');
  const rows = await pMap(projects, async (p: Project) => {
    if (!p.isGit) return { project: p, hint: 'not a git repo', ahead: 0, ok: false };
    if (!p.autoUpdate) return { project: p, hint: 'updates off', ahead: 0, ok: false };
    if (!(await git.tracksRemote(p.dir))) return { project: p, hint: 'no remote', ahead: 0, ok: false };
    const fetched = await git.fetch(p.dir);
    if (!fetched.ok) return { project: p, hint: 'fetch failed', ahead: 0, ok: false };
    const ahead = await git.incoming(p.dir, 20);
    return { project: p, hint: ahead.length ? `${ahead.length} commit(s) behind` : 'up to date', ahead: ahead.length, ok: true };
  }, 4);

  const items = rows.map((r) => ({
    label: r.project.name,
    hint: r.hint,
    value: r.project.name,
    disabled: !r.ok,
    checked: r.ok && r.ahead > 0,
  }));

  const picked = await checklist(screen, {
    breadcrumb: [...breadcrumb, 'Repos'],
    title: 'Repos',
    items,
  });
  if (picked === CANCEL || !picked.length) return null;

  await runCommand(screen, cfg, 'pull', {
    positional: picked,
    flags: { yes: true },
    title: 'Update the repos',
    breadcrumb,
  });
  return null;
}

export { MENU };
