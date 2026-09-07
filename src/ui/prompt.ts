import process from 'node:process';
import readline from 'node:readline';
import { c, fg, P, bold } from './colors.js';
import { S } from './symbols.js';

const CTRL_C = '\x03';
const isTTY = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export async function ask(question, { def = '' }: any = {}) {
  if (!isTTY()) return def;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = def ? c.faint(` (${def})`) : '';
  const answer = await new Promise<string>((res) =>
    rl.question(`${c.brand(S.chevron)} ${bold(question)}${suffix} `, res),
  );
  rl.close();
  return answer.trim() || def;
}

export async function confirm(question, { def = false }: any = {}) {
  if (!isTTY()) return def;
  const hint = def ? c.faint('(Y/n)') : c.faint('(y/N)');
  const a = (await ask(`${question} ${hint}`, { def: '' })).toLowerCase();
  if (!a) return def;
  return a === 'y' || a === 'yes';
}

const ESC = '\x1b';

/**
 * Arrow-key single select.
 *
 * Entries are `{ label, value, hint }`, or `{ separator: 'text' }` for group
 * headings, which are drawn but skipped while moving. Long lists scroll inside a
 * fixed window so a fleet with fifty containers still fits on screen. Falls back
 * to a numbered prompt when raw mode is unavailable.
 */
export async function select(question, choices, { def = 0, pageSize }: any = {}) {
  const pickable = choices.map((ch, i) => i).filter((i) => !choices[i].separator);
  if (!pickable.length) return undefined;
  const firstPick = pickable.includes(def) ? def : pickable[0];

  if (!isTTY()) return choices[firstPick].value;

  if (!process.stdin.setRawMode) {
    const numbers = new Map();
    choices.forEach((ch, i) => {
      if (ch.separator) { process.stdout.write(`  ${c.muted(ch.separator)}\n`); return; }
      numbers.set(numbers.size + 1, i);
      process.stdout.write(`   ${c.muted(String(numbers.size))}. ${ch.label}${ch.hint ? c.faint('  ' + ch.hint) : ''}\n`);
    });
    const answer = await ask(question, { def: String([...numbers.keys()][0] ?? 1) });
    const target = numbers.get(Number(answer));
    return choices[target ?? firstPick]?.value;
  }

  const rows = process.stdout.rows || 24;
  const windowSize = Math.max(4, Math.min(pageSize || rows - 6, choices.length));
  let idx = firstPick;
  let offset = 0;
  let printed = 0;

  const move = (delta) => {
    const at = pickable.indexOf(idx);
    idx = pickable[(at + delta + pickable.length) % pickable.length];
    // Keep the cursor inside the visible window, headings included.
    if (idx < offset) offset = Math.max(0, idx - 1);
    if (idx >= offset + windowSize) offset = idx - windowSize + 1;
    offset = Math.max(0, Math.min(offset, choices.length - windowSize));
  };

  const render = () => {
    const out: any[] = [];
    out.push(`${c.brand(S.chevron)} ${bold(question)}`);
    const visible = choices.slice(offset, offset + windowSize);
    for (const [i, ch] of visible.entries()) {
      const real = offset + i;
      if (ch.separator) {
        out.push(`  ${c.faint(ch.separator)}`);
        continue;
      }
      const active = real === idx;
      const marker = active ? fg(P.brand, S.play) : ' ';
      const label = active ? bold(fg(P.brand2, ch.label)) : c.muted(ch.label);
      const hint = ch.hint ? c.faint('  ' + ch.hint) : '';
      out.push(`${marker} ${label}${hint}`);
    }
    const more = choices.length - windowSize;
    out.push(c.faint(
      more > 0
        ? `  ${S.arrow} ${offset + windowSize}/${choices.length}   enter to pick, esc to cancel`
        : '  enter to pick, esc to cancel',
    ));

    if (printed) process.stdout.write(`${ESC}[${printed}A`);
    process.stdout.write(`${ESC}[0J` + out.join('\n') + '\n');
    printed = out.length;
  };

  move(0);
  render();
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise((resolve) => {
    const cleanup = () => {
      process.stdin.off('data', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onKey = (buf) => {
      const k = buf.toString();
      if (k === CTRL_C) { cleanup(); process.exit(130); }
      if (k === ESC || k === 'q') { cleanup(); resolve(undefined); return; }
      if (k === `${ESC}[A` || k === 'k') { move(-1); render(); }
      else if (k === `${ESC}[B` || k === 'j') { move(1); render(); }
      else if (k === `${ESC}[5~`) { move(-windowSize); render(); }
      else if (k === `${ESC}[6~`) { move(windowSize); render(); }
      else if (k === '\r' || k === '\n') { cleanup(); resolve(choices[idx].value); }
    };
    process.stdin.on('data', onKey);
  });
}

export { isTTY };
