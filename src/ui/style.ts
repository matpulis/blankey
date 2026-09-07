import { fg, bg, bold as boldify, dim as dimify, italic as italicify, underline as underlineify, width, pad, strip, P } from './colors.js';
import { unicode } from './symbols.js';

/**
 * A small layout engine in the shape of Lipgloss: content is a block of lines,
 * blocks get borders, padding and alignment, and blocks compose horizontally or
 * vertically. Everything is ANSI- and wide-character-aware, so styled text and
 * emoji do not skew the geometry.
 *
 * Implemented here rather than taken as a dependency: the WASM port would have
 * to resolve at runtime on every server this runs on, and losing the
 * zero-runtime-dependency property matters more for something that opens when
 * you log in.
 */

export type Block = string[];
export type Content = string | string[];
export type Align = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'middle' | 'bottom';
export type Spacing = number | [number, number] | [number, number, number, number];

export interface BorderChars {
  top: string; bottom: string; left: string; right: string;
  topLeft: string; topRight: string; bottomLeft: string; bottomRight: string;
  middleLeft?: string; middleRight?: string; middle?: string;
  middleTop?: string; middleBottom?: string;
}

const UNI_BORDERS: Record<string, BorderChars> = {
  rounded: { top: '─', bottom: '─', left: '│', right: '│', topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯', middleLeft: '├', middleRight: '┤', middle: '┼', middleTop: '┬', middleBottom: '┴' },
  normal: { top: '─', bottom: '─', left: '│', right: '│', topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘', middleLeft: '├', middleRight: '┤', middle: '┼', middleTop: '┬', middleBottom: '┴' },
  thick: { top: '━', bottom: '━', left: '┃', right: '┃', topLeft: '┏', topRight: '┓', bottomLeft: '┗', bottomRight: '┛', middleLeft: '┣', middleRight: '┫', middle: '╋', middleTop: '┳', middleBottom: '┻' },
  double: { top: '═', bottom: '═', left: '║', right: '║', topLeft: '╔', topRight: '╗', bottomLeft: '╚', bottomRight: '╝', middleLeft: '╠', middleRight: '╣', middle: '╬', middleTop: '╦', middleBottom: '╩' },
  hidden: { top: ' ', bottom: ' ', left: ' ', right: ' ', topLeft: ' ', topRight: ' ', bottomLeft: ' ', bottomRight: ' ' },
};

const ASCII_BORDER: BorderChars = {
  top: '-', bottom: '-', left: '|', right: '|',
  topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+',
  middleLeft: '+', middleRight: '+', middle: '+', middleTop: '+', middleBottom: '+',
};

export type BorderName = keyof typeof UNI_BORDERS;

export function border(name: BorderName = 'rounded'): BorderChars {
  if (!unicode) return name === 'hidden' ? UNI_BORDERS.hidden! : ASCII_BORDER;
  return UNI_BORDERS[name] ?? UNI_BORDERS.rounded!;
}

export interface Sides { top: boolean; right: boolean; bottom: boolean; left: boolean }

export interface StyleOptions {
  width?: number;
  height?: number;
  maxWidth?: number;
  padding?: Spacing;
  margin?: Spacing;
  border?: BorderName | false;
  borderSides?: Partial<Sides>;
  borderColor?: string;
  /** Rendered into the top border, Lipgloss-style. */
  title?: string;
  titleColor?: string;
  /** Right-hand text in the top border, for counts and status. */
  tag?: string;
  align?: Align;
  valign?: VAlign;
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Wrap content that is wider than the block instead of clipping it. */
  wrap?: boolean;
}

/** [top, right, bottom, left] from any of the shorthand forms. */
export function expandSpacing(value: Spacing = 0): [number, number, number, number] {
  if (typeof value === 'number') return [value, value, value, value];
  if (value.length === 2) return [value[0], value[1], value[0], value[1]];
  return value;
}

export const toLines = (content: Content): Block =>
  (Array.isArray(content) ? content : String(content).split('\n'));

/** Widest visible line in a block. */
export const blockWidth = (block: Block): number =>
  block.reduce((max, line) => Math.max(max, width(line)), 0);

/**
 * Word wrap that measures visible width, so styled text wraps correctly.
 *
 * A token with no spaces in it, such as a path, a URL or a container id, cannot be
 * wrapped on a space, so it is hard-broken rather than allowed to run past the
 * edge of its panel.
 */
export function wrap(text: string, max: number): Block {
  if (max <= 0) return [text];
  const out: Block = [];

  const hardBreak = (token: string): string[] => {
    const pieces: string[] = [];
    let current = token;
    while (width(current) > max) {
      pieces.push(truncateHard(current, max));
      current = dropHard(current, max);
    }
    if (current) pieces.push(current);
    return pieces;
  };

  for (const paragraph of String(text).split('\n')) {
    if (width(paragraph) <= max) { out.push(paragraph); continue; }
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (width(word) > max) {
        if (line) { out.push(line); line = ''; }
        const pieces = hardBreak(word);
        out.push(...pieces.slice(0, -1));
        line = pieces[pieces.length - 1] ?? '';
        continue;
      }
      const candidate = line ? `${line} ${word}` : word;
      if (width(candidate) > max && line) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** First `max` visible columns of a string, keeping ANSI sequences intact. */
function truncateHard(s: string, max: number): string {
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length && w < max) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const ch = String.fromCodePoint(s.codePointAt(i) ?? 0);
    const cw = width(ch);
    if (w + cw > max) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out;
}

/** The remainder after `truncateHard`. */
function dropHard(s: string, max: number): string {
  let w = 0;
  let i = 0;
  while (i < s.length && w < max) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { i += m[0].length; continue; }
    }
    const ch = String.fromCodePoint(s.codePointAt(i) ?? 0);
    const cw = width(ch);
    if (w + cw > max) break;
    w += cw;
    i += ch.length;
  }
  return s.slice(i);
}

function alignLine(line: string, target: number, align: Align): string {
  const gap = Math.max(0, target - width(line));
  if (!gap) return line;
  if (align === 'right') return ' '.repeat(gap) + line;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + line + ' '.repeat(gap - left);
  }
  return line + ' '.repeat(gap);
}

