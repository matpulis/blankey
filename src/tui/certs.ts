import { menu, input, confirm, notice, busy, CANCEL, type ScreenLike, type MenuItem, type Cancelled } from './widgets.js';
import { pickHostFile, discardUsedCopies, type PickedFile } from './files.js';
import { T } from './theme.js';
import { c, fg, bold } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import * as host from '../host.js';
import { discover } from '../discover.js';
import { routeSpecsFor } from '../routes.js';
import {
  listCerts, getCert, installCert, updateCertDomains, removeCert, certDir, normalizeCertName,
  incomingCertsDir, type CertEntry,
} from '../certs.js';
import type { Config } from '../types.js';

/**
 * SSL configurations: reusable certificate + key pairs, most often a
 * Cloudflare origin certificate, that any route in any project can point at
 * instead of an automatic Let's Encrypt one. See certs.ts for where they
 * actually live; nothing here touches a repo or blankey.yml.
 */

const parseDomains = (text: string): string[] => text.split(',').map((d) => d.trim()).filter(Boolean);

/** Pick a certificate or key file from the drop folder, or from a typed path. */
function pickCertFile(
  screen: ScreenLike, breadcrumb: string[], cfg: Config, label: string, help: string, exclude?: string,
): Promise<PickedFile | null | Cancelled> {
  return pickHostFile(screen, breadcrumb, {
    dir: incomingCertsDir(cfg),
    label,
    help,
    placeholder: '/root/certs/domainly.pem',
    exclude,
  });
}

/**
 * Walk through adding one SSL configuration: a name, the domains it covers
 * (a label only; Traefik matches the certificate's own content), then the
 * certificate and key files themselves.
 */
export async function addSslConfig(
  screen: ScreenLike, breadcrumb: string[], cfg: Config,
): Promise<CertEntry | Cancelled> {
  const existing = await listCerts(cfg);
  const crumb = [...breadcrumb, 'Add SSL configuration'];
  const dir = incomingCertsDir(cfg);
  await host.mkdirp(dir);

  await notice(screen, {
    breadcrumb: crumb,
    tone: 'info',
    title: 'Where to put the files',
    message: 'Upload the certificate and key to this folder first',
    detail: [
      fg(T.info, dir),
      '',
      c.muted('Copy them there however you normally get files onto this host: scp, sftp, your'),
      c.muted('provider\'s file manager. The next couple of screens list what has arrived.'),
      '',
      c.faint('Already have them somewhere else on this host? Those screens also let you type a path.'),
    ],
    action: 'Continue',
  });

  const rawName = await input(screen, {
    breadcrumb: crumb,
    label: 'Name',
    help: 'How this is picked from the list when setting up a route. Just a label, it does not have to match a domain.',
    placeholder: 'domainly',
    validate: (t) => {
      const name = normalizeCertName(t);
      if (!name) return 'Enter a name';
      if (existing.some((cert) => cert.name === name)) return `"${name}" already exists`;
      return null;
    },
  });
  if (rawName === CANCEL) return CANCEL;
  const name = normalizeCertName(rawName as string);

  const domainsRaw = await input(screen, {
    breadcrumb: crumb,
    label: 'Domains covered',
    help: 'Optional, just shown wherever this is picked from; Traefik matches the certificate itself, not this list.',
    placeholder: 'domainly.com, *.domainly.com',
  });
  if (domainsRaw === CANCEL) return CANCEL;
  const domains = parseDomains(domainsRaw as string);

  const cert = await pickCertFile(
    screen, crumb, cfg, 'Certificate file',
    'The full certificate as issued, a Cloudflare origin certificate most often.',
  );
  if (cert === CANCEL || !cert) return CANCEL;

  const key = await pickCertFile(
    screen, crumb, cfg, 'Private key file',
    'Its matching private key.',
    cert.path,
  );
  if (key === CANCEL || !key) return CANCEL;

  busy(screen, crumb, 'installing the certificate');
  try {
    await installCert(cfg, name, { certSourcePath: cert.path, keySourcePath: key.path, domains });
  } catch (e: any) {
    await notice(screen, {
      breadcrumb: crumb,
      tone: 'danger',
      title: 'Could not install it',
      message: e?.message || String(e),
      action: 'Back',
    });
    return CANCEL;
  }

  // The files are copied into managed storage now, so anything picked up from
  // the drop folder is spent.
  const tidied = await discardUsedCopies([cert, key]);

  await notice(screen, {
    breadcrumb: crumb,
    tone: 'success',
    message: `"${name}" saved`,
    detail: [
      c.faint(certDir(cfg, name)),
      '',
      c.muted('Traefik picks it up on its own: it watches this directory, so nothing needs restarting.'),
      c.muted('Any route, in any project, can use it now.'),
      ...(tidied
        ? ['', c.faint('The copies in the drop folder were removed; they are safely stored above now.')]
        : []),
    ],
    action: 'Done',
  });
  return (await getCert(cfg, name)) ?? CANCEL;
}

