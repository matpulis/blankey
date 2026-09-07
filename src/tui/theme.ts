import { P } from '../ui/colors.js';

/**
 * Semantic names for the palette, so views ask for "what this means" rather
 * than "which colour", and a retheme is one edit.
 */
export const T = {
  brand: P.brand,
  brandAlt: P.brand2,
  accent: P.accent,

  text: P.text,
  muted: P.muted,
  faint: P.faint,
  ink: P.ink,

  ok: P.ok,
  warn: P.warn,
  danger: P.err,
  info: P.info,
  highlight: P.pink,

  /** Panel chrome. */
  border: '#2E3548',
  borderActive: P.brand,
  borderMuted: '#232838',
} as const;

export type ThemeColor = string;
