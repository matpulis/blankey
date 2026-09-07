import { c, fg, bg, bold, gradient, width, truncate, strip } from '../ui/colors.js';
import { S, BOX } from '../ui/symbols.js';
import { style, joinHorizontal, place, bar, type Block } from '../ui/style.js';
import { T } from './theme.js';
import { isQuit, type Key } from './keys.js';

export const CANCEL: unique symbol = Symbol('cancel');
export type Cancelled = typeof CANCEL;

export interface ScreenLike {
  rows: number;
  columns: number;
  draw(lines: string[] | string): void;
  readKey(): Promise<Key>;
  hideCursor(): void;
  placeCursor(row: number, col: number): void;
}

export interface MenuItem<V = any> {
  label?: string;
  hint?: string;
  badge?: string;
  keywords?: string;
  value?: V;
  disabled?: boolean;
  separator?: string;
  /** Lines rendered in the detail pane while this item is highlighted. */
  detail?: () => string[];
}

export interface Chrome {
  breadcrumb?: string[];
  body?: Block;
  footer?: Array<[string, string]>;
  status?: string;
  /** Right-hand text on the title bar: host, counts, mode. */
  meta?: string;
}

/**
 * The window every view is drawn into: a title bar with the wordmark and a
 * breadcrumb, the body, and a key hint bar pinned to the bottom. Views return
 * body blocks and never have to reason about the terminal height.
 */
export function chrome(screen: ScreenLike, { breadcrumb = [], body = [], footer = [], status = '', meta = '' }: Chrome): string[] {
  const cols = screen.columns;
  const rows = screen.rows;
  const lines: string[] = [];

  const crumbs = breadcrumb.map((b, i) =>
    (i === breadcrumb.length - 1 ? bold(fg(T.brandAlt, b)) : c.muted(b))).join(c.faint(` ${S.chevron} `));
  const left = `  ${bold(gradient('blankey'))}${crumbs ? c.faint(`  ${S.chevron}  `) + crumbs : ''}`;
  const metaRoom = Math.max(0, cols - width(left) - 4);
  const right = meta ? c.faint(truncate(meta, metaRoom)) + '  ' : '';
  const gap = Math.max(1, cols - width(left) - width(right));

  lines.push('');
  lines.push(left + ' '.repeat(gap) + right);
  lines.push('  ' + fg(T.border, BOX.h.repeat(Math.max(0, cols - 4))));
  lines.push('');

  const footerHeight = footer.length ? 2 : 0;
  const statusHeight = status ? 2 : 0;
  const room = Math.max(1, rows - lines.length - footerHeight - statusHeight - 1);

  const shown = body.slice(0, room);
  for (const line of shown) lines.push(truncate(line, cols - 1));
  for (let i = shown.length; i < room; i++) lines.push('');

  if (status) {
    lines.push('');
    lines.push('  ' + truncate(status, cols - 4));
  }
  if (footer.length) {
    lines.push('  ' + fg(T.border, BOX.h.repeat(Math.max(0, cols - 4))));
    lines.push('  ' + footer.map(([k, v]) => `${bold(fg(T.accent, k))} ${c.faint(v)}`).join(c.faint('   ')));
  }
  return lines;
}

/** Indent a rendered block to sit inside the chrome's margin. */
export const indented = (block: Block, by = 2): Block => block.map((line) => ' '.repeat(by) + line);

/**
 * One row of a list: a marker, a label, and a hint pushed out to a shared
 * column so hints line up instead of colliding with longer labels.
 *
 * The hint is dropped rather than the label crushed when the pane is narrow:
 * a truncated label is much harder to recognise than a missing aside.
 */
function listRow(head: string, hint: string | undefined, headRoom: number, inner: number): string {
  const room = inner - headRoom - 2;
  if (!hint || room < 6) return head;
  return head + ' '.repeat(Math.max(1, headRoom - width(head))) + c.faint(truncate(hint, room));
}

/** `12/40` while a list is scrolled, and nothing when it all fits. */
const scrollTag = (total: number, offset: number, room: number): string | undefined =>
  (total > room ? c.faint(`${Math.min(offset + room, total)}/${total}`) : undefined);

