/**
 * A deliberately small YAML reader covering the subset Compose files and blankey
 * config actually use: nested maps, sequences, inline maps in sequence items,
 * quoted scalars, block scalars and comments.
 *
 * For anything needing full fidelity (extends, interpolation, merge keys) the CLI
 * defers to `docker compose config --format json`; this parser exists so discovery
 * stays fast and keeps working when Docker is unreachable.
 */

const NUM = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/;
const BS = String.fromCharCode(92);

function stripComment(line) {
  let out = '';
  let quote: any = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out.replace(/\s+$/, '');
}

function scalar(raw) {
  const s = String(raw).trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null') return null;
  if (s === 'true' || s === 'True' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === 'False' || s === 'no' || s === 'off') return false;
  if (NUM.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) {
    return s.slice(1, -1).split(BS + 'n').join('\n').split(BS + '"').join('"');
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).split("''").join("'");
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? splitFlow(inner).map(scalar) : [];
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (inner) {
      for (const part of splitFlow(inner)) {
        const idx = part.indexOf(':');
        if (idx < 0) continue;
        obj[scalar(part.slice(0, idx))] = scalar(part.slice(idx + 1));
      }
    }
    return obj;
  }
  return s;
}

/** Split a flow collection on commas that are not inside quotes or brackets. */
function splitFlow(s) {
  const parts: any[] = [];
  let depth = 0;
  let quote: any = null;
  let cur = '';
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const indentOf = (l) => l.length - l.trimStart().length;

export function parseYaml(text) {
  if (!text) return {};
  const raw = String(text).split('\n');
  const lines: any[] = [];
  for (const line0 of raw) {
    const line = line0.split('\t').join('  ').replace(/\r$/, '');
    if (/^\s*(---|\.\.\.)\s*$/.test(line)) continue;
    const stripped = stripComment(line);
    if (!stripped.trim()) continue;
    lines.push({ indent: indentOf(stripped), text: stripped.trim() });
  }
  if (!lines.length) return {};
  const [value] = parseBlock(lines, 0, lines[0].indent);
  return value ?? {};
}

function parseBlock(lines, start, indent) {
  if (start >= lines.length) return [null, start];
  if (lines[start].text.startsWith('- ') || lines[start].text === '-') {
    return parseSeq(lines, start, indent);
  }
  return parseMap(lines, start, indent);
}

function parseMap(lines, start, indent) {
  const obj = {};
  let i = start;
  while (i < lines.length) {
    const { indent: ind, text } = lines[i];
    if (ind < indent) break;
    if (ind > indent) { i++; continue; } // defensive: malformed indentation
    if (text.startsWith('- ')) break;

    const m = /^(".*?"|'.*?'|[^:]+?)\s*:\s*(.*)$/.exec(text);
    if (!m) { i++; continue; }
    const key = String(scalar(m[1]));
    const rest = m[2];
    i++;

    if (['|', '>', '|-', '>-', '|+', '>+'].includes(rest)) {
      const body: any[] = [];
      const childIndent = i < lines.length ? lines[i].indent : indent + 2;
      while (i < lines.length && lines[i].indent >= childIndent && lines[i].indent > indent) {
        body.push(lines[i].text);
        i++;
      }
      obj[key] = rest.startsWith('|') ? body.join('\n') : body.join(' ');
      continue;
    }

    if (rest !== '') { obj[key] = scalar(rest); continue; }

    if (i < lines.length && lines[i].indent > indent) {
      const [val, next] = parseBlock(lines, i, lines[i].indent);
      obj[key] = val;
      i = next;
    } else obj[key] = null;
  }
  return [obj, i];
}

function parseSeq(lines, start, indent) {
  const arr: any[] = [];
  let i = start;
  while (i < lines.length) {
    const { indent: ind, text } = lines[i];
    if (ind < indent) break;
    if (ind > indent) { i++; continue; }
    if (!text.startsWith('- ') && text !== '-') break;

    const rest = text === '-' ? '' : text.slice(2).trim();
    i++;

    if (rest === '') {
      if (i < lines.length && lines[i].indent > indent) {
        const [val, next] = parseBlock(lines, i, lines[i].indent);
        arr.push(val);
        i = next;
      } else arr.push(null);
      continue;
    }

    // `- key: value` opens a map whose remaining keys sit two columns in.
    if (/^(".*?"|'.*?'|[^:]+?)\s*:(\s|$)/.test(rest)) {
      const childIndent = indent + 2;
      const synthetic = [{ indent: childIndent, text: rest }];
      while (i < lines.length && lines[i].indent >= childIndent) {
        synthetic.push(lines[i]);
        i++;
      }
      const [val] = parseMap(synthetic, 0, childIndent);
      arr.push(val);
      continue;
    }
    arr.push(scalar(rest));
  }
  return [arr, i];
}

/** Minimal emitter, used when writing generated config back out. */
export function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value
      .map((v) => (v && typeof v === 'object'
        ? `${pad}- ${toYaml(v, indent + 2).trimStart()}`
        : `${pad}- ${fmtScalar(v)}`))
      .join('\n');
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    return keys
      .map((k) => {
        const v = value[k];
        const nested = v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length);
        return nested ? `${pad}${k}:\n${toYaml(v, indent + 2)}` : `${pad}${k}: ${toYaml(v, 0)}`;
      })
      .join('\n');
  }
  return fmtScalar(value);
}

function fmtScalar(v) {
  if (typeof v === 'string') {
    const risky = v === '' || /^[:#\-{}\[\]&*!|>'"%@`]/.test(v) || /:\s|\s#/.test(v) ||
      NUM.test(v) || ['true', 'false', 'null', 'yes', 'no', 'on', 'off'].includes(v);
    return risky ? JSON.stringify(v) : v;
  }
  return String(v);
}
