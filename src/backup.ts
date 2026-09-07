import * as host from './host.js';
import { q, outcome, failureText, type Outcome } from './host.js';
import { pMap, lines, lastLines } from './util.js';
import { log } from './ui/log.js';

export interface BackupObject {
  key: string;
  size: number;
  lastModified?: string | null;
  at: Date | null;
}

export interface ListResult { ok: boolean; objects: BackupObject[]; error?: string }

/**
 * Volume backups to S3-compatible storage.
 *
 * Everything runs in containers on the Docker host: archiving with a small
 * image that has tar, transfer with the AWS CLI image. That means no tooling has
 * to be installed on the server, and it behaves identically when blankey is
 * driving the host over SSH, where the archive must be produced server-side
 * anyway.
 *
 * Credentials are passed through a chmod-600 env file rather than -e flags,
 * because command lines are visible to every user on the box via ps.
 */

const KEY_STAMP_RE = /(\d{8}T\d{6}Z)\.tar\.gz$/;

/** Sortable, parseable, filesystem-safe: 20260907T031500Z. */
export function stamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function parseStamp(key: unknown): Date | null {
  const m = KEY_STAMP_RE.exec(String(key || ''));
  if (!m) return null;
  const s = m[1];
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T` +
    `${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function objectKey(cfg, { project, stack, volume, at }) {
  const prefix = String(cfg.backup.prefix || 'blankey').replace(/^\/+|\/+$/g, '');
  return [prefix, project, stack, volume, `${at}.tar.gz`].filter(Boolean).join('/');
}

/** Everything under one volume's folder, used for listing and retention. */
export function volumePrefix(cfg: any, { project, stack, volume }: { project?: string; stack?: string; volume?: string } = {}): string {
  const prefix = String(cfg.backup.prefix || 'blankey').replace(/^\/+|\/+$/g, '');
  return [prefix, project, stack, volume].filter(Boolean).join('/') + (volume ? '/' : '');
}

// --------------------------------------------------------------- volumes

/**
 * The real Docker volume names behind a stack. Compose prefixes named volumes
 * with the project name, and external ones keep their own name, so the labels
 * Docker itself applies are the only reliable source.
 */
export async function stackVolumes(stack: any): Promise<string[]> {
  const r = await host.exec(
    `docker volume ls --filter label=com.docker.compose.project=${q(stack.projectName)} --format "{{.Name}}"`,
    { timeout: 30000 },
  );
  const found = r.code === 0 ? lines(r.stdout) : [];

  // External volumes carry no project label, so add any the compose file names
  // that already exist on the host.
  const declared = stack.volumes || [];
  const extra: any[] = [];
  await pMap(declared, async (name: string) => {
    const guess = `${stack.projectName}_${name}`;
    if (found.includes(guess) || found.includes(name)) return;
    const exists = await host.exec(`docker volume inspect ${q(name)} --format "{{.Name}}"`, { timeout: 15000 });
    if (exists.code === 0) extra.push(name);
  }, 4);

  return [...new Set([...found, ...extra])].sort();
}

// ------------------------------------------------------------------ s3

/**
 * Write the credentials to a private file on the host and hand back a cleanup.
 * The file is created with a restrictive umask so it is never briefly readable.
 */
async function withCredentials<T>(cfg: any, fn: (envFile: string) => Promise<T>): Promise<T> {
  const dir = cfg.backup.dir;
  const path = host.join(dir, `.s3-env-${Math.random().toString(36).slice(2, 10)}`);
  const body = [
    `AWS_ACCESS_KEY_ID=${cfg.backup.s3.accessKeyId}`,
    `AWS_SECRET_ACCESS_KEY=${cfg.backup.s3.secretAccessKey}`,
    `AWS_DEFAULT_REGION=${cfg.backup.s3.region || 'us-east-1'}`,
    `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`,
    `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required`,
    '',
  ].join('\n');

  await host.mkdirp(dir);
  // Create it empty and lock it down before the secrets go in, so it is never
  // briefly world-readable.
  await host.writeFile(path, '');
  await host.chmod(path, 0o600);
  await host.writeFile(path, body);
  try {
    return await fn(path);
  } finally {
    // Credentials must not outlive the command, whatever happened.
    await host.remove(path);
  }
}

function awsRun(cfg: any, envFile: string, args: string[], { mounts = [] }: { mounts?: string[] } = {}): string {
  const parts = [
    'docker run --rm',
    `--env-file ${q(envFile)}`,
    ...mounts,
    q(cfg.backup.toolImage),
    ...args,
    `--endpoint-url ${q(cfg.backup.s3.endpoint)}`,
  ];
  return parts.join(' ');
}

/** List every object under a prefix, following pagination. */
export async function listObjects(cfg: any, prefix: string): Promise<ListResult> {
  return withCredentials(cfg, async (envFile) => {
    const objects: BackupObject[] = [];
    let token: any = null;
    do {
      const args = [
        's3api', 'list-objects-v2',
        '--bucket', q(cfg.backup.s3.bucket),
        '--prefix', q(prefix),
        '--max-items', '1000',
        '--output', 'json',
      ];
      if (token) args.push('--starting-token', q(token));
      const r = await host.exec(awsRun(cfg, envFile, args), { timeout: 120000 });
      if (r.code !== 0) {
        return { ok: false, error: failureText(r), objects };
      }
      let page;
      try {
        page = JSON.parse(r.stdout || '{}');
      } catch {
        return { ok: false, error: 'could not parse the listing', objects };
      }
      for (const obj of page.Contents || []) {
        objects.push({
          key: obj.Key,
          size: Number(obj.Size) || 0,
          lastModified: obj.LastModified || null,
          at: parseStamp(obj.Key) || (obj.LastModified ? new Date(obj.LastModified) : null),
        });
      }
      token = page.NextToken || null;
    } while (token);
    objects.sort((a, b) => (b.at?.getTime() || 0) - (a.at?.getTime() || 0));
    return { ok: true, objects };
  });
}

export async function deleteObject(cfg: any, key: string): Promise<Outcome> {
  return withCredentials(cfg, async (envFile) => {
    const r = await host.exec(
      awsRun(cfg, envFile, ['s3api', 'delete-object', '--bucket', q(cfg.backup.s3.bucket), '--key', q(key)]),
      { timeout: 60000 },
    );
    return outcome(r);
  });
}

/** Reachability and permissions, without uploading anything. */
export async function checkAccess(cfg: any): Promise<{ ok: boolean; error?: string }> {
  return withCredentials(cfg, async (envFile) => {
    const r = await host.exec(
      awsRun(cfg, envFile, ['s3api', 'head-bucket', '--bucket', q(cfg.backup.s3.bucket)]),
      { timeout: 60000 },
    );
    if (r.code === 0) return { ok: true };
    return { ok: false, error: lastLines(failureText(r), 3) };
  });
}

// --------------------------------------------------------------- transfer

/** tar a volume into the staging directory, using a container so nothing is installed. */
export async function archiveVolume(cfg: any, volume: string, fileName: string): Promise<{ ok: boolean; size?: number | null; error?: string }> {
  await host.mkdirp(cfg.backup.dir);
  const cmd = [
    'docker run --rm',
    `-v ${q(volume + ':/data:ro')}`,
    `-v ${q(cfg.backup.dir + ':/backup')}`,
    q(cfg.backup.archiveImage),
    'tar', 'czf', q('/backup/' + fileName), '-C', '/data', '.',
  ].join(' ');
  const r = await host.exec(cmd, { timeout: 3 * 60 * 60 * 1000 });
  if (r.code !== 0) return { ok: false, error: failureText(r) };
  const size = await stagedSize(cfg, fileName);
  return { ok: true, size };
}

async function stagedSize(cfg: any, fileName: string): Promise<number | null> {
  return host.size(host.join(cfg.backup.dir, fileName));
}

export async function uploadArchive(cfg: any, fileName: string, key: string): Promise<Outcome> {
  return withCredentials(cfg, async (envFile) => {
    const r = await host.exec(
      awsRun(cfg, envFile, [
        's3', 'cp', q('/backup/' + fileName), q(`s3://${cfg.backup.s3.bucket}/${key}`), '--only-show-errors',
      ], { mounts: [`-v ${q(cfg.backup.dir + ':/backup:ro')}`] }),
      { timeout: 6 * 60 * 60 * 1000 },
    );
    return outcome(r);
  });
}

export async function downloadArchive(cfg: any, key: string, fileName: string): Promise<Outcome> {
  await host.mkdirp(cfg.backup.dir);
  return withCredentials(cfg, async (envFile) => {
    const r = await host.exec(
      awsRun(cfg, envFile, [
        's3', 'cp', q(`s3://${cfg.backup.s3.bucket}/${key}`), q('/backup/' + fileName), '--only-show-errors',
      ], { mounts: [`-v ${q(cfg.backup.dir + ':/backup')}`] }),
      { timeout: 6 * 60 * 60 * 1000 },
    );
    return outcome(r);
  });
}

/** Replace a volume's contents with an archive. Destructive by definition. */
export async function restoreVolume(cfg: any, volume: string, fileName: string): Promise<Outcome> {
  const cmd = [
    'docker run --rm',
    `-v ${q(volume + ':/data')}`,
    `-v ${q(cfg.backup.dir + ':/backup:ro')}`,
    q(cfg.backup.archiveImage),
    'sh', '-c',
    q(`rm -rf /data/..?* /data/.[!.]* /data/* 2>/dev/null; tar xzf /backup/${fileName} -C /data`),
  ].join(' ');
  const r = await host.exec(cmd, { timeout: 3 * 60 * 60 * 1000 });
  return outcome(r);
}

/**
 * Remove a staged archive. Direct removal first, then a container as a fallback:
 * the archive was written by a root container, so a non-root blankey may not be
 * able to unlink it itself.
 */
export async function removeStaged(cfg: any, fileName: string): Promise<boolean> {
  const path = host.join(cfg.backup.dir, fileName);
  if (await host.remove(path)) {
    if (!(await host.exists(path))) return true;
  }
  const r = await host.exec([
    'docker run --rm',
    `-v ${q(cfg.backup.dir + ':/backup')}`,
    q(cfg.backup.archiveImage),
    'rm', '-f', q('/backup/' + fileName),
  ].join(' '), { timeout: 60000 });
  if (r.code !== 0) log.debug(`could not remove staged archive ${fileName}: ${r.stderr}`);
  return r.code === 0;
}

// -------------------------------------------------------------- retention

/**
 * Decide what retention would remove. Pure, so the policy is testable without
 * touching a bucket: anything older than the window goes, except that the most
 * recent `keepMinimum` copies of each volume always stay.
 */
export function planRetention(objects: BackupObject[], { retentionDays = 21, keepMinimum = 1, now = new Date() }: { retentionDays?: number; keepMinimum?: number; now?: Date } = {}) {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const byVolume = new Map<string, BackupObject[]>();

  for (const obj of objects) {
    // Only ever consider objects this tool wrote: an unrecognised key under the
    // prefix is someone else's and is left alone.
    if (!KEY_STAMP_RE.test(obj.key)) continue;
    const folder = obj.key.slice(0, obj.key.lastIndexOf('/'));
    if (!byVolume.has(folder)) byVolume.set(folder, []);
    byVolume.get(folder)!.push(obj);
  }

  const remove: BackupObject[] = [];
  const keep: BackupObject[] = [];
  for (const [, list] of byVolume) {
    list.sort((a, b) => (b.at?.getTime() || 0) - (a.at?.getTime() || 0));
    list.forEach((obj, index) => {
      const age = obj.at ? obj.at.getTime() : null;
      const tooOld = age !== null && age < cutoff;
      if (tooOld && index >= keepMinimum) remove.push(obj);
      else keep.push(obj);
    });
  }
  remove.sort((a, b) => (a.at?.getTime() || 0) - (b.at?.getTime() || 0));
  return {
    remove,
    keep,
    freed: remove.reduce((sum, o) => sum + (o.size || 0), 0),
    skippedForeign: objects.filter((o) => !KEY_STAMP_RE.test(o.key)).length,
  };
}
