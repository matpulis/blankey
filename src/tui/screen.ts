import process from 'node:process';
import { decodeKeys } from './keys.js';
import type { Key } from './keys.js';

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const HOME = '\x1b[H';
const CLEAR_BELOW = '\x1b[0J';
// Erase from the cursor to the end of the current line.
const CLEAR_LINE = '\x1b[K';

/**
 * Owns the terminal for the interactive menu.
 *
 * Keys are buffered rather than delivered to whoever happens to be listening,
 * so a view can `await readKey()` without losing input typed while it was
 * rendering.
 *
 * `suspend` is the important one: existing commands write to stdout and some
 * hand the terminal to a child process (logs -f, a shell). Rather than
 * reimplementing them for the TUI, the screen steps aside completely, lets them
 * run against the real terminal, and takes it back afterwards.
 */
export class Screen {
  stdin: NodeJS.ReadStream & { setRawMode?: (v: boolean) => void };
  stdout: NodeJS.WriteStream & { rows?: number; columns?: number };
  queue: Key[];
  waiters: Array<(k: Key) => void>;
  open: boolean;
  resized = false;
  resizeHandler: (() => void) | undefined;
  onData: (buf: Buffer | string) => void;
  onResize: () => void;

  constructor(stdin: any = process.stdin, stdout: any = process.stdout) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.queue = [];
    this.waiters = [];
    this.open = false;
    this.onData = (buf) => {
      for (const k of decodeKeys(buf)) this.push(k);
    };
    this.onResize = () => { this.resized = true; this.resizeHandler?.(); };
  }

  get rows() { return this.stdout.rows || 24; }
  get columns() { return Math.min(this.stdout.columns || 80, 160); }

  start(): this {
    if (this.open) return this;
    this.open = true;
    this.stdout.write(ALT_ON + HIDE_CURSOR);
    this.attach();
    this.stdout.on('resize', this.onResize);
    return this;
  }

  stop(): this {
    if (!this.open) return this;
    this.open = false;
    this.detach();
    this.stdout.off('resize', this.onResize);
    this.stdout.write(SHOW_CURSOR + ALT_OFF);
    return this;
  }

  attach(): void {
    if (this.stdin.setRawMode) this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.on('data', this.onData);
  }

  detach(): void {
    this.stdin.off('data', this.onData);
    if (this.stdin.setRawMode) this.stdin.setRawMode(false);
    this.stdin.pause();
  }

  push(k: Key): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(k);
    else this.queue.push(k);
  }

  /** Next keypress. Resolves immediately if one was typed ahead. */
  readKey(): Promise<Key> {
    if (this.queue.length) return Promise.resolve(this.queue.shift() as Key);
    return new Promise<Key>((resolve) => this.waiters.push(resolve));
  }

  /** Throw away anything typed while a long operation was running. */
  flush(): void {
    this.queue.length = 0;
  }

  /**
   * Paint a whole frame.
   *
   * Every line is followed by an erase-to-end-of-line, because a new line that
   * is shorter than the one it replaces would otherwise leave the tail of the
   * old text visible to its right. Clearing per line rather than clearing the
   * whole screen first avoids the flicker a full erase causes.
   */
  draw(lines: string[] | string): void {
    const rows = Array.isArray(lines) ? lines : String(lines).split('\n');
    const text = rows.map((line) => line + CLEAR_LINE).join('\n');
    this.stdout.write(HOME + text + CLEAR_BELOW);
  }

  /** Show the cursor at a position, for text input. */
  placeCursor(row: number, col: number): void {
    this.stdout.write(`\x1b[${row + 1};${col + 1}H` + SHOW_CURSOR);
  }

  hideCursor(): void {
    this.stdout.write(HIDE_CURSOR);
  }

  /**
   * Give the terminal back, run something against it, then reclaim it.
   * The prompt afterwards is what stops output vanishing the instant it appears.
   */
  async suspend<T>(fn: () => Promise<T> | T, { pause = true, label = 'Press any key to return to the menu' }: { pause?: boolean; label?: string } = {}): Promise<T | undefined> {
    const wasOpen = this.open;
    if (wasOpen) {
      this.detach();
      // Leaving the alt-screen buffer restores the normal buffer exactly as it
      // was before we entered it: the shell prompt from before blankey
      // launched, wherever the cursor happened to sit. Without a clear, `fn`'s
      // output (a container picker, a shell session) lands appended after that
      // stale content instead of on a clean screen.
      this.stdout.write(SHOW_CURSOR + ALT_OFF + HOME + CLEAR_BELOW);
    }
    let result: T | undefined;
    let failure: unknown = null;
    try {
      result = await fn();
    } catch (e) {
      failure = e;
    }
    if (wasOpen) {
      if (pause) {
        this.stdout.write(`\n\x1b[2m${label}\x1b[22m`);
        this.attach();
        await this.readKey();
        this.detach();
        this.stdout.write('\n');
      }
      this.stdout.write(ALT_ON + HIDE_CURSOR);
      this.attach();
      this.flush();
      this.open = true;
    }
    if (failure) throw failure;
    return result;
  }
}
