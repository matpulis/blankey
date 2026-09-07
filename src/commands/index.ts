import list from './list.js';
import status from './status.js';
import doctor from './doctor.js';
import traefik from './traefik.js';
import { info, urls } from './info.js';
import { deploy, pull, rollback, history } from './deploy.js';
import { checkout } from './checkout.js';
import { up, down, restart, stop, start, ps, logs, exec, run } from './lifecycle.js';
import { env, configCmd, completion } from './maintain.js';
import clean from './clean.js';
import backupCmd from './backup.js';
import { init, adopt, create } from './init.js';
import watch from './watch.js';
import autostart from './autostart.js';
import menu from './menu.js';
import type { CommandDef } from '../types.js';

export const commands: CommandDef[] = [
  menu,
  status,
  list,
  info,
  urls,
  watch,

  up,
  down,
  restart,
  stop,
  start,
  ps,
  logs,
  exec,
  run,

  deploy,
  pull,
  checkout,
  rollback,
  history,

  traefik,

  doctor,
  env,
  clean,
  backupCmd,
  configCmd,

  init,
  adopt,
  create,
  autostart,
  completion,
];

const index = new Map<string, CommandDef>();
for (const cmd of commands) {
  index.set(cmd.name, cmd);
  for (const alias of cmd.aliases || []) index.set(alias, cmd);
}

export function findCommand(name: string | undefined): CommandDef | null {
  return (name ? index.get(name) : null) || null;
}