/**
 * Render a block: pad it, align it, optionally frame it, and give every line
 * the same visible width so it can sit beside another block.
 */
export function style(content: Content, options: StyleOptions = {}): Block {
  const {
    padding = 0, margin = 0, align = 'left', valign = 'top',
    border: borderName, borderColor = P.faint, title, titleColor, tag,
    color, background, bold, dim, italic, underline, wrap: shouldWrap = true,
  } = options;

  const [padTop, padRight, padBottom, padLeft] = expandSpacing(padding);
  const [marginTop, marginRight, marginBottom, marginLeft] = expandSpacing(margin);
  const sides: Sides = { top: true, right: true, bottom: true, left: true, ...(options.borderSides || {}) };
  const chars = borderName === false || borderName === undefined ? null : border(borderName);
  const frameWidth = chars ? (sides.left ? 1 : 0) + (sides.right ? 1 : 0) : 0;

  let lines = toLines(content);

  // Decide the inner width: explicit, or the natural content width.
  let inner: number;
  if (options.width !== undefined) {
    inner = Math.max(0, options.width - frameWidth - padLeft - padRight - marginLeft - marginRight);
  } else {
    inner = blockWidth(lines);
    const ceiling = options.maxWidth;
    if (ceiling !== undefined) {
      inner = Math.min(inner, Math.max(0, ceiling - frameWidth - padLeft - padRight - marginLeft - marginRight));
    }
  }
  // A title needs room in the top border too.
  if (title && chars && sides.top) inner = Math.max(inner, width(title) + 4);
  if (tag && chars && sides.top) inner = Math.max(inner, width(title || '') + width(tag) + 7);

  if (shouldWrap) lines = lines.flatMap((line) => wrap(line, inner));

  // Text styling applies before geometry so widths stay honest.
  const paint = (s: string): string => {
    let out = s;
    if (bold) out = boldify(out);
    if (dim) out = dimify(out);
    if (italic) out = italicify(out);
    if (underline) out = underlineify(out);
    if (color) out = fg(color, out);
    return out;
  };

  let body = lines.map((line) => alignLine(paint(line), inner, align));

  if (options.height !== undefined) {
    const target = Math.max(0, options.height - padTop - padBottom - (chars ? (sides.top ? 1 : 0) + (sides.bottom ? 1 : 0) : 0));
    const missing = target - body.length;
    if (missing > 0) {
      const blank = ' '.repeat(inner);
      if (valign === 'bottom') body = [...Array(missing).fill(blank), ...body];
      else if (valign === 'middle') {
        const top = Math.floor(missing / 2);
        body = [...Array(top).fill(blank), ...body, ...Array(missing - top).fill(blank)];
      } else body = [...body, ...Array(missing).fill(blank)];
    } else if (missing < 0) {
      body = body.slice(0, target);
    }
  }

  // Padding, then background, so the fill covers the padded area.
  const padded = [
    ...Array(padTop).fill(' '.repeat(inner)),
    ...body,
    ...Array(padBottom).fill(' '.repeat(inner)),
  ].map((line) => ' '.repeat(padLeft) + line + ' '.repeat(padRight));

  const filled = background
    ? padded.map((line) => bg(background, line))
    : padded;

  const contentWidth = inner + padLeft + padRight;
  let framed: Block;

  if (chars) {
    const edge = (s: string) => fg(borderColor, s);
    framed = [];
    if (sides.top) framed.push(edge(topBorder(chars, contentWidth, sides, title, titleColor, tag)));
    for (const line of filled) {
      framed.push((sides.left ? edge(chars.left) : '') + line + (sides.right ? edge(chars.right) : ''));
    }
    if (sides.bottom) {
      framed.push(edge(
        (sides.left ? chars.bottomLeft : '') +
        chars.bottom.repeat(contentWidth) +
        (sides.right ? chars.bottomRight : ''),
      ));
    }
  } else {
    framed = filled;
  }

  const outerWidth = contentWidth + frameWidth;
  const withMargin = framed.map((line) => ' '.repeat(marginLeft) + line + ' '.repeat(marginRight));
  const blank = ' '.repeat(outerWidth + marginLeft + marginRight);
  return [
    ...Array(marginTop).fill(blank),
    ...withMargin,
    ...Array(marginBottom).fill(blank),
  ];
}

