import process from 'node:process';
import { c, fg, P, strip } from './colors.js';
import { S, unicode } from './symbols.js';
import { emit, isCaptured } from './output.js';

const ASCII = [String.fromCharCode(124), String.fromCharCode(47), String.fromCharCode(45), String.fromCharCode(92)];
const FRAMES = unicode ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ASCII;
const HUES = [P.brand, P.accent, P.pink, P.brand2, P.info];

export class Spinner {
  text: string;
  stream: NodeJS.WriteStream;
  tty: boolean;
  i: number;
  timer: NodeJS.Timeout | null;
  startedAt: number;

  constructor(text = '', stream: any = process.stderr) {
    this.text = text;
    this.stream = stream;
    this.tty = Boolean(stream.isTTY);
    this.i = 0;
    this.timer = null;
    this.startedAt = 0;
  }

  start(text = this.text) {
    this.text = text;
    this.startedAt = Date.now();
    // Captured: no cursor tricks, just a status line the panel can show live.
    if (isCaptured()) { emit(text, 'status'); return this; }
    if (!this.tty) { this.stream.write(`${S.arrow} ${strip(text)}\n`); return this; }
    this.render();
    this.timer = setInterval(() => this.render(), 80);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  update(text: string) {
    this.text = text;
    if (isCaptured()) { emit(text, 'status'); return this; }
    if (!this.tty) this.stream.write(`  ${strip(text)}\n`);
    return this;
  }

  render() {
    const frame = FRAMES[this.i % FRAMES.length];
    const hue = HUES[Math.floor(this.i / 3) % HUES.length];
    this.i++;
    this.clearLine();
    this.stream.write(`${fg(hue, frame)} ${this.text}`);
  }

  clearLine() {
    if (this.tty) this.stream.write('\r\x1b[2K');
  }

  stop(symbol: string | null, text = this.text, color = P.muted) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ms = Date.now() - this.startedAt;
    const took = ms > 900 ? c.faint(` ${(ms / 1000).toFixed(1)}s`) : '';
    if (isCaptured()) {
      // Clear the transient status, then keep the outcome as a real line.
      emit('', 'status');
      if (symbol) emit(`${fg(color, symbol)} ${text}${took}\n`, 'out');
      return this;
    }
    this.clearLine();
    if (symbol) this.stream.write(`${fg(color, symbol)} ${text}${took}\n`);
    return this;
  }

  succeed(text) { return this.stop(S.tick, text ?? this.text, P.ok); }
  fail(text) { return this.stop(S.cross, text ?? this.text, P.err); }
  warn(text) { return this.stop(S.warn, text ?? this.text, P.warn); }
  info(text) { return this.stop(S.info, text ?? this.text, P.info); }
  skip(text) { return this.stop(S.ring, c.muted(text ?? this.text), P.faint); }
}

export const spin = (text) => new Spinner(text).start();

/** Inline progress bar for multi-project runs. */
export function progress(done, total, label = '', size = 24) {
  const ratio = total ? done / total : 0;
  const filled = Math.round(ratio * size);
  const bar = fg(P.brand, S.block.repeat(filled)) + fg(P.faint, S.shade.repeat(size - filled));
  const pct = String(Math.round(ratio * 100)).padStart(3);
  return `${bar} ${c.bold(pct + '%')} ${c.muted(`${done}/${total}`)} ${label}`;
}