/** Keep `index` inside the visible window, scrolling it just enough to fit. */
function scrollTo(index: number, offset: number, room: number, total: number): number {
  let next = offset;
  if (index >= 0) {
    if (index < next) next = Math.max(0, index - 1);
    if (index >= next + room) next = index - room + 1;
  }
  return Math.max(0, Math.min(next, Math.max(0, total - room)));
}

/** Step through the pickable positions of a list, wrapping at both ends. */
const step = (pickable: number[], index: number, by: number): number =>
  (pickable.length ? pickable[(pickable.indexOf(index) + by + pickable.length) % pickable.length] ?? index : index);

const subsequence = (hay: string, needle: string): boolean => {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
};

/**
 * Substring anywhere, or a subsequence of the label alone.
 *
 * Subsequence matching across hints and keywords too would match nearly
 * everything, which makes filtering feel broken. Loose matching earns its place
 * only against the short string the reader is actually looking at.
 */
export function matches(item: MenuItem, filter: string): boolean {
  const needle = filter.toLowerCase().trim();
  if (!needle) return true;
  const label = strip(item.label ?? '').toLowerCase();
  const hint = strip(item.hint ?? '').toLowerCase();
  const keywords = (item.keywords ?? '').toLowerCase();
  if (label.includes(needle) || hint.includes(needle) || keywords.includes(needle)) return true;
  return subsequence(label, needle);
}

export interface MenuOptions<V> {
  breadcrumb?: string[];
  items: Array<MenuItem<V>>;
  title?: string;
  meta?: string;
  initial?: number;
  filterable?: boolean;
  footer?: Array<[string, string]>;
  shortcuts?: Record<string, V>;
  emptyMessage?: string;
  /** Title of the right-hand pane. Omitted means a single-pane list. */
  detailTitle?: string;
  /** Fraction of the width given to the list when a detail pane is shown. */
  listRatio?: number;
}

const isSeparator = (it: MenuItem | undefined): boolean => Boolean(it && it.separator !== undefined);

/**
 * A scrolling, filterable list, optionally beside a detail pane that follows
 * the highlighted item.
 */
