export async function pMap<R = any>(items: any[], fn: (item: any, index: number) => Promise<R> | R, concurrency = 8): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function slug(s: unknown): string {
  return String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

export function relTime(date: unknown): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date as any);
  if (Number.isNaN(d.getTime())) return '';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  const abs = Math.abs(s);
  const units: Array<[number, string]> = [[60, 's'], [3600, 'm'], [86400, 'h'], [604800, 'd'], [2629800, 'w'], [31557600, 'mo']];
  if (abs < 60) return `${abs}s`;
  for (let i = 1; i < units.length; i++) {
    if (abs < units[i]![0]) return `${Math.floor(abs / units[i - 1]![0])}${units[i]![1]}`;
  }
  return `${Math.floor(abs / 31557600)}y`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

export function bytes(n: unknown): string {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n ?? '');
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = num;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

const SIZE_UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

/**
 * Turn the human sizes Docker prints back into bytes: "1.2GB", "938.4MB",
 * "6.1GB (66%)", "0B (virtual 123MB)". Returns 0 when there is nothing to read,
 * so totals stay addable.
 */
export function parseSize(text: unknown): number {
  if (typeof text === 'number') return Number.isFinite(text) ? text : 0;
  const m = /(-?\d+(?:\.\d+)?)\s*([KMGTP]?i?B|B)/i.exec(String(text || ''));
  if (!m) return 0;
  const unit = SIZE_UNITS[m[2]!.toLowerCase()];
  return unit ? Math.round(Number(m[1]) * unit) : 0;
}

/** Parse `docker ... --format json` output: either a JSON array or NDJSON. */
export function parseDockerJson(stdout: unknown): any[] {
  const text = String(stdout || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try { return JSON.parse(text); } catch { /* fall through to NDJSON */ }
  }
  const out: any[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || !t.startsWith('{')) continue;
    try { out.push(JSON.parse(t)); } catch { /* ignore partial lines */ }
  }
  return out;
}

export function unique<T>(arr: T[]): T[] { return [...new Set(arr)]; }

export function groupBy(arr: any[], keyFn: (item: any) => any): Map<any, any[]> {
  const map = new Map<any, any[]>();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

/** Fuzzy-ish match used for name resolution and suggestions. */
export function score(needle: string, haystack: string): number {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (h === n) return 1000;
  if (h.startsWith(n)) return 800 - (h.length - n.length);
  if (h.includes(n)) return 600 - (h.length - n.length);
  let i = 0;
  for (const ch of h) if (ch === n[i]) i++;
  return i === n.length ? 300 - (h.length - n.length) : -1;
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- text

/**
 * The meaningful lines of command output: trimmed, with the blanks dropped.
 * Nearly every `docker ...`/`git ...` reader wants exactly this.
 */
export function lines(text: unknown): string[] {
  return String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * The first line of a message, optionally clipped. Errors from docker and git
 * run to dozens of lines; only the first one fits beside a spinner or in a
 * table cell.
 */
export function firstLine(text: unknown, max = 0): string {
  const line = String(text ?? '').split('\n')[0] ?? '';
  return max > 0 ? line.slice(0, max) : line;
}

/**
 * The last `n` lines, joined. Tools that print progress before failing keep the
 * reason at the end, so this is the useful half of their output.
 */
export function lastLines(text: unknown, n = 1, separator = ' '): string {
  return String(text ?? '').split('\n').slice(-n).join(separator).trim();
}

/** Clip to `max` characters, marking that something was cut. */
export function ellipsis(text: unknown, max: number): string {
  const s = String(text ?? '');
  return max > 0 && s.length > max ? s.slice(0, max - 1) + '…' : s;
}
