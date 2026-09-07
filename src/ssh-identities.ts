import * as host from './host.js';
import { toYaml } from './yaml.js';
import { slug } from './util.js';
import type { Config } from './types.js';

/**
 * SSH identities: key pairs blankey generates or imports, kept for cloning
 * and pulling private repos. Like an SSL configuration (see certs.ts), each
 * one is entirely files under blankey's own directory; nothing is written
 * into a repo, and nothing lives in blankey.yml.
 *
 * Attaching one to a project is done through git itself: `core.sshCommand`
 * in that repo's own `.git/config`, which every `git fetch`/`pull` already
 * respects on its own. That file is never tracked by git, so pointing a repo
 * at an identity never touches its working tree or shows up as a change.
 */

const PRIVATE_FILE = 'id_ed25519';
const PUBLIC_FILE = 'id_ed25519.pub';
const META_FILE = 'meta.yml';

export interface IdentityMeta {
  comment: string;
}

export interface Identity extends IdentityMeta {
  name: string;
  privatePath: string;
  publicPath: string;
  /** Both files are present. A registered name with either one missing
   * cannot be used yet. */
  hasFiles: boolean;
  /** Trimmed contents of the .pub file, which is what gets pasted as a deploy key. */
  publicKey: string | null;
  /** `ssh-keygen -lf`'s one-line summary, for telling keys apart at a glance. */
  fingerprint: string | null;
}

export function identitiesRoot(cfg: Config): string {
  return host.join(cfg.projectsDir, '.blankey', 'ssh');
}

export function identityDir(cfg: Config, name: string): string {
  return host.join(identitiesRoot(cfg), name);
}

/** A drop folder for an existing key pair, separate from the registry itself
 * so nothing uploaded there is mistaken for a registered identity. */
export function incomingIdentitiesDir(cfg: Config): string {
  return host.join(cfg.projectsDir, '.blankey', 'ssh-incoming');
}

/** What is currently sitting in the drop folder, waiting to be picked. */
export const listIncoming = (cfg: Config): Promise<host.DirEntry[]> =>
  host.listFilesWithSize(incomingIdentitiesDir(cfg));

/** A name safe to use as a directory and in file paths. */
export function normalizeIdentityName(name: string): string {
  return slug(name);
}

function paths(cfg: Config, name: string) {
  const dir = identityDir(cfg, name);
  return {
    privateFile: host.join(dir, PRIVATE_FILE),
    publicFile: host.join(dir, PUBLIC_FILE),
    metaFile: host.join(dir, META_FILE),
  };
}

async function readMeta(cfg: Config, name: string): Promise<IdentityMeta> {
  const { metaFile } = paths(cfg, name);
  const parsed = await host.readYaml(metaFile);
  return { comment: typeof parsed.comment === 'string' ? parsed.comment : '' };
}

/** Every registered identity, found by what is actually on disk. */
export async function listIdentities(cfg: Config): Promise<Identity[]> {
  const names = await host.listDirs(identitiesRoot(cfg));
  const out: Identity[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const { privateFile, publicFile } = paths(cfg, name);
    const [hasPrivate, publicKeyRaw, meta] = await Promise.all([
      host.exists(privateFile),
      host.readFile(publicFile),
      readMeta(cfg, name),
    ]);
    const publicKey = publicKeyRaw ? publicKeyRaw.trim() : null;
    const hasFiles = hasPrivate && Boolean(publicKey);
    let fingerprint: string | null = null;
    if (hasFiles) {
      const r = await host.exec(`ssh-keygen -lf ${host.q(publicFile)}`, { timeout: 10000 });
      if (r.code === 0) fingerprint = r.stdout.trim();
    }
    out.push({ name, ...meta, privatePath: privateFile, publicPath: publicFile, hasFiles, publicKey, fingerprint });
  }
  return out;
}

export async function getIdentity(cfg: Config, name: string): Promise<Identity | null> {
  const all = await listIdentities(cfg);
  return all.find((i) => i.name === name) ?? null;
}

/** Generate a fresh ed25519 key pair with no passphrase, since nothing here can type one in later. */
export async function generateIdentity(cfg: Config, name: string, { comment }: { comment?: string } = {}): Promise<void> {
  const { privateFile, metaFile } = paths(cfg, name);
  await host.mkdirp(identityDir(cfg, name));
  const label = comment || name;
  const r = await host.exec(
    `ssh-keygen -t ed25519 -N "" -C ${host.q(label)} -f ${host.q(privateFile)}`,
    { timeout: 15000 },
  );
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || 'ssh-keygen failed');
  await host.chmod(privateFile, 0o600);
  await host.writeFile(metaFile, toYaml({ comment: label }) + '\n');
}

/** Change just the comment label on an existing identity. */
export async function updateIdentityComment(cfg: Config, name: string, comment: string): Promise<void> {
  const { metaFile } = paths(cfg, name);
  await host.writeFile(metaFile, toYaml({ comment }) + '\n');
}

/**
 * Install a key pair copied in from wherever it already is on the host. The
 * public key is derived from the private one when only that is given, the
 * usual shape for a deploy key downloaded as a single file.
 */
export async function importIdentity(
  cfg: Config,
  name: string,
  { privateSourcePath, publicSourcePath, comment }: { privateSourcePath: string; publicSourcePath?: string; comment?: string },
): Promise<void> {
  const priv = await host.readFile(privateSourcePath);
  if (priv == null) throw new Error(`Cannot read ${privateSourcePath}`);

  const { privateFile, publicFile, metaFile } = paths(cfg, name);
  await host.mkdirp(identityDir(cfg, name));
  await host.writeFile(privateFile, priv.endsWith('\n') ? priv : priv + '\n');
  await host.chmod(privateFile, 0o600);

  let pub = publicSourcePath ? await host.readFile(publicSourcePath) : null;
  if (!pub) {
    const r = await host.exec(`ssh-keygen -y -f ${host.q(privateFile)}`, { timeout: 10000 });
    if (r.code !== 0) throw new Error(`Could not derive a public key from that private key: ${r.stderr || r.stdout}`);
    pub = r.stdout;
  }
  await host.writeFile(publicFile, pub.endsWith('\n') ? pub : pub + '\n');
  await host.writeFile(metaFile, toYaml({ comment: comment || name }) + '\n');
}

export async function removeIdentity(cfg: Config, name: string): Promise<void> {
  await host.remove(identityDir(cfg, name));
}

/**
 * The `ssh` command a git operation should use with this identity:
 * `-c core.sshCommand=<this>` on a clone, or written straight into an
 * existing repo's config so every later fetch and pull picks it up too.
 *
 * git tokenizes `core.sshCommand`/`GIT_SSH_COMMAND` with its own shell-like
 * rules wherever it runs, backslashes included, so a raw Windows path would
 * have them silently eaten. Forward slashes read fine to both OpenSSH and
 * Windows itself, so the path is normalized to those; quoting it also keeps
 * a space anywhere in projectsDir from splitting the command in two.
 */
export function sshCommandFor(cfg: Config, name: string): string {
  const { privateFile } = paths(cfg, name);
  return `ssh -i "${host.toPosix(privateFile)}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
}
