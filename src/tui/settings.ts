import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import process from 'node:process';
import { menu, input, confirm, notice, CANCEL, busy, type ScreenLike, type MenuItem } from './widgets.js';
import { c, fg, P, bold } from '../ui/colors.js';
import { S } from '../ui/symbols.js';
import { toYaml, parseYaml } from '../yaml.js';
import { DEFAULTS, S3_PROVIDERS, expandHome, defaultConfigPath } from '../config.js';

/**
 * One description of every setting, used by both the first-run wizard and the
 * settings editor, so the two can never drift. `help` doubles as the comment
 * written above the key in the generated config file.
 */
export type FieldType = 'text' | 'password' | 'boolean' | 'select' | 'number';

export interface SchemaChoice {
  value: string;
  label: string;
  hint?: string;
  /** Extra lines for this option's detail pane. */
  detail?: string[];
}

export interface SchemaField {
  key: string;
  label: string;
  type: FieldType;
  essential?: boolean;
  required?: boolean;
  help?: string | ((values: Record<string, any>) => string);
  placeholder?: string;
  options?: string[];
  /** Labelled alternative to `options`, with per-option explanations. */
  choices?: SchemaChoice[];
  /** Background shown beside the question during setup. */
  explain?: string[];
  /**
   * Only ask for, show and write this setting when the predicate holds, so the
   * wizard never asks about a bucket when there is no provider.
   */
  when?: (values: Record<string, any>) => boolean;
  section?: undefined;
}

export interface SchemaSection {
  section: string;
  key?: undefined;
  label?: undefined;
}

export type SchemaEntry = SchemaField | SchemaSection;

