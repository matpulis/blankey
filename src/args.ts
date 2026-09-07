/**
 * Small argv parser. Supports --flag, --flag=value, --flag value, -abc bundles,
 * --no-flag negation, and everything after `--` kept verbatim as passthrough.
 */
export interface ParsedArgs {
  flags: Record<string, any>;
  positional: string[];
  passthrough: string[];
}

export interface ArgSpec {
  valueFlags?: string[];
  aliases?: Record<string, string>;
}

export function parseArgs(argv: string[], spec: ArgSpec = {}): ParsedArgs {
  const flags: Record<string, any> = {};
  const positional: any[] = [];
  const passthrough: any[] = [];
  const takesValue = new Set(spec.valueFlags || []);
  const aliases = spec.aliases || {};

  let i = 0;
  let seenDoubleDash = false;
  while (i < argv.length) {
    const arg = argv[i];
    if (seenDoubleDash) { passthrough.push(arg); i++; continue; }
    if (arg === '--') { seenDoubleDash = true; i++; continue; }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[normalize(body.slice(0, eq), aliases)] = coerce(body.slice(eq + 1));
        i++;
        continue;
      }
      if (body.startsWith('no-')) {
        flags[normalize(body.slice(3), aliases)] = false;
        i++;
        continue;
      }
      const key = normalize(body, aliases);
      const next = argv[i + 1];
      if (takesValue.has(key) && next !== undefined && !next.startsWith('-')) {
        flags[key] = coerce(next);
        i += 2;
        continue;
      }
      flags[key] = true;
      i++;
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1 && arg !== '-') {
      const letters = arg.slice(1).split('');
      for (let j = 0; j < letters.length; j++) {
        const key = normalize(letters[j], aliases);
        const isLast = j === letters.length - 1;
        if (isLast && takesValue.has(key)) {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith('-')) {
            flags[key] = coerce(next);
            i++;
            break;
          }
        }
        flags[key] = true;
      }
      i++;
      continue;
    }

    positional.push(arg);
    i++;
  }
  return { flags, positional, passthrough };
}

function normalize(key: string, aliases: Record<string, string>): string {
  const k = aliases[key] || key;
  return k.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function coerce(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