/** Which projects/stacks currently route through this certificate. */
async function findRoutesUsingCert(cfg: Config, name: string): Promise<string[]> {
  const { projects } = await discover(cfg).catch(() => ({ projects: [] as any[] }));
  const hits: string[] = [];
  for (const project of projects) {
    for (const stack of project.stacks) {
      const specs = routeSpecsFor(cfg, project, stack.name);
      if (specs.some((s) => s.cert === name)) {
        hits.push(project.stacks.length > 1 ? `${project.name}:${stack.name}` : project.name);
      }
    }
  }
  return hits;
}

function certDetail(cert: CertEntry): string[] {
  return [
    bold(cert.name),
    '',
    `${c.muted('domains')}   ${c.faint(cert.domains.join(', ') || 'not recorded')}`,
    `${c.muted('cert')}      ${cert.hasFiles ? c.faint(cert.certPath) : fg(T.danger, `${S.cross} missing: ${cert.certPath}`)}`,
    `${c.muted('key')}       ${cert.hasFiles ? c.faint(cert.keyPath) : fg(T.danger, `${S.cross} missing: ${cert.keyPath}`)}`,
  ];
}

/** One certificate: edit its domains label, replace the files, or remove it. */
async function manageOneCert(screen: ScreenLike, breadcrumb: string[], cfg: Config, name: string): Promise<void> {
  const crumb = [...breadcrumb, name];
  for (;;) {
    const cert = await getCert(cfg, name);
    if (!cert) return;

    const picked = await menu<string>(screen, {
      breadcrumb: crumb,
      title: name,
      items: [
        { label: 'Edit domains', hint: cert.domains.join(', ') || 'not recorded', value: 'domains' },
        { label: 'Replace the certificate and key', value: 'replace' },
        { separator: '' },
        { label: 'Remove', value: 'remove' },
      ],
      detailTitle: 'Certificate',
      filterable: false,
    });

    if (picked === CANCEL) return;

    if (picked === 'domains') {
      const raw = await input(screen, {
        breadcrumb: [...crumb, 'Domains'],
        label: 'Domains covered',
        help: 'Optional label; Traefik matches the certificate itself, not this list.',
        value: cert.domains.join(', '),
        placeholder: 'domainly.com, *.domainly.com',
      });
      if (raw !== CANCEL) await updateCertDomains(cfg, name, parseDomains(raw as string));
      continue;
    }

    if (picked === 'replace') {
      const dir = incomingCertsDir(cfg);
      await host.mkdirp(dir);
      await notice(screen, {
        breadcrumb: crumb,
        tone: 'info',
        title: 'Where to put the files',
        message: 'Upload the new certificate and key to this folder first',
        detail: [fg(T.info, dir), '', c.faint('Already have them somewhere else on this host? The next screens also let you type a path.')],
        action: 'Continue',
      });
      const newCert = await pickCertFile(screen, [...crumb, 'Replace'], cfg, 'Certificate file', 'The full certificate as issued.');
      if (newCert === CANCEL || !newCert) continue;
      const newKey = await pickCertFile(screen, [...crumb, 'Replace'], cfg, 'Private key file', 'Its matching private key.', newCert.path);
      if (newKey === CANCEL || !newKey) continue;
      busy(screen, crumb, 'installing the certificate');
      try {
        await installCert(cfg, name, { certSourcePath: newCert.path, keySourcePath: newKey.path, domains: cert.domains });
      } catch (e: any) {
        await notice(screen, { breadcrumb: crumb, tone: 'danger', title: 'Could not install it', message: e?.message || String(e), action: 'Back' });
        continue;
      }
      await discardUsedCopies([newCert, newKey]);
      await notice(screen, { breadcrumb: crumb, tone: 'success', message: `"${name}" replaced`, action: 'Done' });
      continue;
    }

    if (picked === 'remove') {
      busy(screen, crumb, 'checking for routes that use it');
      const usedBy = await findRoutesUsingCert(cfg, name);
      const go = await confirm(screen, {
        breadcrumb: crumb,
        message: `Remove "${name}"?`,
        detail: usedBy.length
          ? [
            fg(T.warn, S.warn) + ' ' + bold(`Used by ${usedBy.length} route${usedBy.length === 1 ? '' : 's'}:`),
            ...usedBy.map((x) => c.muted(`  ${x}`)),
            '',
            c.muted('Those routes stop serving HTTPS until they are pointed somewhere else.'),
          ]
          : [c.muted('Deletes the certificate and key from this host. Nothing else is touched.')],
        danger: true,
        confirmLabel: 'Remove',
        cancelLabel: 'Keep it',
      });
      if (go !== true) continue;
      busy(screen, crumb, 'removing');
      await removeCert(cfg, name);
      await notice(screen, { breadcrumb, tone: 'success', message: `"${name}" removed`, action: 'Done' });
      return;
    }
  }
}

