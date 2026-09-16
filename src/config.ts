import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseYaml } from './yaml.js';
import * as host from './host.js';
import { fatal, log } from './ui/log.js';

export const CONFIG_NAMES = ['blankey.yml', 'blankey.yaml', '.blankey.yml', 'blankey.json'];

export const DEFAULTS = {
  projectsDir: '/srv/apps',
  domain: '',
  traefik: {
    dir: '',
    network: 'proxy',
    dashboard: true,
    dashboardHost: '',
    image: 'traefik:v3.3',
    acme: { email: '', resolver: 'le', staging: false },
    entrypoints: { web: 80, websecure: 443 },
    logLevel: 'INFO',
  },
  ssh: null,
  defaults: {
    stack: 'default',
    pull: true,
    build: 'auto',
    removeOrphans: true,
    prune: false,
    healthTimeout: 90,
    gitStrategy: 'ff-only',
    // Deploy reads this with `?? true`; stating it here keeps the settings
    // editor from presenting the safety net as switched off.
    rollbackOnFailure: true,
  },
  backup: {
    // Staging directory on the Docker host; archives are written here, uploaded,
    // then removed. Defaults to <projectsDir>/.blankey/backups.
    dir: '',
    // Three weeks, per the retention policy. Anything older is deleted.
    retentionDays: 21,
    // Never drop the last copy of a volume, however old it is: a stack that
    // stopped being backed up should not silently end up with nothing.
    keepMinimum: 1,
    prefix: 'blankey',
    // Both run on the Docker host, so nothing has to be installed there.
    archiveImage: 'alpine:3.20',
    toolImage: 'amazon/aws-cli:2',
    // Stop the stack for the duration of the backup (safest for databases).
    stopStack: false,
    schedule: { unit: 'blankey-backup', cron: '', mechanism: 'auto' },
    s3: {
      provider: '',
      bucket: '',
      region: '',
      endpoint: '',
      accessKeyId: '',
      secretAccessKey: '',
      pathStyle: false,
    },
  },
  // Noticing that a newer blankey exists. Distinct from a repo's own
  // `updates: false`, which is about pulling that project, not this tool.
  selfUpdate: {
    check: true,
    // `owner/name` on GitHub. Blank turns checking off entirely.
    repo: 'matpulis/blankey',
    // Where install.sh is served from. Derived from `repo` when left blank.
    installUrl: '',
    everyHours: 24,
  },
  ignore: ['.git', 'node_modules', 'lost+found'],
  projects: {},
};

/** Endpoint hosts for the providers this was built against. */
export const S3_PROVIDERS = {
  digitalocean: { endpoint: (r) => `https://${r}.digitaloceanspaces.com`, regions: 'nyc3, ams3, sgp1, sfo3, fra1, syd1' },
  hetzner: { endpoint: (r) => `https://${r}.your-objectstorage.com`, regions: 'fsn1, nbg1, hel1' },
};

/** Fill in the endpoint from provider + region, and read secrets from env. */
export function resolveBackup(cfg) {
  const backup = { ...DEFAULTS.backup, ...(cfg.backup || {}) };
  backup.s3 = { ...DEFAULTS.backup.s3, ...((cfg.backup && cfg.backup.s3) || {}) };
  backup.schedule = { ...DEFAULTS.backup.schedule, ...((cfg.backup && cfg.backup.schedule) || {}) };

  const provider = String(backup.s3.provider || '').toLowerCase();
  if (!backup.s3.endpoint && S3_PROVIDERS[provider] && backup.s3.region) {
    backup.s3.endpoint = S3_PROVIDERS[provider].endpoint(backup.s3.region);
  }
  // Keys are better kept out of the config file; env wins when both are set.
  backup.s3.accessKeyId = process.env.BLANKEY_S3_ACCESS_KEY_ID || backup.s3.accessKeyId || '';
  backup.s3.secretAccessKey = process.env.BLANKEY_S3_SECRET_ACCESS_KEY || backup.s3.secretAccessKey || '';
  if (!backup.s3.region && provider === 'digitalocean') backup.s3.region = 'us-east-1';
  return backup;
}