export async function menu<V = any>(screen: ScreenLike, options: MenuOptions<V>): Promise<V | Cancelled> {
  const {
    breadcrumb = [], items, title = '', meta = '', initial = 0,
    filterable = true, footer, shortcuts = {}, emptyMessage = 'nothing here',
    detailTitle, listRatio = 0.42,
  } = options;

  let filter = '';
  let index = initial;
  let offset = 0;

  const visible = (): Array<MenuItem<V>> => {
    const list = filter ? items.filter((it) => isSeparator(it) || matches(it, filter)) : items;
    // Drop headings whose whole group filtered away.
    return list.filter((it, i) => {
      if (!isSeparator(it)) return true;
      const next = list[i + 1];
      return Boolean(next) && !isSeparator(next);
    });
  };

  const render = () => {
    const list = visible();
    const pickable = list.map((it, i) => (isSeparator(it) || it.disabled ? -1 : i)).filter((i) => i >= 0);
    if (!pickable.length) index = -1;
    else if (!pickable.includes(index)) index = pickable.find((i) => i >= index) ?? pickable[pickable.length - 1]!;

    const cols = screen.columns;
    const showDetail = Boolean(detailTitle) && cols >= 84;
    const listWidth = showDetail ? Math.max(26, Math.floor((cols - 6) * listRatio)) : cols - 4;
    const detailWidth = cols - 6 - listWidth;

    const chromeHeight = 8 + (filter ? 2 : 0) + 2;
    const room = Math.max(3, screen.rows - chromeHeight - 2);
    offset = scrollTo(index, offset, room, list.length);

    const rows: string[] = [];
    if (!list.length) rows.push(c.faint(emptyMessage));

    const inner = listWidth - 4;
    const shown = list.slice(offset, offset + room);
    // Reserve a column for the labels so hints line up instead of colliding.
    const labelRoom = Math.max(
      0,
      ...shown.filter((it) => !isSeparator(it)).map((it) => width(it.label ?? '') + (it.badge ? 2 : 0)),
    );
    for (const [i, item] of shown.entries()) {
      const real = offset + i;
      if (isSeparator(item)) {
        rows.push(item.separator ? c.faint(item.separator.toUpperCase()) : '');
        continue;
      }
      const active = real === index;
      const marker = active ? fg(T.brand, S.play) : ' ';
      const label = item.disabled ? c.faint(item.label ?? '')
        : active ? bold(fg(T.brandAlt, item.label ?? ''))
          : c.muted(item.label ?? '');
      const badge = item.badge ? ' ' + item.badge : '';
      rows.push(listRow(`${marker} ${label}${badge}`, item.hint, labelRoom + 2, inner));
    }

    const listPane = style(rows.length ? rows : [''], {
      width: listWidth,
      height: room + 2,
      border: 'rounded',
      borderColor: T.borderActive,
      title: title || 'Menu',
      titleColor: T.brandAlt,
      tag: scrollTag(list.length, offset, room),
      padding: [0, 1],
      wrap: false,
    });

    let body: Block;
    if (showDetail) {
      const current = index >= 0 ? list[index] : undefined;
      const detailLines = current?.detail ? current.detail() : [c.faint('Nothing to preview.')];
      const detailPane = style(detailLines, {
        width: detailWidth,
        height: room + 2,
        border: 'rounded',
        borderColor: T.border,
        title: detailTitle,
        titleColor: T.muted,
        padding: [0, 1],
        valign: 'top',
      });
      body = joinHorizontal('top', ['  ', ...Array(listPane.length - 1).fill('  ')], listPane, [' ', ...Array(detailPane.length - 1).fill(' ')], detailPane);
    } else {
      body = indented(listPane);
    }

    screen.draw(chrome(screen, {
      breadcrumb,
      meta,
      body,
      status: filter ? `${fg(T.highlight, S.chevron)} ${bold(filter)}${c.faint('   esc clears')}` : '',
      footer: footer || [
        [`${S.up}${S.down}`, 'move'],
        ['enter', 'select'],
        ...(filterable ? [['type', 'search'] as [string, string]] : []),
        ['esc', breadcrumb.length ? 'back' : 'quit'],
      ],
    }));
    return { list, pickable };
  };

  screen.hideCursor();
  for (;;) {
    const { list, pickable } = render();
    const k = await screen.readKey();

    if (isQuit(k)) return CANCEL;
    if (k.name === 'escape') {
      if (filter) { filter = ''; offset = 0; continue; }
      return CANCEL;
    }
    if (k.name === 'up' || (k.ctrl && k.name === 'p')) { index = step(pickable, index, -1); continue; }
    if (k.name === 'down' || k.name === 'tab' || (k.ctrl && k.name === 'n')) { index = step(pickable, index, 1); continue; }
    if (k.name === 'pageup') { index = pickable[Math.max(0, pickable.indexOf(index) - 5)] ?? index; continue; }
    if (k.name === 'pagedown') { index = pickable[Math.min(pickable.length - 1, pickable.indexOf(index) + 5)] ?? index; continue; }
    if (k.name === 'home') { index = pickable[0] ?? index; continue; }
    if (k.name === 'end') { index = pickable[pickable.length - 1] ?? index; continue; }
    if (k.name === 'enter') {
      const chosen = list[index];
      if (chosen && !isSeparator(chosen) && !chosen.disabled) return chosen.value as V;
      continue;
    }
    if (k.name === 'backspace') { filter = filter.slice(0, -1); offset = 0; continue; }

    // Single-letter shortcuts apply only while nothing is being filtered, so a
    // search term is never hijacked.
    if (!filter && k.name === 'char' && !k.ctrl && !k.alt && shortcuts[k.char] !== undefined) {
      return shortcuts[k.char] as V;
    }
    if (filterable && (k.name === 'char' || k.name === 'space') && !k.ctrl && !k.alt) {
      filter += k.name === 'space' ? ' ' : k.char;
      offset = 0;
      index = 0;
    }
  }
}

export interface ChecklistItem<V = any> {
  label: string;
  hint?: string;
  value: V;
  checked?: boolean;
  disabled?: boolean;
}

export interface ChecklistOptions<V> {
  breadcrumb?: string[];
  items: Array<ChecklistItem<V>>;
  title?: string;
  meta?: string;
  emptyMessage?: string;
}