export const SCHEMA: SchemaEntry[] = [
  { section: 'Projects' },
  {
    key: 'projectsDir',
    label: 'Projects directory',
    type: 'text',
    essential: true,
    required: true,
    help: 'Folder holding one directory per repo.',
    placeholder: '/srv/apps',
  },
  {
    key: 'domain',
    label: 'Base domain',
    type: 'text',
    help: 'Optional. Only used to suggest hostnames in scaffolding; every project sets its own in its compose labels.',
    placeholder: 'example.com',
  },

  { section: 'Docker host' },
  {
    key: 'ssh.host',
    label: 'SSH host',
    type: 'text',
    essential: true,
    help: 'Drive a remote Docker host. Leave blank to use the local one.',
    placeholder: 'root@1.2.3.4',
  },

  { section: 'Traefik' },
  { key: 'traefik.network', label: 'Proxy network', type: 'text', help: 'Shared external network every routed container joins.' },
  { key: 'traefik.image', label: 'Traefik image', type: 'text' },
  { key: 'traefik.dashboardHost', label: 'Dashboard host', type: 'text', placeholder: 'traefik.example.com' },
  {
    key: 'traefik.acme.email',
    label: "Let's Encrypt email",
    type: 'text',
    help: 'One account address for the shared certificate resolver. Which hostnames actually get a certificate is chosen per project, with traefik labels. Blank turns TLS off entirely.',
  },
  { key: 'traefik.acme.staging', label: "Use Let's Encrypt staging", type: 'boolean', help: 'True while testing, to avoid rate limits.' },

  { section: 'Deployments' },
  { key: 'defaults.gitStrategy', label: 'Git strategy', type: 'select', options: ['ff-only', 'rebase', 'reset'], help: 'How a deploy moves the repo forward.' },
  { key: 'defaults.rollbackOnFailure', label: 'Roll back on failure', type: 'boolean', help: 'Revert to the previous commit when a deploy fails its health check.' },
  { key: 'defaults.healthTimeout', label: 'Health timeout (seconds)', type: 'number' },
  { key: 'defaults.prune', label: 'Prune images after deploy', type: 'boolean' },

  { section: 'Backups' },
  {
    key: 'backup.s3.provider',
    label: 'Off-site backups',
    type: 'select',
    essential: true,
    help: 'Where volume backups get uploaded.',
    explain: [
      'blankey can archive the Docker volumes behind your stacks (databases, uploads, anything a container keeps) and upload them to S3-compatible object storage, on demand or on a nightly schedule.',
      '',
      'This is the only undo you have for data. A deploy can roll code back, but nothing brings back a dropped database.',
      '',
      'Archiving and upload both run in containers on the Docker host, so nothing extra has to be installed there.',
      '',
      'Skipping is fine. Settings can turn it on at any time.',
    ],
    choices: [
      {
        value: '',
        label: 'Not now',
        detail: [
          'Nothing is backed up until a bucket is configured, and no further questions are asked.',
          '',
          'Everything else works as normal.',
        ],
      },
      {
        value: 'hetzner',
        label: 'Hetzner Object Storage',
        detail: [
          `Regions: ${S3_PROVIDERS.hetzner.regions}.`,
          '',
          'The endpoint is worked out from the region you pick next.',
        ],
      },
      {
        value: 'digitalocean',
        label: 'DigitalOcean Spaces',
        detail: [
          `Regions: ${S3_PROVIDERS.digitalocean.regions}.`,
          '',
          'The endpoint is worked out from the region you pick next.',
        ],
      },
      {
        value: 'custom',
        label: 'Other S3-compatible',
        detail: [
          'MinIO, Backblaze B2, Wasabi, AWS S3 itself, or anything else that speaks the S3 API.',
          '',
          'You will be asked for the endpoint URL yourself.',
        ],
      },
    ],
  },
  {
    key: 'backup.s3.endpoint',
    label: 'Endpoint URL',
    type: 'text',
    essential: true,
    required: true,
    placeholder: 'https://s3.example.com',
    help: 'The S3 API endpoint of your storage service.',
    when: (v) => v['backup.s3.provider'] === 'custom',
  },
  {
    key: 'backup.s3.region',
    label: 'Region',
    type: 'text',
    essential: true,
    required: true,
    help: (v) => {
      const provider = v['backup.s3.provider'];
      const known = S3_PROVIDERS[provider as keyof typeof S3_PROVIDERS];
      return known
        ? `Available regions: ${known.regions}.`
        : 'Whatever region your storage service expects. us-east-1 is a common default.';
    },
    when: (v) => Boolean(v['backup.s3.provider']),
  },
  {
    key: 'backup.s3.bucket',
    label: 'Bucket',
    type: 'text',
    essential: true,
    required: true,
    help: 'An existing bucket. blankey writes under a prefix inside it and never creates the bucket for you.',
    when: (v) => Boolean(v['backup.s3.provider']),
  },
  {
    key: 'backup.s3.accessKeyId',
    label: 'Access key ID',
    type: 'password',
    help: 'Better set as BLANKEY_S3_ACCESS_KEY_ID in the environment, so it stays out of the config file.',
    when: (v) => Boolean(v['backup.s3.provider']),
  },
  {
    key: 'backup.s3.secretAccessKey',
    label: 'Secret access key',
    type: 'password',
    help: 'Better set as BLANKEY_S3_SECRET_ACCESS_KEY in the environment.',
    when: (v) => Boolean(v['backup.s3.provider']),
  },
  {
    key: 'backup.retentionDays',
    label: 'Keep backups for (days)',
    type: 'number',
    help: 'Older backups are deleted after each run. The newest copy of every volume is always kept.',
    when: (v) => Boolean(v['backup.s3.provider']),
  },
];

const FIELDS: SchemaField[] = SCHEMA.filter((f): f is SchemaField => f.key !== undefined);

/** Which section heading a field falls under. */
function sectionOf(field: SchemaField): string | undefined {
  const at = SCHEMA.indexOf(field);
  for (let i = at; i >= 0; i--) {
    const entry = SCHEMA[i]!;
    if (entry.section !== undefined) return entry.section;
  }
  return undefined;
}

/**
 * Whether a setting applies given what else has been chosen. A field with no
 * predicate always applies; one that does not apply is never asked for, shown
 * or written.
 */
/** Help text, resolved against the answers given so far. */
export function helpFor(field: SchemaField, values: Record<string, any>): string {
  return typeof field.help === 'function' ? field.help(values) : (field.help ?? '');
}

