import * as host from './host.js';
import { toYaml } from './yaml.js';
import { slug } from './util.js';
import type { Config } from './types.js';

/**
 * Reusable SSL configurations: a certificate + key pair (a Cloudflare origin
 * certificate, most commonly) that any route in any project can point at
 * instead of automatic Let's Encrypt.
 *
 * Nothing here touches a repo, or even blankey.yml: each one lives entirely
 * under the Traefik directory blankey already manages
 * (`<traefik.dir>/certs/<name>/`), the same way a routing overlay lives under
 * `.blankey/routes` rather than in the config file. The registry is just
 * whatever subdirectories exist there. Add one, and it is immediately
 * available to every route; remove it, and it is gone everywhere at once.
 */

const CERT_FILE = 'cert.pem';
const KEY_FILE = 'key.pem';
const META_FILE = 'meta.yml';

export interface CertMeta {
  domains: string[];
}

export interface CertEntry extends CertMeta {
  name: string;
  certPath: string;
  keyPath: string;
  /** Both files are present and readable. A registered name with either one
   * missing cannot be used yet. It is surfaced rather than hidden, so a half
   * finished upload is easy to notice and finish. */
  hasFiles: boolean;
}

export function certsRoot(cfg: Config): string {
  return host.join(cfg.traefik.dir, 'certs');
}

export function certDir(cfg: Config, name: string): string {
  return host.join(certsRoot(cfg), name);
}

/**
 * A drop folder for certificate and key files, separate from `certs/` itself
 * so nothing uploaded there is mistaken for a registered SSL configuration.
 * Upload a Cloudflare origin certificate here with scp, sftp, whatever gets
 * files onto this host, and it shows up to pick from when adding one.
 */
export function incomingCertsDir(cfg: Config): string {
  return host.join(cfg.traefik.dir, 'certs-incoming');
}

/** A name safe to use as a directory and in file paths. */
export function normalizeCertName(name: string): string {
  return slug(name);
}

function certHostPaths(cfg: Config, name: string) {
  const dir = certDir(cfg, name);
  return { certFile: host.join(dir, CERT_FILE), keyFile: host.join(dir, KEY_FILE), metaFile: host.join(dir, META_FILE) };
}

/**
 * Where Traefik itself sees these files, inside the container. Fixed
 * regardless of where `traefik.dir` actually is on the host, since the whole
 * certs directory is bind-mounted there as one unit.
 */
export function certContainerPaths(name: string): { certFile: string; keyFile: string } {
  return { certFile: `/etc/traefik/certs/${name}/${CERT_FILE}`, keyFile: `/etc/traefik/certs/${name}/${KEY_FILE}` };
}

/** What is currently sitting in the drop folder, waiting to be picked. */
export const listIncoming = (cfg: Config): Promise<host.DirEntry[]> =>
  host.listFilesWithSize(incomingCertsDir(cfg));

async function readMeta(cfg: Config, name: string): Promise<CertMeta> {
  const { metaFile } = certHostPaths(cfg, name);
  const parsed = await host.readYaml(metaFile);
  const domains = Array.isArray(parsed.domains)
    ? parsed.domains.filter((d: unknown) => typeof d === 'string')
    : [];
  return { domains };
}

/** Every registered SSL configuration, found by what is actually on disk. */
export async function listCerts(cfg: Config): Promise<CertEntry[]> {
  const names = await host.listDirs(certsRoot(cfg));
  const out: CertEntry[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const { certFile, keyFile } = certHostPaths(cfg, name);
    const [hasCert, hasKey, meta] = await Promise.all([
      host.exists(certFile),
      host.exists(keyFile),
      readMeta(cfg, name),
    ]);
    out.push({ name, ...meta, certPath: certFile, keyPath: keyFile, hasFiles: hasCert && hasKey });
  }
  return out;
}

export async function getCert(cfg: Config, name: string): Promise<CertEntry | null> {
  const all = await listCerts(cfg);
  return all.find((c) => c.name === name) ?? null;
}

/**
 * Copy a certificate and key from wherever they are on the host into
 * blankey's own managed location, and record the domains it was added for
 * (purely a label; Traefik matches the certificate to a route by what is
 * actually inside it, never by this list).
 */
export async function installCert(
  cfg: Config,
  name: string,
  { certSourcePath, keySourcePath, domains }: { certSourcePath: string; keySourcePath: string; domains: string[] },
): Promise<void> {
  const cert = await host.readFile(certSourcePath);
  if (cert == null) throw new Error(`Cannot read ${certSourcePath}`);
  const key = await host.readFile(keySourcePath);
  if (key == null) throw new Error(`Cannot read ${keySourcePath}`);

  const { certFile, keyFile, metaFile } = certHostPaths(cfg, name);
  await host.mkdirp(certDir(cfg, name));
  await host.writeFile(certFile, cert);
  await host.writeFile(keyFile, key);
  await host.chmod(keyFile, 0o600);
  await host.writeFile(metaFile, toYaml({ domains }) + '\n');
  await ensureCertsDynamic(cfg);
}

/** Change just the domains label on an existing SSL configuration. */
export async function updateCertDomains(cfg: Config, name: string, domains: string[]): Promise<void> {
  const { metaFile } = certHostPaths(cfg, name);
  await host.writeFile(metaFile, toYaml({ domains }) + '\n');
}

export async function removeCert(cfg: Config, name: string): Promise<void> {
  await host.remove(certDir(cfg, name));
  await ensureCertsDynamic(cfg);
}

/** The dynamic-config file Traefik's file provider watches. */
export function certsDynamicPath(cfg: Config): string {
  return host.join(cfg.traefik.dir, 'dynamic', 'certs.yml');
}

export function renderCertsDynamic(certs: CertEntry[]): string {
  const usable = certs.filter((c) => c.hasFiles);
  const lines = [
    '# Generated by blankey. Do not edit: it is rewritten whenever an SSL',
    '# configuration is added, changed or removed.',
    '#',
    "# Traefik matches each certificate to a router by the hostname in it, the",
    '# same way it would for one issued by Let\'s Encrypt. A route just needs',
    '# tls: true and no certresolver, and whichever certificate here covers its',
    '# hostname wins automatically.',
    '',
  ];
  if (!usable.length) {
    lines.push('# No SSL configurations with both a certificate and a key yet.');
    lines.push('');
    return lines.join('\n');
  }
  lines.push('tls:');
  lines.push('  certificates:');
  for (const cert of usable) {
    const { certFile, keyFile } = certContainerPaths(cert.name);
    lines.push(`    - certFile: ${certFile}`);
    lines.push(`      keyFile: ${keyFile}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Write the dynamic file only if its contents changed, the same way a
 * routing overlay is. Traefik's file provider watches the directory and
 * reloads on its own, so there is nothing else to do to apply this.
 */
export async function ensureCertsDynamic(cfg: Config): Promise<string> {
  const target = certsDynamicPath(cfg);
  await host.writeIfChanged(target, renderCertsDynamic(await listCerts(cfg)));
  return target;
}