/**
 * A scrolling multi-select list: space toggles the highlighted row, 'a' toggles
 * everything selectable, enter confirms the checked set. Unlike `menu()`, typing
 * does not filter, since these lists are short enough that browsing is enough, and
 * space is needed for toggling instead.
 */
export async function checklist<V = any>(screen: ScreenLike, options: ChecklistOptions<V>): Promise<V[] | Cancelled> {
  const { breadcrumb = [], items, title = '', meta = '', emptyMessage = 'nothing here' } = options;

  const selectable = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  const checked = new Set<number>(items.map((it, i) => (it.checked && !it.disabled ? i : -1)).filter((i) => i >= 0));
  let index = selectable[0] ?? -1;
  let offset = 0;

  const render = () => {
    const cols = screen.columns;
    const listWidth = cols - 4;
    const room = Math.max(3, screen.rows - 10 - 2);
    offset = scrollTo(index, offset, room, items.length);

    const rows: string[] = [];
    if (!items.length) rows.push(c.faint(emptyMessage));
    const inner = listWidth - 4;
    const shown = items.slice(offset, offset + room);
    const labelRoom = Math.max(0, ...shown.map((it) => width(it.label)));
    for (const [i, item] of shown.entries()) {
      const real = offset + i;
      const active = real === index;
      const marker = active ? fg(T.brand, S.play) : ' ';
      const box = item.disabled ? c.faint(S.ring) : checked.has(real) ? fg(T.ok, S.tick) : c.faint(S.ring);
      const label = item.disabled ? c.faint(item.label)
        : active ? bold(fg(T.brandAlt, item.label)) : c.muted(item.label);
      rows.push(listRow(`${marker} ${box} ${label}`, item.hint, labelRoom + 6, inner));
    }

    const listPane = style(rows.length ? rows : [''], {
      width: listWidth,
      height: room + 2,
      border: 'rounded',
      borderColor: T.borderActive,
      title: title || 'Select',
      titleColor: T.brandAlt,
      tag: scrollTag(items.length, offset, room),
      padding: [0, 1],
      wrap: false,
    });

    screen.draw(chrome(screen, {
      breadcrumb,
      meta,
      body: indented(listPane),
      status: `${checked.size} of ${selectable.length} selected`,
      footer: [
        [`${S.up}${S.down}`, 'move'],
        ['space', 'toggle'],
        ['a', 'all/none'],
        ['enter', 'confirm'],
        ['esc', breadcrumb.length ? 'back' : 'quit'],
      ],
    }));
  };

  screen.hideCursor();
  for (;;) {
    render();
    const k = await screen.readKey();
    if (isQuit(k)) return CANCEL;
    if (k.name === 'escape') return CANCEL;
    if (k.name === 'up' || (k.ctrl && k.name === 'p')) { index = step(selectable, index, -1); continue; }
    if (k.name === 'down' || k.name === 'tab' || (k.ctrl && k.name === 'n')) { index = step(selectable, index, 1); continue; }
    if (k.name === 'home') { index = selectable[0] ?? index; continue; }
    if (k.name === 'end') { index = selectable[selectable.length - 1] ?? index; continue; }
    if (k.name === 'space') {
      if (index >= 0) { if (checked.has(index)) checked.delete(index); else checked.add(index); }
      continue;
    }
    if (k.name === 'char' && k.char === 'a' && !k.ctrl && !k.alt) {
      const allChecked = selectable.length > 0 && selectable.every((i) => checked.has(i));
      checked.clear();
      if (!allChecked) for (const i of selectable) checked.add(i);
      continue;
    }
    if (k.name === 'enter') {
      return [...checked].sort((a, b) => a - b).map((i) => items[i]!.value);
    }
  }
}

export interface InputOptions {
  breadcrumb?: string[];
  label: string;
  value?: string;
  placeholder?: string;
  mask?: boolean;
  help?: string;
  validate?: (text: string) => string | null;
  /** Override the key hints, for flows where escape means something else. */
  footer?: Array<[string, string]>;
}

