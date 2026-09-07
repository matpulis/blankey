/**
 * Terminal key decoding.
 *
 * A single read can carry several keypresses (holding an arrow, or a paste), so
 * this turns one chunk into an ordered list of events rather than trying to
 * interpret the buffer as a single key.
 */

export interface Key {
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  char: string;
}

const ESC = '\x1b';

const CSI_NAMES = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'backtab',
};

const TILDE_NAMES = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
};

function key(name: string, extra: Partial<Key> = {}): Key {
  return { name, ctrl: false, alt: false, shift: false, char: '', ...extra };
}

/** Decode one chunk of stdin into key events. */
export function decodeKeys(input: Buffer | string): Key[] {
  const s = typeof input === 'string' ? input : input.toString('utf8');
  const keys: Key[] = [];
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (ch === ESC) {
      // CSI: ESC [ ... final, or SS3: ESC O letter (application cursor mode).
      const rest = s.slice(i);
      const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
      if (csi) {
        const [, params, final] = csi;
        if (final === '~') {
          const code = Number(params.split(';')[0]);
          keys.push(key(TILDE_NAMES[code] || 'unknown'));
        } else if (CSI_NAMES[final]) {
          // A modifier arrives as ESC [ 1 ; 5 A and friends.
          const mod = Number((params.split(';')[1] || '1')) - 1;
          keys.push(key(CSI_NAMES[final], {
            shift: Boolean(mod & 1),
            alt: Boolean(mod & 2),
            ctrl: Boolean(mod & 4),
          }));
        } else {
          keys.push(key('unknown'));
        }
        i += csi[0].length;
        continue;
      }
      const ss3 = /^\x1bO([A-Za-z])/.exec(rest);
      if (ss3 && CSI_NAMES[ss3[1]]) {
        keys.push(key(CSI_NAMES[ss3[1]]));
        i += ss3[0].length;
        continue;
      }
      // ESC followed by a character is alt+that; ESC alone is escape.
      if (i + 1 < s.length && s[i + 1] !== ESC) {
        const next = s[i + 1];
        if (next >= ' ') {
          keys.push(key('char', { char: next, alt: true }));
          i += 2;
          continue;
        }
      }
      keys.push(key('escape'));
      i += 1;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      keys.push(key('enter'));
      i += 1;
      continue;
    }
    if (ch === '\t') {
      keys.push(key('tab'));
      i += 1;
      continue;
    }
    if (ch === '\x7f' || ch === '\b') {
      keys.push(key('backspace'));
      i += 1;
      continue;
    }
    if (ch === '\x03') {
      keys.push(key('c', { ctrl: true, char: 'c' }));
      i += 1;
      continue;
    }
    if (ch === '\x04') {
      keys.push(key('d', { ctrl: true, char: 'd' }));
      i += 1;
      continue;
    }
    if (ch < ' ') {
      // Any other control character: report it as ctrl+letter.
      const letter = String.fromCharCode(ch.charCodeAt(0) + 96);
      keys.push(key(letter, { ctrl: true, char: letter }));
      i += 1;
      continue;
    }

    // Printable, taking whole codepoints so emoji and accents survive.
    const cp = String.fromCodePoint(s.codePointAt(i) ?? 0);
    keys.push(key(cp === ' ' ? 'space' : 'char', { char: cp }));
    i += cp.length;
  }

  return keys;
}

/** True when the key means "get me out of here". */
export const isQuit = (k: Key): boolean => (k.ctrl && (k.name === 'c' || k.name === 'd'));