function topBorder(
  chars: BorderChars,
  contentWidth: number,
  sides: Sides,
  title?: string,
  titleColor?: string,
  tag?: string,
): string {
  const left = sides.left ? chars.topLeft : '';
  const right = sides.right ? chars.topRight : '';
  if (!title && !tag) return left + chars.top.repeat(contentWidth) + right;

  const labelled = title ? ` ${title} ` : '';
  const tagged = tag ? ` ${tag} ` : '';
  const used = width(labelled) + width(tagged);
  const fill = Math.max(0, contentWidth - used - 2);

  // Title on the left, tag on the right, rule filling the space between.
  return left
    + chars.top
    + (labelled ? (titleColor ? fg(titleColor, labelled) : labelled) : '')
    + chars.top.repeat(fill)
    + tagged
    + chars.top
    + right;
}

/** Put blocks side by side, padding the shorter ones to match. */
export function joinHorizontal(align: VAlign, ...blocks: Block[]): Block {
  const present = blocks.filter((b) => b && b.length);
  if (!present.length) return [];
  const height = Math.max(...present.map((b) => b.length));
  const widths = present.map(blockWidth);

  const padVertically = (block: Block, w: number): Block => {
    const blank = ' '.repeat(w);
    const missing = height - block.length;
    const filled = block.map((line) => line + ' '.repeat(Math.max(0, w - width(line))));
    if (missing <= 0) return filled;
    if (align === 'bottom') return [...Array(missing).fill(blank), ...filled];
    if (align === 'middle') {
      const top = Math.floor(missing / 2);
      return [...Array(top).fill(blank), ...filled, ...Array(missing - top).fill(blank)];
    }
    return [...filled, ...Array(missing).fill(blank)];
  };

  const columns = present.map((block, i) => padVertically(block, widths[i]!));
  const out: Block = [];
  for (let row = 0; row < height; row++) {
    out.push(columns.map((col) => col[row] ?? '').join(''));
  }
  return out;
}

/** Stack blocks, aligning them to a common width. */
export function joinVertical(align: Align, ...blocks: Block[]): Block {
  const present = blocks.filter((b) => b && b.length);
  if (!present.length) return [];
  const target = Math.max(...present.map(blockWidth));
  return present.flatMap((block) => block.map((line) => alignLine(line, target, align)));
}

/** Position a block inside a region of a given size. */
export function place(
  regionWidth: number,
  regionHeight: number,
  block: Block,
  { align = 'left', valign = 'top' }: { align?: Align; valign?: VAlign } = {},
): Block {
  const horizontal = block.map((line) => alignLine(line, regionWidth, align));
  const missing = regionHeight - horizontal.length;
  if (missing <= 0) return horizontal.slice(0, Math.max(0, regionHeight));
  const blank = ' '.repeat(regionWidth);
  if (valign === 'bottom') return [...Array(missing).fill(blank), ...horizontal];
  if (valign === 'middle') {
    const top = Math.floor(missing / 2);
    return [...Array(top).fill(blank), ...horizontal, ...Array(missing - top).fill(blank)];
  }
  return [...horizontal, ...Array(missing).fill(blank)];
}

/**
 * Shorten from the middle, keeping both ends. Paths and URLs are far more
 * useful this way than truncated from the right, where the filename is lost.
 */
export function elideMiddle(text: string, max: number): string {
  if (max <= 3 || width(text) <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return text.slice(0, head) + '…' + text.slice(text.length - tail);
}

/** A horizontal rule, optionally with a label sitting in it. */
export function rule(total: number, label = '', color = P.faint, chars = border('normal')): string {
  if (!label) return fg(color, chars.top.repeat(Math.max(0, total)));
  const text = ` ${label} `;
  const right = Math.max(0, total - 2 - width(text));
  return fg(color, chars.top.repeat(2)) + text + fg(color, chars.top.repeat(right));
}

/** A proportional bar, for meters and gauges. */
export function bar(value: number, total: number, size: number, filledColor = P.ok, emptyColor = P.faint): string {
  const ratio = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  const filled = Math.round(ratio * size);
  const full = unicode ? '█' : '#';
  const empty = unicode ? '░' : '.';
  return fg(filledColor, full.repeat(filled)) + fg(emptyColor, empty.repeat(size - filled));
}

/** Sparkline from a series of numbers, for trends in a small space. */
export function sparkline(values: number[], color = P.info): string {
  if (!values.length) return '';
  const ramp = unicode ? ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] : ['_', '.', '-', '=', '+', '*', '#', '@'];
  const max = Math.max(...values, 1);
  return fg(color, values.map((v) => {
    const idx = Math.min(ramp.length - 1, Math.round((v / max) * (ramp.length - 1)));
    return ramp[idx]!;
  }).join(''));
}

export { width, pad, strip, fg, bg, P };