/** Single-line text entry with editing keys, masking and validation. */
export async function input(screen: ScreenLike, {
  breadcrumb = [], label, value = '', placeholder = '', mask = false, help = '', validate, footer,
}: InputOptions): Promise<string | Cancelled> {
  let text = String(value ?? '');
  let cursor = text.length;
  let error = '';

  for (;;) {
    const shown = mask ? '•'.repeat(text.length) : text;
    const field = text ? bold(shown) : c.faint(placeholder || ' ');
    const boxWidth = Math.min(72, screen.columns - 8);

    const panel = style([
      ...(help ? [c.muted(help), ''] : []),
      fg(T.brand, S.chevron) + ' ' + field,
      ...(error ? ['', fg(T.danger, `${S.cross} ${error}`)] : []),
    ], {
      width: boxWidth,
      border: 'rounded',
      borderColor: error ? T.danger : T.borderActive,
      title: label,
      titleColor: T.brandAlt,
      padding: [1, 2],
      wrap: true,
    });

    screen.draw(chrome(screen, {
      breadcrumb,
      body: indented(panel),
      footer: footer || [['enter', 'confirm'], ['esc', 'cancel'], ['ctrl+u', 'clear']],
    }));

    // Sit the cursor after the typed text so editing feels native.
    const cursorRow = 4 + (help ? 2 : 0) + 2;
    const prefix = mask ? '•'.repeat(cursor) : text.slice(0, cursor);
    screen.placeCursor(cursorRow, 2 + 1 + 2 + 2 + width(prefix));

    const k = await screen.readKey();
    if (isQuit(k) || k.name === 'escape') { screen.hideCursor(); return CANCEL; }

    if (k.name === 'enter') {
      const problem = validate ? validate(text) : null;
      if (problem) { error = problem; continue; }
      screen.hideCursor();
      return text;
    }
    if (k.name === 'backspace') {
      if (cursor > 0) { text = text.slice(0, cursor - 1) + text.slice(cursor); cursor--; }
      error = '';
      continue;
    }
    if (k.name === 'delete') { text = text.slice(0, cursor) + text.slice(cursor + 1); continue; }
    if (k.name === 'left') { cursor = Math.max(0, cursor - 1); continue; }
    if (k.name === 'right') { cursor = Math.min(text.length, cursor + 1); continue; }
    if (k.name === 'home' || (k.ctrl && k.name === 'a')) { cursor = 0; continue; }
    if (k.name === 'end' || (k.ctrl && k.name === 'e')) { cursor = text.length; continue; }
    if (k.ctrl && k.name === 'u') { text = ''; cursor = 0; error = ''; continue; }
    if ((k.name === 'char' || k.name === 'space') && !k.ctrl && !k.alt) {
      const ch = k.name === 'space' ? ' ' : k.char;
      text = text.slice(0, cursor) + ch + text.slice(cursor);
      cursor += ch.length;
      error = '';
    }
  }
}

export interface ConfirmOptions {
  breadcrumb?: string[];
  message: string;
  detail?: string[];
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  def?: boolean;
  /** Override the key hints, for flows where escape means something else. */
  footer?: Array<[string, string]>;
}

/** Yes/no. The dangerous option is never preselected. */
export async function confirm(screen: ScreenLike, {
  breadcrumb = [], message, detail = [], danger = false,
  confirmLabel = 'Yes', cancelLabel = 'No', def = false, footer,
}: ConfirmOptions): Promise<boolean | Cancelled> {
  let yes = danger ? false : def;

  for (;;) {
    const buttons = [true, false].map((option) => {
      const label = option ? confirmLabel : cancelLabel;
      const active = option === yes;
      const tone = option && danger ? T.danger : option ? T.ok : T.faint;
      return active ? bg(tone, fg(T.ink, bold(` ${label} `))) : c.muted(`  ${label}  `);
    }).join('  ');

    const panel = style([
      (danger ? fg(T.danger, S.warn) + ' ' : '') + bold(message),
      ...(detail.length ? ['', ...detail] : []),
      '',
      buttons,
    ], {
      width: Math.min(76, screen.columns - 8),
      border: 'rounded',
      borderColor: danger ? T.danger : T.borderActive,
      title: danger ? 'confirm' : undefined,
      titleColor: T.danger,
      padding: [1, 2],
      wrap: true,
    });

    screen.draw(chrome(screen, {
      breadcrumb,
      body: indented(panel),
      footer: footer || [['left/right', 'choose'], ['enter', 'confirm'], ['esc', 'cancel']],
    }));

    const k = await screen.readKey();
    if (isQuit(k) || k.name === 'escape') return CANCEL;
    if (k.name === 'left' || k.name === 'right' || k.name === 'tab') { yes = !yes; continue; }
    if (k.name === 'char' && /^y$/i.test(k.char)) return true;
    if (k.name === 'char' && /^n$/i.test(k.char)) return false;
    if (k.name === 'enter') return yes;
  }
}

