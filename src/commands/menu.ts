import process from 'node:process';
import { log } from '../ui/log.js';

export default {
  name: 'menu',
  aliases: ['ui'],
  group: 'Monitor',
  describe: 'Open the interactive menu (also what bare `blankey` does)',
  usage: 'menu',
  needsConfig: false,
  details:
    'Arrow keys move, enter selects, typing filters, esc goes back and q quits.\n' +
    'Every action runs right here, in-process, with its output rendered into a\n' +
    'scrolling panel. Nothing hands off to a separate blankey invocation. Only a\n' +
    'shell or a followed log takes over the terminal, since those genuinely need it.\n' +
    '\n' +
    'With no configuration yet, this walks through setting one up first.',
  async run(ctx) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      log.fail('The menu needs an interactive terminal.');
      log.hint('Use `blankey --help` to see the commands.');
      return 1;
    }
    const { runApp } = await import('../tui/app.js');
    return runApp({ cfg: ctx.cfg });
  },
};
