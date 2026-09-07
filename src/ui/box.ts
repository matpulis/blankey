import process from 'node:process';
import { BOX, S } from './symbols.js';
import { c, fg, gradient, P, pad, width, bold, truncate } from './colors.js';

export const termWidth = () => Math.min(process.stdout.columns || 100, 140);

/** Rounded panel with an optional gradient title. */
export function box(lines, { title = '', color = P.brand, padding = 1, width: w }: any = {}) {
  const inner = (w || termWidth()) - 2;
  const px = ' '.repeat(padding);
  const paint = (s) => fg(color, s);
  const head = title
    ? paint(BOX.tl + BOX.h) + ' ' + bold(gradient(title, [color, P.brand2])) + ' ' +
      paint(BOX.h.repeat(Math.max(0, inner - width(title) - 3)) + BOX.tr)
    : paint(BOX.tl + BOX.h.repeat(inner) + BOX.tr);
  // Long content is trimmed rather than allowed to break the border.
  const room = inner - padding * 2;
  const body = lines.map((l) => paint(BOX.v) + px + pad(truncate(l, room), room) + px + paint(BOX.v));
  const foot = paint(BOX.bl + BOX.h.repeat(inner) + BOX.br);
  return [head, ...body, foot].join('\n');
}

/** The wordmark shown on bare `blankey`. */
export function banner(subtitle = '') {
  const name = gradient('  b l a n k e y  ', [P.brand, P.pink, P.brand2]);
  const rule = fg(P.faint, S.line.repeat(Math.max(0, termWidth() - 2)));
  const sub = subtitle ? '  ' + c.muted(subtitle) : '';
  return `\n${bold(name)}${sub}\n${rule}`;
}

export function rule(label = '', color = P.faint) {
  const w = termWidth();
  if (!label) return fg(color, S.line.repeat(w));
  const text = ` ${label} `;
  const left = 2;
  const right = Math.max(0, w - left - width(text));
  return fg(color, S.line.repeat(left)) + bold(fg(P.muted, text)) + fg(color, S.line.repeat(right));
}

/** Horizontal meter, e.g. 3/4 containers up. */
export function meter(value, total, { size = 10, color = P.ok, empty = P.faint }: any = {}) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  const filled = Math.round(ratio * size);
  return fg(color, S.block.repeat(filled)) + fg(empty, S.shade.repeat(size - filled));
}

export function kv(pairs, { keyWidth }: any = {}) {
  const kw = keyWidth || Math.max(...pairs.map(([k]) => width(k)));
  return pairs.map(([k, v]) => c.muted(pad(k, kw)) + '  ' + v);
}

export const indent = (s, n = 2) =>
  String(s).split('\n').map((l) => ' '.repeat(n) + l).join('\n');