/** What is missing before a backup can run. */
export function backupProblems(backup) {
  const missing: any[] = [];
  if (!backup.s3.bucket) missing.push('backup.s3.bucket');
  if (!backup.s3.endpoint) missing.push('backup.s3.endpoint (or provider + region)');
  if (!backup.s3.accessKeyId) missing.push('backup.s3.accessKeyId (or BLANKEY_S3_ACCESS_KEY_ID)');
  if (!backup.s3.secretAccessKey) missing.push('backup.s3.secretAccessKey (or BLANKEY_S3_SECRET_ACCESS_KEY)');
  return missing;
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, override) {
  if (!isObj(base)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~' + path.sep)) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Where a per-user config goes when nobody says otherwise. */
export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'blankey', 'config.yml');
}

/** The first config that already exists, or null on a machine with none. */
export async function findExistingConfig(): Promise<string | null> {
  const fs = await import('node:fs/promises');
  for (const p of candidatePaths(undefined)) {
    try {
      await fs.access(p);
      return p;
    } catch { /* keep looking */ }
  }
  return null;
}

export function candidatePaths(explicit) {
  if (explicit) return [expandHome(explicit)];
  const list: any[] = [];
  if (process.env.BLANKEY_CONFIG) list.push(expandHome(process.env.BLANKEY_CONFIG));
  for (const name of CONFIG_NAMES) list.push(path.resolve(process.cwd(), name));
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  for (const name of ['config.yml', 'config.yaml', 'config.json']) {
    list.push(path.join(xdg, 'blankey', name));
  }
  list.push('/etc/blankey/config.yml');
  return list;
}

export function parseConfigText(text, file) {
  try {
    return file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    fatal(`Could not parse config ${file}`, { hint: e.message });
  }
}

/** Locate and load config. Returns { ...merged, __file } or null when absent. */
export async function loadConfig({ file: explicit }: { file?: string } = {}): Promise<any> {
  for (const file of candidatePaths(explicit)) {
    // Config is always read from the local filesystem, even in SSH mode.
    const text = await readLocal(file);
    if (text === null) continue;
    const raw = parseConfigText(text, file);
    const merged = normalize(deepMerge(DEFAULTS, raw));
    merged.__file = file;
    log.debug(`config loaded from ${file}`);
    return merged;
  }
  if (explicit) fatal(`Config file not found: ${explicit}`);
  return null;
}

async function readLocal(file) {
  const fs = await import('node:fs/promises');
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

export function normalize(cfg) {
  const c = { ...cfg };
  c.projectsDir = expandHome(c.projectsDir || DEFAULTS.projectsDir);
  c.traefik = { ...DEFAULTS.traefik, ...(c.traefik || {}) };
  c.traefik.dir = expandHome(c.traefik.dir) || host.join(c.projectsDir, '.blankey', 'traefik');
  c.traefik.acme = { ...DEFAULTS.traefik.acme, ...(c.traefik.acme || {}) };
  c.traefik.entrypoints = { ...DEFAULTS.traefik.entrypoints, ...(c.traefik.entrypoints || {}) };
  if (!c.traefik.dashboardHost && c.domain) c.traefik.dashboardHost = `traefik.${c.domain}`;
  c.defaults = { ...DEFAULTS.defaults, ...(c.defaults || {}) };
  c.selfUpdate = { ...DEFAULTS.selfUpdate, ...(c.selfUpdate || {}) };
  c.backup = resolveBackup(c);
  c.backup.dir = expandHome(c.backup.dir) || host.join(c.projectsDir, '.blankey', 'backups');
  c.ignore = Array.isArray(c.ignore) ? c.ignore : DEFAULTS.ignore;
  c.projects = isObj(c.projects) ? c.projects : {};
  if (c.ssh && typeof c.ssh === 'string') c.ssh = { host: c.ssh };
  if (c.ssh && c.ssh.identity) c.ssh.identity = expandHome(c.ssh.identity);
  return c;
}

export function requireConfig(cfg) {
  if (!cfg) {
    fatal('No blankey config found.', { hint: 'Run `blankey init` to create one.' });
  }
  return cfg;
}

export function renderConfig(cfg) {
  const { __file, ...rest } = cfg;
  return rest;
}
