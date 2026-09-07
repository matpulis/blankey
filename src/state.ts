import * as host from './host.js';
import { log } from './ui/log.js';
import { pMap } from './util.js';
import * as git from './git.js';

/**
 * Deploy history lives next to the projects on the Docker host, so it survives
 * reinstalls of the CLI and is shared by everyone who deploys from that box.
 */
const MAX_ENTRIES = 200;

export function stateDir(cfg) {
  return host.join(cfg.projectsDir, '.blankey');
}
export function statePath(cfg) {
  return host.join(stateDir(cfg), 'deploys.json');
}

export async function readState(cfg) {
  const text = await host.readFile(statePath(cfg));
  if (!text) return { version: 1, deploys: [] };
  try {
    const parsed = JSON.parse(text);
    return { version: 1, deploys: [], ...parsed };
  } catch (e) {
    log.debug('deploy state unreadable: ' + e.message);
    return { version: 1, deploys: [] };
  }
}

export async function recordDeploy(cfg, entry) {
  const state = await readState(cfg);
  state.deploys.unshift({ at: new Date().toISOString(), ...entry });
  state.deploys = state.deploys.slice(0, MAX_ENTRIES);
  try {
    await host.writeFile(statePath(cfg), JSON.stringify(state, null, 2));
  } catch (e) {
    log.debug('could not persist deploy state: ' + e.message);
  }
  return state;
}

export async function historyFor(cfg, project, stack) {
  const state = await readState(cfg);
  return state.deploys.filter(
    (d) => (!project || d.project === project) && (!stack || d.stack === stack),
  );
}

/**
 * The commit the last successful deploy of this stack ran from, the target
 * `blankey rollback` aims at. One-shot deploys are skipped: they never moved the
 * tree, so their recorded commit is not a position to return to.
 */
export async function lastGoodSha(cfg, project, stack) {
  const entries = await historyFor(cfg, project, stack);
  const good = entries.find((d) => d.ok && d.fromSha && !d.ephemeral);
  return good ? good.fromSha : null;
}

/** The most recent successful deploy for a stack, whatever kind it was. */
export async function lastDeploy(cfg, project, stack) {
  const entries = await historyFor(cfg, project, stack);
  return entries.find((d) => d.ok) || null;
}

/**
 * Name the commits in a history listing, in place.
 *
 * Deploys recorded before subjects were stored have only a sha, which says
 * nothing about which commit it was. `dirFor` maps a project name to its repo,
 * and returning undefined (the project is gone, or is not a repo) simply
 * leaves that entry as it is. Commits that no longer exist do the same.
 */
export async function fillSubjects(
  entries: any[],
  dirFor: (project: string) => string | undefined,
): Promise<void> {
  const missing = entries.filter((d) => !d.subject && (d.deployedSha || d.toSha));
  if (!missing.length) return;

  await pMap(missing, async (entry: any) => {
    const dir = dirFor(entry.project);
    if (!dir) return;
    entry.subject = await git.subjectOf(dir, entry.deployedSha || entry.toSha);
  }, 4);
}