export function isVisible(field: SchemaField, values: Record<string, any>): boolean {
  return field.when ? Boolean(field.when(values)) : true;
}

/** The questions setup should ask, given the answers so far. */
export function essentialSteps(values: Record<string, any>): SchemaField[] {
  return FIELDS.filter((f) => f.essential && isVisible(f, values));
}

export function getPath(obj: any, dotted: string): any {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Remove a dotted key, and any container it leaves empty. */
export function deletePath(obj: any, dotted: string): void {
  const parts = dotted.split('.');
  const last = parts.pop()!;
  let node = obj;
  for (const part of parts) {
    if (!node || typeof node !== 'object' || !(part in node)) return;
    node = node[part];
  }
  if (node && typeof node === 'object') delete node[last];
}

export function setPath(obj: any, dotted: string, value: any): any {
  const parts = dotted.split('.') as string[];
  let node = obj;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]!] = value;
  return obj;
}

/** Flatten a loaded config into the editable value map the form works on. */
export function valuesFrom(cfg: any): Record<string, any> {
  const values: Record<string, any> = {};
  for (const field of FIELDS) {
    const current = getPath(cfg || {}, field.key);
    const fallback = getPath(DEFAULTS, field.key);
    values[field.key] = current ?? fallback ?? (field.type === 'boolean' ? false : '');
  }
  return values;
}

const isEmpty = (v) => v === '' || v === null || v === undefined;

/** Drop empty branches so the written file stays free of noise. */
function prune(node: any): any {
  if (Array.isArray(node)) return node;
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(node)) {
    const cleaned = prune(v);
    if (isEmpty(cleaned)) continue;
    if (typeof cleaned === 'object' && !Array.isArray(cleaned) && !Object.keys(cleaned).length) continue;
    out[k] = cleaned;
  }
  return out;
}

/**
 * Emit the config file, using each field's help text as the comment above it.
 * Comments are inserted by walking the emitted YAML and tracking the path, so
 * the schema stays the single source of truth.
 */
/**
 * Emit the config file.
 *
 * `base` is the file as it is on disk. The editor only knows about the settings
 * in its schema, so everything else, such as per-project routing, ignore lists and tuning
 * nobody has put on a screen yet, is carried through untouched. Building the
 * file from the schema alone would silently delete all of it.
 */
export function renderConfigFile(values: Record<string, any>, base: Record<string, any> = {}): string {
  const tree: Record<string, any> = structuredClone(base ?? {});
  for (const field of FIELDS) {
    const value = values[field.key];
    // A bucket left over from a provider that was since turned off would
    // otherwise be written as live configuration.
    if (isEmpty(value) || !isVisible(field, values)) {
      deletePath(tree, field.key);
      continue;
    }
    setPath(tree, field.key, field.type === 'number' ? Number(value) : value);
  }
  const pruned = prune(tree);
  const yaml = toYaml(pruned).split('\n');

  const help = new Map(
    FIELDS.filter((f) => f.help).map((f) => [f.key, helpFor(f, values)]),
  );
  const out = [
    '# blankey configuration',
    '# Rewritten when you save from the settings editor. Settings the editor does',
    '# not show, such as per-project routes, are carried through unchanged.',
    '# Comments you add by hand are not.',
    '',
  ];

  const stack: string[] = [];
  for (const line of yaml) {
    if (!line.trim()) { out.push(line); continue; }
    const indent = line.length - line.trimStart().length;
    const depth = Math.floor(indent / 2);
    const keyMatch = /^\s*([A-Za-z0-9_.-]+):/.exec(line);
    if (keyMatch) {
      stack.length = depth;
      stack[depth] = keyMatch[1]!;
      const dotted = stack.slice(0, depth + 1).join('.');
      if (depth === 0 && out[out.length - 1] !== '') out.push('');
      const comment = help.get(dotted);
      if (comment) out.push(' '.repeat(indent) + '# ' + comment);
    }
    out.push(line);
  }
  out.push('');
  return out.join('\n');
}

