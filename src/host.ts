// Execution + filesystem abstraction: everything runs either locally or over SSH,
// so the CLI behaves identically on the Docker host and from a workstation.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { log } from './ui/log.js';
import { lines } from './util.js';
import { parseYaml } from './yaml.js';
import type { ExecResult, StreamResult, ExecOptions, SshConfig } from './types.js';

let remote: SshConfig | null = null;

export function useRemote(sshConfig: SshConfig | null | undefined): void {
  remote = sshConfig && sshConfig.host ? sshConfig : null;
}
export const isRemote = () => Boolean(remote);
export const remoteLabel = () => (remote ? remote.host : 'local');

const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const BACKSLASH = String.fromCharCode(92);

/**
 * Quote one argument for the shell that will actually run it. Remote commands
 * always go through a POSIX shell; locally on Windows they go through cmd.exe,
 * which does not treat single quotes as quoting at all.
 */
export function q(s: unknown): string {
  const str = String(s);
  if (!remote && process.platform === 'win32') {
    return DQ + str.split(DQ).join(BACKSLASH + DQ) + DQ;
  }
  return SQ + str.split(SQ).join(SQ + BACKSLASH + SQ + SQ) + SQ;
}

function sshArgs(extra: string[] = []): string[] {
  const a: string[] = [];
  if (!remote) return a;
  if (remote.port) a.push('-p', String(remote.port));
  if (remote.identity) a.push('-i', remote.identity);
  if (remote.strictHostKeyChecking === false) a.push('-o', 'StrictHostKeyChecking=no');
  a.push('-o', 'ConnectTimeout=10');
  return [...a, ...extra, remote.host];
}

interface SpawnPlan { file: string; args: string[]; shell: boolean; cwd?: string | undefined; windowsVerbatimArguments?: boolean }

function build(cmd: string, cwd?: string, { tty = false }: { tty?: boolean } = {}): SpawnPlan {
  // Remote commands have to carry their own `cd`, since each SSH invocation
  // starts in the login directory. Locally the child process gets a real cwd,
  // which avoids quoting the path into a shell entirely.
  if (remote) {
    const full = cwd ? `cd ${q(cwd)} && ${cmd}` : cmd;
    return { file: 'ssh', args: [...sshArgs(tty ? ['-t'] : ['-o', 'BatchMode=yes']), full], shell: false };
  }
  if (process.platform === 'win32') {
    return {
      file: process.env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', cmd],
      shell: false,
      windowsVerbatimArguments: true,
      cwd,
    };
  }
  return { file: '/bin/sh', args: ['-c', cmd], shell: false, cwd };
}

/** Run a command, capture output. Never throws on non-zero exit, so inspect `.code`. */
export function exec(cmd: string, { cwd, env, timeout = 0, input, maxBuffer = 8 * 1024 * 1024 }: ExecOptions = {}): Promise<ExecResult> {
  const { file, args, ...opts } = build(cmd, cwd);
  log.debug(`${remote ? `[${remote.host}] ` : ''}${cwd ? cwd + ' $ ' : '$ '}${cmd}`);
  return new Promise<ExecResult>((resolve) => {
    const child = spawn(file, args, { ...opts, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = timeout
      ? setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeout)
      : null;
    child.stdout.on('data', (d) => { if (stdout.length < maxBuffer) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < maxBuffer) stderr += d; });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout: '', stderr: e.message, cmd, timedOut: false });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: killed ? 124 : code ?? 1, stdout: stdout.trim(), stderr: stderr.trim(), cmd, timedOut: killed });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Run and throw a rich error on failure. */
export async function execOk(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const r = await exec(cmd, opts);
  if (r.code !== 0) {
    const e = new Error(failureText(r) || `command failed (${r.code}): ${cmd}`) as Error & { result?: ExecResult };
    e.result = r;
    throw e;
  }
  return r;
}

/**
 * Why a command failed. Tools are inconsistent about which stream they explain
 * themselves on, so both are worth looking at, in that order.
 */
export const failureText = (r: ExecResult): string => r.stderr || r.stdout;

export interface Outcome { ok: boolean; error: string | null }

/**
 * A command's result reduced to "did it work, and if not why". The shape most
 * of git.ts and backup.ts hand back to their callers.
 */
export const outcome = (r: ExecResult): Outcome =>
  (r.code === 0 ? { ok: true, error: null } : { ok: false, error: failureText(r) });