/** The full SSL configurations screen, reached from the Traefik menu. */
export async function sslConfigsEditor(
  screen: ScreenLike, { cfg, breadcrumb = ['Traefik'] }: { cfg: Config; breadcrumb?: string[] },
): Promise<void> {
  const crumb = [...breadcrumb, 'SSL configurations'];
  for (;;) {
    busy(screen, crumb, 'reading certificates');
    const certs = await listCerts(cfg);
    const items: MenuItem<string>[] = [];

    if (certs.length) items.push({ separator: 'saved' });
    for (const cert of certs) {
      items.push({
        label: cert.name,
        hint: cert.hasFiles ? cert.domains.join(', ') : 'missing files',
        badge: cert.hasFiles ? '' : fg(T.danger, S.warn),
        value: `open:${cert.name}`,
        detail: () => certDetail(cert),
      });
    }

    items.push({ separator: '' });
    items.push({
      label: 'Add an SSL configuration',
      value: 'add',
      detail: () => [
        bold('Add an SSL configuration'),
        '',
        c.muted('A certificate and key (a Cloudflare origin certificate, most often) that any route in any project can reuse instead of automatic Let\'s Encrypt.'),
        '',
        c.muted('Upload the files to this folder first, then pick them from a list:'),
        fg(T.info, incomingCertsDir(cfg)),
      ],
    });

    const picked = await menu<string>(screen, {
      breadcrumb: crumb,
      items,
      title: 'SSL configurations',
      emptyMessage: `none yet: upload a certificate and key to ${incomingCertsDir(cfg)}, then Add an SSL configuration`,
      detailTitle: 'Certificate',
    });

    if (picked === CANCEL) return;
    if (picked === 'add') { await addSslConfig(screen, breadcrumb, cfg); continue; }
    if (typeof picked === 'string' && picked.startsWith('open:')) {
      await manageOneCert(screen, breadcrumb, cfg, picked.slice(5));
      continue;
    }
  }
}

/**
 * The TLS step of editing one route: HTTP only, automatic Let's Encrypt, or a
 * saved SSL configuration, with the option to add one on the spot.
 */
export async function pickTls(
  screen: ScreenLike, breadcrumb: string[], cfg: Config, current: { tls?: boolean; cert?: string },
): Promise<{ tls: boolean; cert?: string } | Cancelled> {
  const acmeAvailable = Boolean(cfg.traefik.acme?.email);
  const certs = await listCerts(cfg);

  const items: MenuItem<string>[] = [
    {
      label: 'HTTP only',
      hint: 'no TLS',
      value: 'off',
      badge: !current.tls ? fg(T.ok, S.tick) : '',
    },
    {
      label: "Automatic (Let's Encrypt)",
      value: 'auto',
      hint: acmeAvailable ? '' : 'no ACME email configured',
      disabled: !acmeAvailable,
      badge: current.tls && !current.cert ? fg(T.ok, S.tick) : '',
      detail: () => acmeAvailable
        ? [bold("Automatic (Let's Encrypt)"), '', c.muted('Traefik requests and renews a certificate for this hostname on its own.')]
        : [bold("Automatic (Let's Encrypt)"), '', c.muted(`Set an ACME email in Settings ${S.chevron} Let's Encrypt email to turn this on.`)],
    },
  ];
  if (certs.length) items.push({ separator: 'saved SSL configurations' });
  for (const cert of certs) {
    items.push({
      label: cert.name,
      hint: cert.hasFiles ? cert.domains.join(', ') : 'missing files',
      value: `cert:${cert.name}`,
      disabled: !cert.hasFiles,
      badge: current.cert === cert.name ? fg(T.ok, S.tick) : '',
      detail: () => certDetail(cert),
    });
  }
  items.push({ separator: '' });
  items.push({
    label: 'Add a new SSL configuration',
    value: 'add',
    detail: () => [
      bold('Add a new SSL configuration'),
      '',
      c.muted('A certificate and key this route, and any other, can reuse. Once added it is selected for this route straight away.'),
    ],
  });

  const picked = await menu<string>(screen, {
    breadcrumb: [...breadcrumb, 'HTTPS'],
    title: 'How should this be served?',
    items,
    filterable: false,
    detailTitle: 'TLS',
  });

  if (picked === CANCEL) return CANCEL;
  if (picked === 'off') return { tls: false };
  if (picked === 'auto') return { tls: true };
  if (picked === 'add') {
    const added = await addSslConfig(screen, breadcrumb, cfg);
    if (added === CANCEL) return CANCEL;
    return { tls: true, cert: (added as CertEntry).name };
  }
  if (typeof picked === 'string' && picked.startsWith('cert:')) {
    return { tls: true, cert: picked.slice(5) };
  }
  return CANCEL;
}