export type Tone = 'info' | 'success' | 'warn' | 'danger';

export interface NoticeOptions {
  breadcrumb?: string[];
  title?: string;
  message: string;
  detail?: string[];
  tone?: Tone;
  /** Label on the single button. */
  action?: string;
}

const TONE: Record<Tone, { colour: string; mark: string }> = {
  info: { colour: T.brandAlt, mark: S.info },
  success: { colour: T.ok, mark: S.tick },
  warn: { colour: T.warn, mark: S.warn },
  danger: { colour: T.danger, mark: S.cross },
};

/**
 * Something the user only has to acknowledge.
 *
 * Distinct from `confirm` on purpose: a question with one answer rendered as a
 * yes/no gives two identical buttons and implies a choice that does not exist.
 */
export async function notice(screen: ScreenLike, {
  breadcrumb = [], title, message, detail = [], tone = 'info', action = 'Continue',
}: NoticeOptions): Promise<void> {
  const { colour, mark } = TONE[tone];

  const panel = style([
    fg(colour, mark) + ' ' + bold(message),
    ...(detail.length ? ['', ...detail] : []),
    '',
    bg(colour, fg(T.ink, bold(` ${action} `))),
  ], {
    width: Math.min(76, screen.columns - 8),
    border: 'rounded',
    borderColor: colour,
    title,
    titleColor: colour,
    padding: [1, 2],
    wrap: true,
  });

  screen.draw(chrome(screen, {
    breadcrumb,
    body: indented(panel),
    footer: [['enter', action.toLowerCase()]],
  }));

  // Any key moves on: there is nothing to get wrong.
  for (;;) {
    const k = await screen.readKey();
    if (isQuit(k) || k.name === 'enter' || k.name === 'escape' || k.name === 'space' || k.name === 'char') return;
  }
}

/** Scrollable read-only text. */
export async function pager(screen: ScreenLike, { breadcrumb = [], lines, title = '' }: { breadcrumb?: string[]; lines: string[]; title?: string }): Promise<Cancelled> {
  let offset = 0;
  for (;;) {
    const room = Math.max(3, screen.rows - 12);
    const max = Math.max(0, lines.length - room);
    offset = Math.max(0, Math.min(offset, max));
    const panel = style(lines.slice(offset, offset + room), {
      width: screen.columns - 4,
      height: room + 2,
      border: 'rounded',
      borderColor: T.border,
      title: title || undefined,
      titleColor: T.muted,
      tag: max ? c.faint(`${offset + room}/${lines.length}`) : undefined,
      padding: [0, 1],
      wrap: false,
    });
    screen.draw(chrome(screen, {
      breadcrumb,
      body: indented(panel),
      footer: [[`${S.up}${S.down}`, 'scroll'], ['esc', 'back']],
    }));
    const k = await screen.readKey();
    if (isQuit(k) || k.name === 'escape' || k.name === 'enter') return CANCEL;
    if (k.name === 'up') offset -= 1;
    if (k.name === 'down') offset += 1;
    if (k.name === 'pageup') offset -= room;
    if (k.name === 'pagedown') offset += room;
    if (k.name === 'home') offset = 0;
    if (k.name === 'end') offset = max;
  }
}

/** Shown while something slow is happening. */
export function busy(screen: ScreenLike, breadcrumb: string[], message: string): void {
  const panel = style([fg(T.brand, S.play) + '  ' + c.muted(message)], {
    width: Math.min(60, screen.columns - 8),
    border: 'rounded',
    borderColor: T.border,
    padding: [1, 2],
  });
  screen.draw(chrome(screen, {
    breadcrumb,
    body: indented(place(screen.columns - 4, Math.max(3, screen.rows - 12), panel, { align: 'center', valign: 'middle' })),
    footer: [],
  }));
}

export { style, joinHorizontal, place, bar };
