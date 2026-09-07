import process from 'node:process';
import * as host from './host.js';
import { parseDockerJson, pMap, unique, parseSize, lines } from './util.js';
import { log } from './ui/log.js';
import type { Container, Stack, StackSummary } from './types.js';

const q = host.q;

let cachedCompose: any = null;

/** Resolve `docker compose` vs legacy `docker-compose` once per run. */
export async function composeBin() {
  if (cachedCompose) return cachedCompose;
  const v2 = await host.exec('docker compose version --short', { timeout: 15000 });
  if (v2.code === 0) {
    cachedCompose = { cmd: 'docker compose', version: v2.stdout.trim(), v2: true };
    return cachedCompose;
  }
  const v1 = await host.exec('docker-compose version --short', { timeout: 15000 });
  if (v1.code === 0) {
    cachedCompose = { cmd: 'docker-compose', version: v1.stdout.trim(), v2: false };
    return cachedCompose;
  }
  cachedCompose = { cmd: 'docker compose', version: null, v2: true, missing: true };
  return cachedCompose;
}

export async function dockerInfo() {
  const [ver, info] = await Promise.all([
    host.exec('docker version --format "{{.Server.Version}}"', { timeout: 15000 }),
    host.exec('docker info --format "{{.ServerVersion}}|{{.Driver}}|{{.NCPU}}|{{.MemTotal}}"', { timeout: 20000 }),
  ]);
  const ok = ver.code === 0;
  const [serverVersion, driver, cpus, mem] = (info.stdout || '').split('|');
  return {
    ok,
    version: ok ? ver.stdout.trim() : null,
    error: ok ? null : (ver.stderr || 'docker not reachable'),
    serverVersion: serverVersion || null,
    driver: driver || null,
    cpus: Number(cpus) || null,
    memTotal: Number(mem) || null,
  };
}

/** Build the compose invocation for a stack (files, project name, env file, profiles). */
export async function composeArgs(stack, { env }: any = {}) {
  const bin = (await composeBin()).cmd;
  const parts = [bin];
  for (const f of stack.explicitFiles || []) parts.push('-f', q(f));
  if (stack.projectName) parts.push('-p', q(stack.projectName));
  const envFile = env || stack.envFile;
  if (envFile) parts.push('--env-file', q(envFile));
  for (const p of stack.profiles || []) parts.push('--profile', q(p));
  return parts.join(' ');
}

export async function compose(stack, args, opts = {}) {
  const base = await composeArgs(stack, opts);
  return host.exec(`${base} ${args}`, { cwd: stack.dir, ...opts });
}

export async function composeStream(stack, args, opts = {}) {
  const base = await composeArgs(stack, opts);
  return host.stream(`${base} ${args}`, { cwd: stack.dir, ...opts });
}

export async function composeInteractive(stack, args, opts = {}) {
  const base = await composeArgs(stack, opts);
  return host.interactive(`${base} ${args}`, { cwd: stack.dir, ...opts });
}

// ------------------------------------------------------------------ inspect

