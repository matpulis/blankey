import { c, fg, width, strip } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { setSink } from '../ui/output.js';
import { style } from '../ui/style.js';
import { chrome, indented, type ScreenLike } from './widgets.js';
import { T } from './theme.js';
import { isQuit } from './keys.js';
import { duration } from '../util.js';

/**
 * Run a command with its output rendered inside the program.
 *
 * The alternative, handing the terminal over and taking it back, makes every
 * action feel like leaving and re-entering the app. Commands already write
 * through `log` and `Spinner`, so their output can be captured and drawn into a
 * panel that scrolls, with the spinner reduced to a live status line.
 *
 * Commands that genuinely need the terminal (a shell, a followed log) still get
 * it; see `needsTerminal` in the menu.
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['|', '/', '-', String.fromCharCode(92)];

export interface PaneOptions {
  breadcrumb?: string[];
  title: string;
  meta?: string;
  run: () => Promise<number | void | undefined>;
}

export async function runInPane(
  screen: ScreenLike,
  { breadcrumb = [], title, meta = '', run }: PaneOptions,
): Promise<number | undefined> {
  const lines: string[] = [];
  let status = '';
  let partial = '';
  let follow = true;
  let offset = 0;

  const push = (text: string) => {
    // Commands emit whole lines; anything without a newline is held back until
    // the rest of it arrives.
    partial += text;
    const parts = partial.split('\n');
    partial = parts.pop() ?? '';
    for (const line of parts) lines.push(line);
  };

  setSink((text, stream) => {
    if (stream === 'status') { status = text; return; }
    push(text);
  });

  const room = () => Math.max(3, screen.rows - 11);
  const frames = width('⠋') === 1 ? FRAMES : ASCII_FRAMES;
  let tick = 0;
  let done = false;
  let code: number | undefined;
  const started = Date.now();

  const render = () => {
    const height = room();
    const total = lines.length;
    if (follow) offset = Math.max(0, total - height);
    offset = Math.max(0, Math.min(offset, Math.max(0, total - height)));

    const body = lines.slice(offset, offset + height);
    const spinner = frames[tick % frames.length]!;
    const elapsed = Date.now() - started;

    const tag = done
      ? (code ? fg(T.danger, `${S.cross} exit ${code}`) : fg(T.ok, `${S.tick} done`)) +
        c.faint(`  ${duration(elapsed)}`)
      : fg(T.brand, spinner) + c.faint(`  ${duration(elapsed)}`);

    const panel = style(body.length ? body : [c.faint('waiting for output')], {
      width: screen.columns - 4,
      height: height + 2,
      border: 'rounded',
      borderColor: done ? (code ? T.danger : T.ok) : T.borderActive,
      title,
      titleColor: done ? (code ? T.danger : T.ok) : T.brandAlt,
      tag,
      padding: [0, 1],
      wrap: false,
      valign: 'top',
    });

    const scrolled = total > height;
    screen.draw(chrome(screen, {
      breadcrumb,
      meta,
      body: indented(panel),
      status: done
        ? (scrolled && !follow ? c.faint(`${offset + height}/${total}`) : '')
        : (status ? fg(T.brand, S.play) + ' ' + c.muted(strip(status).slice(0, screen.columns - 8)) : ''),
      footer: done
        ? [
          ...(scrolled ? [[`${S.up}${S.down}`, 'scroll'] as [string, string]] : []),
          ['enter', 'back'],
          ['esc', 'back'],
        ]
        : [['', c.faint('running')]],
    }));
  };

  const timer = setInterval(() => { tick++; render(); }, 90);
  render();

  try {
    const result = await run();
    code = typeof result === 'number' ? result : 0;
  } catch (e: any) {
    if (e && e.__handled) code = e.exitCode ?? 1;
    else {
      push(`\n${fg(T.danger, S.cross)} ${e?.message || String(e)}\n`);
      code = 1;
    }
  } finally {
    clearInterval(timer);
    setSink(null);
    if (partial) { lines.push(partial); partial = ''; }
    done = true;
    status = '';
  }

  // Trailing blank lines are noise once the run has finished.
  while (lines.length && !strip(lines[lines.length - 1]!).trim()) lines.pop();
  if (!lines.length) {
    lines.push(code ? fg(T.danger, `${S.cross} finished with exit code ${code}`) : c.muted(`${S.tick} finished with nothing to report`));
  }

  follow = false;
  offset = Math.max(0, lines.length - room());
  render();

  for (;;) {
    const k = await screen.readKey();
    if (isQuit(k) || k.name === 'escape' || k.name === 'enter') return code;
    const height = room();
    if (k.name === 'up') offset -= 1;
    else if (k.name === 'down') offset += 1;
    else if (k.name === 'pageup') offset -= height;
    else if (k.name === 'pagedown') offset += height;
    else if (k.name === 'home') offset = 0;
    else if (k.name === 'end') offset = Math.max(0, lines.length - height);
    else continue;
    render();
  }
}
