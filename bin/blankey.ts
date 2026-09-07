#!/usr/bin/env node
import process from 'node:process';
import { main } from '../src/cli.js';
import { pendingCleanups, runCleanups } from '../src/cleanup.js';

let interrupted = false;
process.on('SIGINT', async () => {
  process.stdout.write('\x1b[?25h\n');
  // A second Ctrl+C means "stop trying", even if that leaves work half done.
  if (interrupted || !pendingCleanups()) process.exit(130);
  interrupted = true;
  process.stderr.write('interrupted, putting things back...\n');
  await runCleanups();
  process.exit(130);
});

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
} catch (error) {
  if (error && error.__handled) {
    process.exitCode = error.exitCode ?? 1;
  } else {
    const { c } = await import('../src/ui/colors.js');
    process.stderr.write(`\n${c.err('blankey crashed:')} ${error?.stack || error}\n\n`);
    process.exitCode = 1;
  }
  await runCleanups();
}
