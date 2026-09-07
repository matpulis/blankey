
import { c, pad, width, truncate } from './colors.js';
import { termWidth } from './box.js';

/**
 * Borderless, breathing table. Columns: { key, label, align, min, max, grow }.
 * Shrinks the widest growable column first so it degrades sanely in narrow terminals.
 */
export function table(rows, columns, { gap = 2, head = true, maxWidth, indent = 2 }: any = {}) {
  if (!rows.length) return '';
  const sep = ' '.repeat(gap);
  const lead = ' '.repeat(indent);
  const widths = columns.map((col) => {
    const cells = rows.map((r) => width(String(r[col.key] ?? '')));
    const w = Math.max(head ? width(col.label ?? col.key) : 0, ...cells, col.min ?? 0);
    return col.max ? Math.min(w, col.max) : w;
  });

  const avail = (maxWidth || termWidth()) - gap * (columns.length - 1) - indent;
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > avail) {
    let idx = -1;
    let best = -1;
    columns.forEach((col, i) => {
      if (col.grow === false) return;
      const slack = widths[i] - (col.min ?? 6);
      if (slack > best) { best = slack; idx = i; }
    });
    if (idx < 0 || best <= 0) break;
    const cut = Math.min(total - avail, best);
    widths[idx] -= cut;
    total -= cut;
  }

  const out: any[] = [];
  if (head) {
    out.push(
      lead + columns
        .map((col, i) => c.muted(c.bold(pad(String(col.label ?? col.key).toUpperCase(), widths[i], col.align))))
        .join(sep)
        .trimEnd(),
    );
  }
  for (const row of rows) {
    out.push(
      lead + columns
        .map((col, i) => {
          const raw = String(row[col.key] ?? '');
          return pad(truncate(raw, widths[i]), widths[i], col.align);
        })
        .join(sep)
        .trimEnd(),
    );
  }
  return out.join('\n');
}