/** Shorten a path under the home directory for display. */
export function tilde(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Options for a select, whether it was written as `choices` or plain `options`. */
function choicesFor(field: SchemaField): SchemaChoice[] {
  if (field.choices) return field.choices;
  return (field.options ?? []).map((opt) => ({ value: opt, label: opt === '' ? '(none)' : opt }));
}

function choiceItems(field: SchemaField, current: any, { showCurrent = true } = {}): MenuItem<string>[] {
  return choicesFor(field).map((choice) => ({
    label: choice.label,
    hint: choice.hint ?? '',
    value: choice.value,
    badge: showCurrent && choice.value === current ? fg(P.ok, S.tick) : '',
    detail: () => [
      ...(field.explain ? field.explain.map((l) => c.muted(l)) : []),
      ...(field.explain && choice.detail ? [''] : []),
      ...(choice.detail ? [bold(choice.label), '', ...choice.detail.map((l) => c.muted(l))] : []),
    ],
  }));
}

async function editField(screen: ScreenLike, breadcrumb: string[], field: SchemaField, current: any, values: Record<string, any> = {}): Promise<any> {
  if (field.type === 'boolean') return !current;

  if (field.type === 'select') {
    const picked = await menu<string>(screen, {
      breadcrumb: [...breadcrumb, field.label],
      title: field.label,
      items: choiceItems(field, current),
      filterable: false,
      detailTitle: field.explain ? 'Why this matters' : 'About',
    });
    return picked === CANCEL ? current : picked;
  }

  const value = await input(screen, {
    breadcrumb: [...breadcrumb, field.label],
    label: field.label,
    help: helpFor(field, values),
    value: current === undefined || current === null ? '' : String(current),
    placeholder: field.placeholder || '',
    mask: field.type === 'password',
    validate: (text) => {
      if (field.required && !text.trim()) return `${field.label} is required`;
      if (field.type === 'number' && text && Number.isNaN(Number(text))) return 'Enter a number';
      return null;
    },
  });
  if (value === CANCEL) return current;
  return field.type === 'number' && value !== '' ? Number(value) : value;
}

function displayValue(field: SchemaField, value: any): string {
  if (field.type === 'boolean') {
    return value ? fg(P.ok, 'on') : c.faint('off');
  }
  if (field.type === 'select') {
    // Show the label the user picked, not the value stored in the file.
    const choice = choicesFor(field).find((x) => x.value === value);
    if (choice) return isEmpty(value) ? c.faint(choice.label) : c.muted(choice.label);
  }
  // The placeholder belongs on the edit screen; showing it here reads as if the
  // setting already has that value.
  if (isEmpty(value)) return c.faint('not set');
  if (field.type === 'password') return c.faint('•'.repeat(Math.min(12, String(value).length)));
  return c.muted(String(value));
}

/** The settings editor: every field, editable, saved on demand. */
export async function settingsEditor(
  screen: ScreenLike,
  { cfg, filePath, breadcrumb = ['Settings'], sections, title = 'Settings' }:
  { cfg: any; filePath?: string; breadcrumb?: string[]; sections?: string[]; title?: string },
) {
  const values = valuesFrom(cfg);
  const original = JSON.stringify(values);
  let target = filePath || cfg?.__file || defaultConfigPath();
  let index = 0;

  for (;;) {
    const dirty = JSON.stringify(values) !== original;
    // Scoped to the sections this screen was opened for, so Traefik settings
    // live one step from the Traefik menu instead of a separate top-level list.
    let currentSection: string | undefined;
    const items: MenuItem<string>[] = [];
    for (const entry of SCHEMA) {
      if (entry.section !== undefined) { currentSection = entry.section; continue; }
      if (sections && !sections.includes(currentSection!)) continue;
      // Settings that do not apply are dropped rather than shown as dead ends.
      if (!isVisible(entry, values)) continue;
      if (sections && sections.length > 1 && !items.some((it) => it.separator === currentSection)) {
        items.push({ separator: currentSection });
      }
      items.push({
        label: entry.label,
        hint: displayValue(entry, values[entry.key]),
        value: entry.key,
        keywords: entry.key,
      });
    }
    items.push({ separator: 'File' });
    items.push({ label: 'Save to', hint: c.faint(target), value: '__path' });
    items.push({ label: dirty ? 'Save changes' : 'Save (no changes)', value: '__save', badge: dirty ? fg(P.warn, S.dot) : '' });

    const picked = await menu(screen, {
      breadcrumb,
      items,
      initial: index,
      title,
      footer: [
        [`${S.up}${S.down}`, 'move'], ['enter', 'edit'],
        ['type', 'filter'], ['esc', dirty ? 'discard' : 'back'],
      ],
    });

    if (picked === CANCEL) {
      if (!dirty) return { saved: false };
      const discard = await confirm(screen, {
        breadcrumb,
        message: 'Discard your changes?',
        detail: [c.muted('Nothing has been written to disk yet.')],
        danger: true,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
      });
      if (discard === true) return { saved: false };
      continue;
    }

    if (picked === '__path') {
      const next = await input(screen, {
        breadcrumb: [...breadcrumb, 'Save to'],
        label: 'Config file path',
        value: target,
        help: 'Where this configuration is written.',
      });
      if (next !== CANCEL && next.trim()) target = expandHome(next.trim());
      continue;
    }

    if (picked === '__save') {
      // Only the fields on screen block saving here: a required backup field
      // left blank must not stop someone saving an unrelated Deploy setting.
      const scoped = sections ? FIELDS.filter((f) => sectionOf(f) && sections.includes(sectionOf(f)!)) : FIELDS;
      const problems = scoped.filter((f) => f.required && isVisible(f, values) && isEmpty(values[f.key]));
      if (problems.length) {
        await notice(screen, {
          breadcrumb,
          tone: 'danger',
          title: 'Cannot save yet',
          message: `${problems.length} setting${problems.length === 1 ? '' : 's'} still needed`,
          detail: [
            ...problems.map((f) => `${c.err(S.cross)} ${bold(f.label)}`),
            '',
            c.muted('Fill these in, then save again.'),
          ],
          action: 'Back to settings',
        });
        continue;
      }
      busy(screen, breadcrumb, `writing ${target}`);
      await writeConfigFile(target, values);
      await notice(screen, {
        breadcrumb,
        tone: 'success',
        message: 'Settings saved',
        detail: [c.faint(tilde(target)), '', c.muted('Reloaded straight away.')],
        action: 'Done',
      });
      return { saved: true, path: target };
    }

    const field = FIELDS.find((f) => f.key === picked);
    index = items.findIndex((it) => it.value === picked);
    if (field) values[field.key] = await editField(screen, breadcrumb, field, values[field.key], values);
  }
}

/**
 * The "here is what you chose" list both wizards show before writing, with the
 * labels aligned so the values read as a column.
 */
function settingsSummary(fields: SchemaField[], values: Record<string, any>): string[] {
  const labelWidth = Math.max(0, ...fields.map((f) => f.label.length));
  return fields.map((f) => `${c.muted(f.label.padEnd(labelWidth))}  ${displayValue(f, values[f.key])}`);
}

/**
 * First run: a short guided pass over the essential settings, then save.
 * Deliberately smaller than the full editor, since everything else has a sane
 * default and can be changed later from Settings.
 */
export async function setupWizard(screen: ScreenLike, { cfg }: { cfg?: any } = {}): Promise<{ saved: boolean; path?: string }> {
  const values = valuesFrom(cfg);
  const breadcrumb = ['Setup'];

  const intro = await confirm(screen, {
    breadcrumb,
    message: 'No configuration found. Set blankey up now?',
    detail: [
      c.muted('Three questions if you skip backups, five or six if you do not.'),
      c.muted('Everything else takes a sensible default.'),
      '',
      c.faint('Nothing is written until the last screen, and esc goes back a step.'),
    ],
    confirmLabel: 'Set up',
    cancelLabel: 'Not now',
    def: true,
  });
  if (intro !== true) return { saved: false };

  // Every screen is a step on one track, so going back always works and always
  // means the same thing. The question list is rebuilt each time, because
  // answering "no storage provider" removes the questions that followed it.
  const home = defaultConfigPath();
  const here = path.resolve(process.cwd(), 'blankey.yml');
  let target = home;
  let step = 0;

  for (;;) {
    const steps = essentialSteps(values);
    const total = steps.length + 2;

    // --- the questions ---
    if (step < steps.length) {
      const field = steps[step]!;
      const crumb = [...breadcrumb, `${step + 1} of ${total}`];
      const next = await editFieldStep(screen, crumb, field, values[field.key], values, {
        footer: [
          ['enter', step + 1 === total ? 'next' : 'next'],
          ['esc', step === 0 ? 'leave setup' : 'back'],
        ],
      });
      if (next === CANCEL) {
        if (step === 0) return { saved: false };
        step--;
        continue;
      }
      values[field.key] = next;
      step++;
      continue;
    }

    // --- where to save it ---
    if (step === steps.length) {
      const where = await menu<string>(screen, {
        breadcrumb: [...breadcrumb, `${step + 1} of ${total}`],
        title: 'Where to save it',
        items: [
          {
            label: 'Just for me',
            hint: 'recommended',
            value: home,
            detail: () => [bold('Just for me'), '', c.muted('Read wherever you run blankey as this user.'), '', c.faint(tilde(home))],
          },
          {
            label: 'This directory only',
            value: here,
            detail: () => [bold('This directory only'), '', c.muted('Read only when blankey runs from this folder. Useful for a project-local setup.'), '', c.faint(tilde(here))],
          },
          {
            label: 'System wide',
            hint: 'needs root',
            value: '/etc/blankey/config.yml',
            detail: () => [bold('System wide'), '', c.muted('Read by every user on this machine, and by scheduled jobs running as root.'), '', c.faint('/etc/blankey/config.yml')],
          },
        ],
        filterable: false,
        detailTitle: 'Location',
        footer: [['up/down', 'move'], ['enter', 'next'], ['esc', 'back']],
      });
      if (where === CANCEL) { step--; continue; }
      target = where;
      step++;
      continue;
    }

    // --- review, then write ---
    const essentials = essentialSteps(values);
    const review = await confirm(screen, {
      breadcrumb: [...breadcrumb, `${step + 1} of ${total}`],
      message: 'Write the configuration?',
      detail: [
        ...settingsSummary(essentials, values),
        '',
        `${c.muted('Saved to')}  ${c.faint(tilde(target))}`,
        '',
        c.faint('Everything else keeps its default, and Settings can change any of it.'),
      ],
      confirmLabel: 'Write it',
      cancelLabel: 'Back',
      def: true,
      footer: [['left/right', 'choose'], ['enter', 'confirm'], ['esc', 'back']],
    });
    // Back steps to the location screen rather than throwing the answers away.
    if (review !== true) { step--; continue; }

    busy(screen, breadcrumb, `writing ${target}`);
    await writeConfigFile(target, values);
    return { saved: true, path: target };
  }
}

/**
 * Walk through every Traefik setting before scaffolding the proxy, so `init`
 * writes files that already reflect the network, image, dashboard host and
 * ACME account, rather than defaults you then have to go back and edit.
 *
 * Fields are pre-filled from the current config, so re-running this after the
 * proxy is already scaffolded is a quick confirm-through, not a fresh
 * interrogation, and doubles as the way to reconfigure it later.
 */
export async function traefikSetupWizard(
  screen: ScreenLike,
  { cfg }: { cfg: any },
): Promise<{ saved: boolean; path?: string }> {
  const values = valuesFrom(cfg);
  const breadcrumb = ['Traefik', 'Set up'];
  const fields = FIELDS.filter((f) => sectionOf(f) === 'Traefik');
  const target = cfg?.__file || defaultConfigPath();

  let step = 0;
  for (;;) {
    const total = fields.length + 1;

    // --- the questions ---
    if (step < fields.length) {
      const field = fields[step]!;
      const crumb = [...breadcrumb, `${step + 1} of ${total}`];
      const next = await editFieldStep(screen, crumb, field, values[field.key], values, {
        footer: [
          ['enter', 'next'],
          ['esc', step === 0 ? 'cancel' : 'back'],
        ],
      });
      if (next === CANCEL) {
        if (step === 0) return { saved: false };
        step--;
        continue;
      }
      values[field.key] = next;
      step++;
      continue;
    }

    // --- review, then write and scaffold ---
    const review = await confirm(screen, {
      breadcrumb: [...breadcrumb, `${step + 1} of ${total}`],
      message: 'Save these settings and scaffold the proxy?',
      detail: [
        ...settingsSummary(fields, values),
        '',
        c.muted('Writes the compose file, static and dynamic config, ACME storage and the shared network.'),
      ],
      confirmLabel: 'Scaffold it',
      cancelLabel: 'Back',
      def: true,
      footer: [['left/right', 'choose'], ['enter', 'confirm'], ['esc', 'back']],
    });
    if (review !== true) { step--; continue; }

    busy(screen, breadcrumb, `writing ${target}`);
    await writeConfigFile(target, values);
    return { saved: true, path: target };
  }
}

async function editFieldStep(
  screen: ScreenLike,
  breadcrumb: string[],
  field: SchemaField,
  current: any,
  values: Record<string, any> = {},
  { footer }: { footer?: Array<[string, string]> } = {},
): Promise<any> {
  if (field.type === 'select') {
    return menu<string>(screen, {
      breadcrumb: [...breadcrumb, field.label],
      title: field.label,
      items: choiceItems(field, current, { showCurrent: false }),
      filterable: false,
      detailTitle: field.explain ? 'Why this matters' : 'About',
      footer: footer
        ? [['up/down', 'choose'], ...footer.filter(([k]) => k !== 'enter'), ['enter', 'next']]
        : [['up/down', 'choose'], ['enter', 'next'], ['esc', 'back']],
    });
  }
  if (field.type === 'boolean') {
    const text = helpFor(field, values);
    const yes = await confirm(screen, {
      breadcrumb,
      message: field.label,
      detail: text ? [c.muted(text)] : [],
      def: Boolean(current),
      footer,
    });
    return yes === CANCEL ? CANCEL : yes;
  }
  return input(screen, {
    breadcrumb,
    label: field.label,
    help: helpFor(field, values),
    footer,
    value: current === undefined || current === null ? '' : String(current),
    placeholder: field.placeholder || '',
    mask: field.type === 'password',
    validate: (text) => (field.required && !text.trim() ? `${field.label} is required` : null),
  });
}

/**
 * The config file exactly as it is on disk, with no defaults merged in. Saving
 * has to build on this rather than on the normalised config, or every default
 * would be written out as if it had been chosen.
 */
async function readRaw(target: string): Promise<Record<string, any>> {
  try {
    const text = await fs.readFile(target, 'utf8');
    const parsed = parseYaml(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

/**
 * Write the config file, merging the edited values over whatever is on disk.
 *
 * Always local, never through `host`: the config is read from this machine
 * even when it is driving Docker over SSH.
 */
async function writeConfigFile(target: string, values: Record<string, any>): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, renderConfigFile(values, await readRaw(target)), 'utf8');
}

/**
 * Write per-project routing into the config file.
 *
 * Goes through the same emitter as the settings editor, so everything else in
 * the file, including settings no screen shows, is carried through, and the
 * schema comments are kept.
 */
export async function saveProjectRoutes(
  cfg: any,
  projectName: string,
  stackName: string | null,
  specs: any[],
): Promise<string> {
  const target = cfg.__file || defaultConfigPath();
  const raw = await readRaw(target);

  /** The container at `key`, creating it if it is missing or not an object. */
  const branch = (parent: Record<string, any>, key: string): Record<string, any> => {
    if (!parent[key] || typeof parent[key] !== 'object') parent[key] = {};
    return parent[key];
  };

  const entry = branch(branch(raw, 'projects'), projectName);

  // A stack-specific list lives under stacks.<name>, so the default stack and
  // a staging stack can point at different hostnames.
  if (stackName) {
    const scoped = branch(branch(entry, 'stacks'), stackName);
    if (specs.length) scoped.routes = specs;
    else delete scoped.routes;
  } else if (specs.length) {
    entry.routes = specs;
  } else {
    delete entry.routes;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, renderConfigFile(valuesFrom(cfg), raw), 'utf8');
  return target;
}

