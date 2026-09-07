import { notice, busy, type ScreenLike } from './widgets.js';
import { c } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { discover } from '../discover.js';
import type { Config, Project } from '../types.js';

/**
 * Scan for projects, or explain why there are none.
 *
 * Every screen that needs a project to work on hits the same two dead ends:
 * the projects directory does not exist, or it exists and holds nothing with a
 * compose file in it, and both need saying differently. Returning null once
 * the operator has acknowledged that keeps each caller to a single check.
 */
export async function scanProjects(
  screen: ScreenLike,
  cfg: Config,
  breadcrumb: string[],
  { detail = true }: { detail?: boolean } = {},
): Promise<{ projects: Project[] } | null> {
  busy(screen, breadcrumb, 'looking for projects');
  const { projects, missingRoot } = await discover(cfg);
  if (!missingRoot && projects.length) return { projects };

  await notice(screen, {
    breadcrumb,
    tone: 'warn',
    title: missingRoot ? 'Nothing to scan' : 'Nothing found',
    message: missingRoot ? 'The projects directory does not exist' : 'No projects found',
    detail: [
      c.faint(cfg.projectsDir),
      ...(detail
        ? [
          '',
          ...(missingRoot
            ? [
              c.muted('Create that folder, or point blankey somewhere else:'),
              c.faint(`Settings ${S.chevron} Edit settings ${S.chevron} Projects directory`),
            ]
            : [
              c.muted('A project is a folder inside that directory with a compose file in it.'),
              c.faint('docker-compose.yml, compose.yaml and named variants are all recognised.'),
            ]),
        ]
        : []),
    ],
    action: 'Back',
  });
  return null;
}
