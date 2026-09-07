// Truecolor-aware styling with graceful degradation (NO_COLOR / dumb terms / pipes).
import process from 'node:process';

const env = process.env;

function detectLevel() {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;
  if (env.BLANKEY_COLOR === 'always' || env.FORCE_COLOR === '3') return 3;
  if (env.FORCE_COLOR === '0') return 0;
  if (!process.stdout.isTTY && !env.FORCE_COLOR) return 0;
  if (env.TERM === 'dumb') return 0;
  const ct = (env.COLORTERM || '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return 3;
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'vscode' || env.WT_SESSION) return 3;
  if (/-256(color)?$/.test(env.TERM || '')) return 2;
  return 1;
}

export let level = detectLevel();
export const setLevel = (l: number): void => { level = l; };
export const enabled = () => level > 0;

const E = '\x1b[';
const wrap = (open: string | number, close: string | number, s: string): string => `${E}${open}m${s}${E}${close}m`;

// 24-bit -> 256 -> 16 downsampling so the palette survives on older terminals.
function to256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
}
function to16(r: number, g: number, b: number): number {
  const bright = Math.max(r, g, b) > 160 ? 60 : 0;
  const code = (r > 110 ? 1 : 0) | (g > 110 ? 2 : 0) | (b > 110 ? 4 : 0);
  return 30 + code + bright;
}

export function hex(h: string): [number, number, number] {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function fg(color: string | number[], s: string): string {
  if (!level) return s;
  const [r, g, b] = Array.isArray(color) ? color : hex(color);
  if (level >= 3) return wrap(`38;2;${r};${g};${b}`, 39, s);
  if (level === 2) return wrap(`38;5;${to256(r, g, b)}`, 39, s);
  return wrap(to16(r, g, b), 39, s);
}

export function bg(color: string | number[], s: string): string {
  if (!level) return s;
  const [r, g, b] = Array.isArray(color) ? color : hex(color);
  if (level >= 3) return wrap(`48;2;${r};${g};${b}`, 49, s);
  if (level === 2) return wrap(`48;5;${to256(r, g, b)}`, 49, s);
  return wrap(to16(r, g, b) + 10, 49, s);
}

export const bold = (s) => (level ? wrap(1, 22, s) : s);
export const dim = (s) => (level ? wrap(2, 22, s) : s);
export const italic = (s) => (level ? wrap(3, 23, s) : s);
export const underline = (s) => (level ? wrap(4, 24, s) : s);
export const inverse = (s) => (level ? wrap(7, 27, s) : s);

// The palette. Tuned to stay legible on both light and dark terminal backgrounds.
export const P = {
  brand: '#7C5CFF',
  brand2: '#22D3EE',
  accent: '#A78BFA',
  ok: '#34D399',
  warn: '#FBBF24',
  err: '#F87171',
  info: '#60A5FA',
  pink: '#F472B6',
  muted: '#8B93A7',
  faint: '#5A6172',
  text: '#E6E9F0',
  ink: '#0B0F1A',
};

export const c = {
  brand: (s) => fg(P.brand, s),
  accent: (s) => fg(P.accent, s),
  ok: (s) => fg(P.ok, s),
  warn: (s) => fg(P.warn, s),
  err: (s) => fg(P.err, s),
  info: (s) => fg(P.info, s),
  pink: (s) => fg(P.pink, s),
  muted: (s) => fg(P.muted, s),
  faint: (s) => fg(P.faint, s),
  bold,
  dim,
  italic,
  underline,
};

/** Linear interpolation across stops, applied per visible character. */
export function gradient(str: string, stops: Array<string | number[]> = [P.brand, P.pink, P.brand2]): string {
  if (!level) return str;
  const pts = stops.map((s) => (Array.isArray(s) ? s : hex(s)));
  const chars = [...str];
  const n = Math.max(chars.length - 1, 1);
  return chars
    .map((ch, i) => {
      if (ch === ' ') return ch;
      const t = (i / n) * (pts.length - 1);
      const idx = Math.min(Math.floor(t), pts.length - 2);
      const f = t - idx;
      const a = pts[idx];
      const b = pts[idx + 1];
      const rgb = [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f));
      return fg(rgb, ch);
    })
    .join('');
}

/** A filled pill/badge. Falls back to bracketed text without color. */
export function badge(text: string, color: string, { pad = 1 }: { pad?: number } = {}): string {
  const body = ' '.repeat(pad) + text + ' '.repeat(pad);
  if (!level) return `[${text}]`;
  return bg(color, fg(P.ink, bold(body)));
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const strip = (s: string): string => String(s).replace(ANSI_RE, '');

/** Display width, accounting for ANSI and wide/zero-width codepoints. */
export function width(s: string): number {
  const plain = strip(s);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) continue;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff)
    ) {
      w += 2;
    } else w += 1;
  }
  return w;
}

export function pad(s: string, len: number, align: string = 'left'): string {
  const gap = Math.max(0, len - width(s));
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') {
    const l = Math.floor(gap / 2);
    return ' '.repeat(l) + s + ' '.repeat(gap - l);
  }
  return s + ' '.repeat(gap);
}

/** Truncate to a display width, preserving ANSI sequences that are still open. */
export function truncate(s: string, max: number): string {
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  let i = 0;
  const str = String(s);
  while (i < str.length) {
    if (str[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const ch = String.fromCodePoint(str.codePointAt(i) ?? 0);
    const cw = width(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + (level ? `${E}0m` : '') + dim('…');
}