function parseLabels(str) {
  const out = {};
  if (!str) return out;
  for (const part of String(str).split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

const HEALTH_RE = /\((healthy|unhealthy|health: starting|starting)\)/i;

function normalizeContainer(raw) {
  const labels = typeof raw.Labels === 'string' ? parseLabels(raw.Labels) : (raw.Labels || {});
  const status = raw.Status || raw.State || '';
  const hm = HEALTH_RE.exec(status);
  const health = hm ? hm[1].toLowerCase().replace('health: ', '') : (raw.Health || '').toLowerCase() || null;
  return {
    id: (raw.ID || raw.Id || '').slice(0, 12),
    name: raw.Names || raw.Name || '',
    image: raw.Image || '',
    state: (raw.State || '').toLowerCase() || (status.startsWith('Up') ? 'running' : 'exited'),
    status,
    health: health === 'starting' ? 'starting' : health,
    ports: raw.Ports || raw.Publishers || '',
    createdAt: raw.CreatedAt || null,
    runningFor: raw.RunningFor || '',
    project: labels['com.docker.compose.project'] || null,
    service: labels['com.docker.compose.service'] || raw.Service || null,
    workdir: labels['com.docker.compose.project.working_dir'] || null,
    configFiles: labels['com.docker.compose.project.config_files'] || null,
    exitCode: Number(raw.ExitCode ?? 0) || 0,
  };
}

/**
 * Every compose-managed container on the host in one call. The dashboard reads
 * this instead of shelling out per project, so status stays O(1) in repo count.
 */
export async function listAllContainers() {
  const r = await host.exec(
    'docker ps -a --no-trunc --filter label=com.docker.compose.project --format "{{json .}}"',
    { timeout: 30000 },
  );
  if (r.code !== 0) {
    log.debug('docker ps failed: ' + r.stderr);
    return [];
  }
  return parseDockerJson(r.stdout).map(normalizeContainer);
}

export async function stackPs(stack) {
  const r = await compose(stack, 'ps -a --format json', { timeout: 30000 });
  if (r.code !== 0) return [];
  return parseDockerJson(r.stdout).map(normalizeContainer);
}

/**
 * The containers belonging to one stack, out of a host-wide listing.
 *
 * Two stacks can share a Compose project name; an overlay on top of a base
 * file is the normal case, so the project label alone is not enough. Matching
 * on the services the stack actually declares is what keeps an overlay from
 * counting the base stack's containers as its own.
 */
export function containersFor(containers: Container[], stack: Stack): Container[] {
  const declared = new Set(stack.services.map((s) => s.name));
  return containers.filter(
    (ct) => ct.project === stack.projectName && (!ct.service || declared.has(ct.service)),
  );
}

/** `containersFor` plus `summarize`, which is how every caller uses both. */
export function summarizeStack(containers: Container[], stack: Stack): StackSummary {
  return summarize(containersFor(containers, stack), stack.services.map((s) => s.name));
}

/** Roll a container list up into a one-glance health summary. */
export function summarize(containers: Container[], expectedServices: string[] = []): StackSummary {
  const running = containers.filter((c) => c.state === 'running');
  const unhealthy = containers.filter((c) => c.health === 'unhealthy');
  const starting = containers.filter((c) => c.health === 'starting');
  const exited = containers.filter((c) => c.state === 'exited' || c.state === 'dead');
  const restarting = containers.filter((c) => c.state === 'restarting');
  const total = Math.max(containers.length, expectedServices.length);
  let state: StackSummary['state'] = 'stopped';
  if (containers.length === 0) state = 'stopped';
  else if (unhealthy.length) state = 'unhealthy';
  else if (restarting.length) state = 'restarting';
  else if (running.length === 0) state = 'stopped';
  else if (running.length < total || exited.length) state = 'partial';
  else if (starting.length) state = 'starting';
  else state = 'running';
  return {
    state,
    running: running.length,
    total,
    unhealthy: unhealthy.length,
    starting: starting.length,
    exited: exited.length,
    restarting: restarting.length,
    containers,
  };
}

// ------------------------------------------------------------------ networks

export async function networkExists(name) {
  const r = await host.exec(`docker network inspect ${q(name)} --format "{{.Name}}"`, { timeout: 15000 });
  return r.code === 0;
}

export async function ensureNetwork(name) {
  if (await networkExists(name)) return { created: false };
  const r = await host.exec(`docker network create ${q(name)}`, { timeout: 30000 });
  if (r.code !== 0) throw new Error(`could not create network ${name}: ${r.stderr}`);
  return { created: true };
}

// ------------------------------------------------------------------ images

/**
 * Best-effort "is there a newer image?" check: compare the local image digest
 * against the registry manifest. Skips build-only and locally-tagged services.
 */
export async function checkImageUpdates(images, { timeout = 20000 }: any = {}) {
  const list = unique(images.filter(Boolean));
  return pMap(list, async (image) => {
    const local = await host.exec(`docker image inspect ${q(image)} --format "{{index .RepoDigests 0}}"`, { timeout });
    if (local.code !== 0) return { image, status: 'absent' };
    const localDigest = (local.stdout.split('@')[1] || '').trim();
    const remote = await host.exec(`docker manifest inspect ${q(image)} -v`, { timeout });
    if (remote.code !== 0) return { image, status: 'unknown', localDigest };
    const parsed = parseDockerJson(remote.stdout);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const remoteDigest = first?.Descriptor?.digest || first?.Digest || null;
    if (!remoteDigest || !localDigest) return { image, status: 'unknown', localDigest };
    return {
      image,
      status: remoteDigest === localDigest ? 'current' : 'outdated',
      localDigest,
      remoteDigest,
    };
  }, 4);
}

/**
 * Work out which file on disk holds a container's logs.
 *
 * Only the file-based drivers can be cleared: json-file exposes the path
 * directly, `local` keeps it under the Docker root, and everything else
 * (journald, syslog, a shipper) stores logs somewhere blankey has no business
 * truncating. Split out from the command so the decision is testable.
 */
export interface LogTarget { driver: string; id: string; paths: string[] }
export interface LogTargetResult extends Partial<LogTarget> { ok: boolean; reason?: string; detail?: string }

export function parseLogTarget(inspectLine: string, dockerRootDir?: string): LogTarget {
  const [driver = '', logPath = '', id = ''] = String(inspectLine || '').trim().split('|');
  const clean = logPath === '<no value>' ? '' : logPath;
  if (clean) return { driver, id, paths: [clean] };
  if (driver === 'local' && dockerRootDir && id) {
    return { driver, id, paths: [`${dockerRootDir.replace(/\/+$/, '')}/containers/${id}/local-logs/container.log`] };
  }
  return { driver, id, paths: [] };
}

export async function logTarget(name: string): Promise<LogTargetResult> {
  const info = await host.exec(
    `docker inspect --format "{{.HostConfig.LogConfig.Type}}|{{.LogPath}}|{{.Id}}" ${q(name)}`,
    { timeout: 15000 },
  );
  if (info.code !== 0) return { ok: false, reason: 'inspect', detail: info.stderr };
  let root = '';
  if (!info.stdout.includes('/') && info.stdout.includes('local')) {
    const r = await host.exec('docker info --format "{{.DockerRootDir}}"', { timeout: 15000 });
    if (r.code === 0) root = r.stdout.trim();
  }
  const target = parseLogTarget(info.stdout, root);
  return { ok: true, ...target };
}

const DENIED_RE = /permission denied|not permitted|operation not permitted|eacces/i;

/**
 * Container log files live inside the Docker host. When that host is this
 * Windows machine they sit in a VM, so there is nothing here to read or
 * truncate, so both sizing and clearing have to say so rather than report zero.
 */
const logFilesReachable = (): boolean => host.isRemote() || process.platform !== 'win32';

/**
 * Truncate a container's log file in place. Docker keeps the file handle open,
 * so emptying it is safe while the container runs; deleting it is not.
 */
export async function clearContainerLogs(name: string): Promise<{ ok: boolean; reason?: string; driver?: string; detail?: string; paths?: string[]; cleared?: number | null; sudo?: boolean }> {
  if (!logFilesReachable()) return { ok: false, reason: 'unsupported' };

  const target = await logTarget(name);
  if (!target.ok) return { ok: false, reason: 'inspect', detail: target.detail };
  if (!target.paths || !target.paths.length) return { ok: false, reason: 'driver', driver: target.driver };

  const before = await host.size(target.paths[0]!);
  // `: > file` is plain shell, so this needs no coreutils on the host.
  const truncate = target.paths.map((p) => `: > ${q(p)}`).join(' && ');

  let r = await host.exec(truncate, { timeout: 30000 });
  let sudo = false;

  // Only escalate for an actual permission problem: retrying anything else
  // under sudo just swaps one error message for a more confusing one.
  if (r.code !== 0 && DENIED_RE.test(r.stderr || r.stdout || '')) {
    const escalated = await host.exec(`sudo -n sh -c ${q(truncate)}`, { timeout: 30000 });
    if (escalated.code === 0) {
      r = escalated;
      sudo = true;
    } else {
      return { ok: false, reason: 'permission', detail: escalated.stderr || r.stderr, paths: target.paths };
    }
  }
  if (r.code !== 0) {
    return { ok: false, reason: 'failed', detail: r.stderr || r.stdout, paths: target.paths };
  }
  return { ok: true, driver: target.driver, cleared: before, sudo, paths: target.paths };
}

/**
 * Survey everything that could be reclaimed, without changing a thing.
 *
 * Each entry carries the count, the bytes it would free and the command that
 * would free them, so `blankey clean` can show the bill before charging it.
 * Sizes come from Docker's own accounting where it has it, and from summing
 * objects where it does not.
 */
export interface ReclaimTarget {
  key: string;
  label: string;
  count: number;
  bytes: number;
  command: string | null;
  destructive: boolean;
  note: string;
  items?: string[];
  logs?: any[];
  skipped?: any[];
  unsupported?: boolean;
}

export async function surveyReclaimable({ includeLogs = true }: { includeLogs?: boolean } = {}): Promise<{ targets: ReclaimTarget[]; df: any }> {
  const [df, stopped, dangling, unusedImages, volumes, networks] = await Promise.all([
    diskUsage(),
    listStopped(),
    listDangling(),
    listUnusedImages(),
    listUnusedVolumes(),
    listUnusedNetworks(),
  ]);

  const dfRow = (type) => (df || []).find((r) => new RegExp(type, 'i').test(String(r.Type || '')));
  const cacheRow = dfRow('Build Cache');

  const targets: ReclaimTarget[] = [
    {
      key: 'containers',
      label: 'stopped containers',
      count: stopped.length,
      bytes: stopped.reduce((sum, ct) => sum + ct.bytes, 0),
      items: stopped.map((ct) => ct.name),
      command: 'docker container prune -f' as string | null,
      destructive: false,
      note: 'containers that exited and were never removed',
    },
    {
      key: 'images',
      label: 'dangling images',
      count: dangling.count,
      bytes: dangling.bytes,
      command: 'docker image prune -f',
      destructive: false,
      note: 'untagged layers left behind by rebuilds',
    },
    {
      key: 'unused-images',
      label: 'unused images',
      count: unusedImages.count,
      bytes: unusedImages.bytes,
      command: 'docker image prune -a -f',
      destructive: false,
      note: 'every image no container references, tagged or not',
    },
    {
      key: 'cache',
      label: 'build cache',
      count: cacheRow ? Number(cacheRow.TotalCount ?? 0) || 0 : 0,
      bytes: parseSize(cacheRow ? cacheRow.Reclaimable : 0),
      command: 'docker builder prune -f',
      destructive: false,
      note: 'rebuilds get slower until it warms up again',
    },
    {
      key: 'volumes',
      label: 'unused volumes',
      count: volumes.length,
      bytes: volumes.reduce((sum, v) => sum + v.bytes, 0),
      items: volumes.map((v) => v.name),
      command: 'docker volume prune -f',
      destructive: true,
      note: 'DATA LOSS: a volume no container uses may still hold your database',
    },
    {
      key: 'networks',
      label: 'unused networks',
      count: networks.length,
      bytes: 0,
      items: networks,
      command: 'docker network prune -f',
      destructive: false,
      note: 'frees no disk, just tidies',
    },
  ];

  if (includeLogs) {
    const logs = await surveyLogs();
    targets.push({
      key: 'logs',
      label: 'container logs',
      count: logs.count,
      bytes: logs.bytes,
      items: logs.items.map((l) => l.name),
      command: null as string | null,
      destructive: false,
      note: logs.unsupported
        ? 'log files sit on the Docker host, unreadable from here'
        : 'truncated in place, running containers keep logging',
      logs: logs.items,
      skipped: logs.skipped,
      unsupported: Boolean(logs.unsupported),
    });
  }

  return { targets, df };
}

/**
 * Rows from a `--format "{{.A}}|{{.B}}"` listing, split back into their fields.
 * Nothing docker prints in these columns contains a pipe.
 */
function pipeRows(result: { code: number; stdout: string }): string[][] {
  return result.code === 0 ? lines(result.stdout).map((line) => line.split('|')) : [];
}

async function listStopped() {
  // -s adds the writable-layer size, which is what removing them actually frees.
  const r = await host.exec(
    'docker ps -a -s --filter status=exited --filter status=dead --filter status=created --format "{{.Names}}|{{.Size}}"',
    { timeout: 60000 },
  );
  return pipeRows(r).map(([name, size]) => ({ name: name ?? '', bytes: parseSize(size) }));
}

async function imageBytes(ids) {
  if (!ids.length) return 0;
  const r = await host.exec(
    `docker image inspect ${ids.map(q).join(' ')} --format "{{.Size}}"`,
    { timeout: 60000 },
  );
  if (r.code !== 0) return 0;
  return r.stdout.split('\n').reduce((sum, n) => sum + (Number(n.trim()) || 0), 0);
}

async function listDangling() {
  const r = await host.exec('docker images -f dangling=true --format "{{.ID}}"', { timeout: 30000 });
  if (r.code !== 0) return { count: 0, bytes: 0 };
  const ids = unique(lines(r.stdout));
  return { count: ids.length, bytes: await imageBytes(ids) };
}

/** Images no container references, which is what `image prune -a` would remove. */
async function listUnusedImages() {
  const [all, used] = await Promise.all([
    host.exec('docker images --no-trunc --format "{{.ID}}"', { timeout: 30000 }),
    host.exec('docker ps -a --no-trunc --format "{{.Image}}"', { timeout: 30000 }),
  ]);
  if (all.code !== 0) return { count: 0, bytes: 0 };
  const inUse = new Set(used.code === 0 ? lines(used.stdout) : []);
  if (inUse.size) {
    // Container Image can be a tag, so resolve those to ids before comparing.
    const resolved = await host.exec(
      `docker image inspect ${[...inUse].map(q).join(' ')} --format "{{.Id}}" 2>/dev/null`,
      { timeout: 60000 },
    );
    for (const id of lines(resolved.stdout)) inUse.add(id);
  }
  const ids = unique(lines(all.stdout)).filter((id) => !inUse.has(id));
  return { count: ids.length, bytes: await imageBytes(ids) };
}

async function listUnusedVolumes() {
  const r = await host.exec('docker volume ls -f dangling=true --format "{{.Name}}"', { timeout: 30000 });
  if (r.code !== 0) return [];
  const names = lines(r.stdout);
  if (!names.length) return [];
  // Only `system df -v` knows volume sizes; fall back to unknown rather than lying.
  const sizes = await host.exec('docker system df -v --format "{{json .Volumes}}"', { timeout: 60000 });
  const bySize = new Map();
  for (const v of parseDockerJson(sizes.stdout).flat()) {
    if (v && v.Name) bySize.set(v.Name, parseSize(v.Size));
  }
  return names.map((name) => ({ name, bytes: bySize.get(name) || 0 }));
}

async function listUnusedNetworks() {
  const r = await host.exec(
    'docker network ls --filter type=custom --format "{{.Name}}|{{.ID}}"',
    { timeout: 30000 },
  );
  const idle: any[] = [];
  await pMap(pipeRows(r), async ([name, id]) => {
    const used = await host.exec(
      `docker network inspect ${q(id)} --format "{{len .Containers}}"`,
      { timeout: 20000 },
    );
    if (used.code === 0 && used.stdout.trim() === '0') idle.push(name);
  }, 6);
  return idle.sort();
}

/** Add up what every container log file is holding. */
export async function surveyLogs(): Promise<{ count: number; bytes: number; items: any[]; skipped: any[]; unsupported?: boolean }> {
  if (!logFilesReachable()) return { count: 0, bytes: 0, items: [], skipped: [], unsupported: true };
  const containers = await listAllContainers();
  const items: any[] = [];
  const skipped: any[] = [];
  await pMap(containers, async (ct) => {
    const target = await logTarget(ct.name);
    if (!target.ok || !target.paths || !target.paths.length) {
      skipped.push({ name: ct.name, driver: target.driver || 'unknown' });
      return;
    }
    // Sized on the Docker host: these files live there, not necessarily on the
    // machine running blankey.
    const r = await host.exec(host.sizeCommand(target.paths[0]!), { timeout: 15000 });
    const bytes = Number(String(r.stdout).trim());
    if (Number.isFinite(bytes) && bytes > 0) items.push({ name: ct.name, service: ct.service, bytes });
  }, 6);
  items.sort((a, b) => b.bytes - a.bytes);
  return { count: items.length, bytes: items.reduce((s, x) => s + x.bytes, 0), items, skipped };
}

/** Memory each running container is holding, so "or memory" has an answer too. */
export async function memoryUsage() {
  const r = await host.exec(
    'docker stats --no-stream --format "{{.Name}}|{{.MemUsage}}|{{.MemPerc}}|{{.CPUPerc}}"',
    { timeout: 60000 },
  );
  return pipeRows(r)
    .map(([name, mem, memPerc, cpu]) => ({ name, bytes: parseSize(mem), mem, memPerc, cpu }))
    .sort((a, b) => b.bytes - a.bytes);
}

export async function diskUsage() {
  const r = await host.exec('docker system df --format "{{json .}}"', { timeout: 30000 });
  if (r.code !== 0) return null;
  return parseDockerJson(r.stdout);
}

export async function stats(names) {
  if (!names.length) return [];
  const r = await host.exec(
    `docker stats --no-stream --format "{{json .}}" ${names.map(q).join(' ')}`,
    { timeout: 30000 },
  );
  if (r.code !== 0) return [];
  return parseDockerJson(r.stdout);
}

/** Ports already bound on the host, used by `blankey doctor` conflict checks. */
export async function usedHostPorts() {
  const r = await host.exec('docker ps --format "{{.Ports}}"', { timeout: 20000 });
  if (r.code !== 0) return new Map();
  const map = new Map();
  for (const line of r.stdout.split('\n')) {
    for (const m of line.matchAll(/(?:([0-9.]+|\[::\]):)?(\d+)->(\d+)\/(tcp|udp)/g)) {
      map.set(`${m[2]}/${m[4]}`, m[3]);
    }
  }
  return map;
}

export { q };