/** Stream output line-by-line while it happens (used by deploy/build). */
export function stream(cmd: string, { cwd, env, onLine }: ExecOptions = {}): Promise<StreamResult> {
  const { file, args, ...opts } = build(cmd, cwd);
  log.debug(`${cwd ? cwd + ' $ ' : '$ '}${cmd}`);
  return new Promise<StreamResult>((resolve) => {
    const child = spawn(file, args, { ...opts, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const buf: { out: string; err: string } = { out: '', err: '' };
    const tail: string[] = [];
    const feed = (key: 'out' | 'err', chunk: string) => {
      buf[key] += chunk;
      const complete = buf[key].split('\n');
      buf[key] = complete.pop() ?? '';
      for (const line of complete) {
        tail.push(line);
        if (tail.length > 40) tail.shift();
        onLine?.(line, key);
      }
    };
    child.stdout.on('data', (d) => feed('out', d.toString()));
    child.stderr.on('data', (d) => feed('err', d.toString()));
    child.on('error', (e) => resolve({ code: 127, tail: [e.message] }));
    child.on('close', (code) => {
      if (buf.out) { tail.push(buf.out); onLine?.(buf.out, 'out'); }
      if (buf.err) { tail.push(buf.err); onLine?.(buf.err, 'err'); }
      resolve({ code: code ?? 1, tail });
    });
  });
}

/** Hand the terminal over (logs -f, exec sh, editors). Resolves with the exit code. */
export function interactive(cmd: string, { cwd, env }: ExecOptions = {}): Promise<number> {
  const { file, args, ...opts } = build(cmd, cwd, { tty: true });
  return new Promise<number>((resolve) => {
    const child = spawn(file, args, { ...opts, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// ---------------------------------------------------------------- filesystem

export async function exists(p: string): Promise<boolean> {
  if (remote) return (await exec(`test -e ${q(p)}`)).code === 0;
  return fss.existsSync(p);
}

export async function readFile(p: string): Promise<string | null> {
  if (remote) {
    const r = await exec(`cat ${q(p)}`);
    return r.code === 0 ? r.stdout : null;
  }
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
}

export async function writeFile(p: string, content: string): Promise<void> {
  if (remote) {
    const dir = path.posix.dirname(p);
    const marker = 'BLANKEY_EOF_' + Math.random().toString(36).slice(2, 8);
    await execOk(`mkdir -p ${q(dir)} && cat > ${q(p)} <<'${marker}'\n${content}\n${marker}`);
    return;
  }
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
}

export async function mkdirp(p: string): Promise<void> {
  if (remote) { await execOk(`mkdir -p ${q(p)}`); return; }
  await fs.mkdir(p, { recursive: true });
}

/**
 * Write only when the contents would actually change, and say whether they did.
 *
 * Generated files, such as a routing overlay or Traefik's dynamic certificate config,
 * are rewritten on every scan. Touching one that has not changed makes Compose
 * see a new configuration, or Traefik reload for nothing, so the comparison is
 * part of writing rather than something each caller remembers to do.
 */
export async function writeIfChanged(p: string, content: string): Promise<boolean> {
  if ((await readFile(p)) === content) return false;
  await writeFile(p, content);
  return true;
}

/**
 * Create a directory only if it does not exist, atomically. This is the
 * test-and-set behind the lock, so it must never be emulated with a
 * check-then-create: both mkdir(2) and `mkdir` fail when the path is taken.
 */
export async function mkdirExclusive(p: string): Promise<boolean> {
  if (remote) return (await exec(`mkdir ${q(p)}`)).code === 0;
  try {
    await fs.mkdir(p);
    return true;
  } catch {
    return false;
  }
}

/** Delete a file or directory tree. Used for locks and for credential files. */
export async function remove(p: string): Promise<boolean> {
  if (remote) return (await exec(`rm -rf ${q(p)}`)).code === 0;
  try {
    await fs.rm(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * `stat` is not everywhere (BusyBox, macOS take different flags), so fall back
 * to counting bytes. Exported because container log files are sized the same
 * way, on the Docker host, even when blankey itself is running locally.
 */
export const sizeCommand = (p: string): string => `stat -c %s ${q(p)} 2>/dev/null || wc -c < ${q(p)}`;

/** Size of a file in bytes, or null when it cannot be read. */
export async function size(p: string): Promise<number | null> {
  if (remote) {
    const r = await exec(sizeCommand(p));
    const n = Number(String(r.stdout).trim());
    return Number.isFinite(n) ? n : null;
  }
  try {
    return (await fs.stat(p)).size;
  } catch {
    return null;
  }
}

/** Restrict a file's permissions. A no-op where the concept does not apply. */
export async function chmod(p: string, mode = 0o600): Promise<boolean> {
  if (remote) return (await exec(`chmod ${mode.toString(8)} ${q(p)}`)).code === 0;
  if (process.platform === 'win32') return true;
  try {
    await fs.chmod(p, mode);
    return true;
  } catch {
    return false;
  }
}

/** Immediate children directories of `dir` (names only). */
export async function listDirs(dir: string): Promise<string[]> {
  if (remote) {
    const r = await exec(`ls -1p ${q(dir)} 2>/dev/null | grep '/' | sed 's,/,,'`);
    return r.code === 0 ? lines(r.stdout) : [];
  }
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch { return []; }
}

/** Immediate children files of `dir` (names only). */
export async function listFiles(dir: string): Promise<string[]> {
  if (remote) {
    const r = await exec(`ls -1p ${q(dir)} 2>/dev/null | grep -v '/'`);
    return r.code === 0 ? lines(r.stdout) : [];
  }
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isFile()).map((e) => e.name);
  } catch { return []; }
}

/**
 * A small YAML sidecar, with anything unreadable or malformed treated as
 * absent. Used for the `meta.yml` beside a certificate or an SSH key, where a
 * damaged label must never stop the thing it labels from being listed.
 */
export async function readYaml(p: string): Promise<Record<string, any>> {
  const text = await readFile(p);
  if (!text) return {};
  try {
    const parsed = parseYaml(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export interface DirEntry { name: string; path: string; size: number | null }

/**
 * The files in a directory, with their sizes, sorted by name. Both drop
 * folders, certificates waiting to be registered and SSH keys waiting to be
 * imported, are read this way, so the listing lives here rather than being
 * written out once per registry.
 */
export async function listFilesWithSize(dir: string): Promise<DirEntry[]> {
  const names = (await listFiles(dir)).sort((a, b) => a.localeCompare(b));
  const out: DirEntry[] = [];
  for (const name of names) {
    const p = join(dir, name);
    out.push({ name, path: p, size: await size(p) });
  }
  return out;
}

/** Path joining always uses POSIX semantics for remote hosts. */
export const join = (...parts: string[]): string => (remote ? path.posix.join(...parts) : path.join(...parts));
export const toPosix = (p: string): string => String(p).split(String.fromCharCode(92)).join('/');
