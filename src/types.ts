/**
 * The shapes that flow between modules.
 *
 * These live in one place because almost every type error during the
 * TypeScript conversion traced back to the same few untyped values: the result
 * of running a command, and the objects discovery builds.
 */

// ---------------------------------------------------------------- execution

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  cmd: string;
  timedOut: boolean;
}

export interface StreamResult {
  code: number;
  tail: string[];
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  input?: string;
  maxBuffer?: number;
  onLine?: (line: string, stream: 'out' | 'err') => void;
}

export interface SshConfig {
  host: string;
  port?: number | string;
  identity?: string;
  strictHostKeyChecking?: boolean;
}

// ------------------------------------------------------------------- config

export interface AcmeConfig {
  email: string;
  resolver: string;
  staging: boolean;
}

export interface TraefikConfig {
  dir: string;
  network: string;
  dashboard: boolean;
  dashboardHost: string;
  image: string;
  acme: AcmeConfig;
  entrypoints: { web: number | string; websecure: number | string };
  logLevel: string;
}

export interface DeployDefaults {
  stack: string;
  pull: boolean;
  build: string;
  removeOrphans: boolean;
  prune: boolean;
  healthTimeout: number;
  gitStrategy: 'ff-only' | 'rebase' | 'reset' | string;
  rollbackOnFailure: boolean;
}

export interface S3Config {
  provider: string;
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
}

export interface BackupConfig {
  dir: string;
  retentionDays: number;
  keepMinimum: number;
  prefix: string;
  archiveImage: string;
  toolImage: string;
  stopStack: boolean;
  schedule: { unit: string; cron: string; mechanism: string };
  s3: S3Config;
}

export interface ProjectOverride {
  stack?: string;
  alias?: string;
  /** Traefik routing supplied here instead of in the repo compose file. */
  routes?: unknown;
  /** Give every named stack its own Compose project name, set here instead of
   * in a repo .blankey.yml, for repos you would rather not add files to. */
  isolateStacks?: boolean;
  stacks?: Record<string, { routes?: unknown; projectName?: string }>;
  [key: string]: unknown;
}

export interface Config {
  projectsDir: string;
  domain: string;
  traefik: TraefikConfig;
  ssh: SshConfig | null;
  defaults: DeployDefaults;
  backup: BackupConfig;
  ignore: string[];
  projects: Record<string, ProjectOverride>;
  isolateStacks?: boolean;
  /** Where this config was loaded from. */
  __file?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------- discovery

export interface ServiceSummary {
  name: string;
  image: string | null;
  build: string | null;
  ports: string[];
  networks: string[];
  restart: string | null;
  profiles: string[];
  dependsOn: string[];
  envFiles: string[];
  hasHealthcheck: boolean;
}

export interface Route {
  router: string;
  service: string;
  rule: string;
  hosts: string[];
  paths: string[];
  entrypoints: string[];
  certResolver: string | null;
  middlewares: string[];
  tls: boolean;
  port: number | null;
  urls: string[];
}

export interface ManagedRouting {
  /** Routes blankey adds through a generated overlay, not from the repo. */
  routes: any[];
  /** Path of the generated overlay, once written. */
  overlay: string | null;
  /** Configured routes that could not be resolved, with the reason. */
  problems: string[];
}

export interface Stack {
  name: string;
  project: string;
  dir: string;
  files: string[];
  explicitFiles: string[];
  mode: 'base' | 'overlay' | 'standalone' | string;
  projectName: string;
  envFile: string | null;
  profiles: string[];
  healthcheck: string | null;
  services: ServiceSummary[];
  routes: Route[];
  networks: string[];
  volumes: string[];
  doc: ComposeDoc;
  /** Routing blankey supplies itself, keeping the repo free of labels. */
  managed?: ManagedRouting;
}

export interface RepoHooks {
  preDeploy?: string;
  postDeploy?: string;
  preBackup?: string;
  postBackup?: string;
  [key: string]: string | undefined;
}

export interface Project {
  name: string;
  dir: string;
  stacks: Stack[];
  defaultStack: string;
  repoConfig: Record<string, any>;
  repoConfigFile: string | null;
  hooks: RepoHooks;
  /** False when the repo's .blankey.yml sets `updates: false`. */
  autoUpdate: boolean;
  hasEnv: boolean;
  envFiles: string[];
  isGit: boolean;
  files: string[];
}

export interface ComposeDoc {
  name?: string;
  services?: Record<string, any>;
  networks?: Record<string, any>;
  volumes?: Record<string, any>;
  [key: string]: any;
}

// ---------------------------------------------------------------- containers

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  health: string | null;
  ports: string;
  createdAt: string | null;
  runningFor: string;
  project: string | null;
  service: string | null;
  workdir: string | null;
  configFiles: string | null;
  exitCode: number;
}

export interface StackSummary {
  state: 'running' | 'starting' | 'partial' | 'unhealthy' | 'restarting' | 'stopped' | 'unknown';
  running: number;
  total: number;
  unhealthy: number;
  starting: number;
  exited: number;
  restarting: number;
  containers: Container[];
}

// --------------------------------------------------------------------- git

export interface GitStatus {
  isRepo: boolean;
  head?: string | null;
  branch?: string | null;
  upstream?: string | null;
  remote?: string | null;
  dirty?: number;
  ahead?: number;
  behind?: number;
  subject?: string | null;
  author?: string | null;
  date?: string | null;
}

export interface GitPosition {
  branch: string | null;
  sha: string | null;
}

export interface Commit {
  short: string;
  full: string;
  subject: string;
  author: string;
  date: string;
}

// -------------------------------------------------------------------- state

export interface DeployRecord {
  at: string;
  project: string;
  stack: string;
  ok: boolean;
  status: string;
  fromSha?: string | null;
  toSha?: string | null;
  deployedSha?: string | null;
  ephemeral?: boolean;
  ref?: string | null;
  /** First line of the deployed commit's message. */
  subject?: string | null;
  commits?: number;
  took?: number;
  error?: string | null;
}

export interface DeployResult {
  project: string;
  stack: string;
  label: string;
  status: 'ok' | 'failed' | 'skipped' | 'rolled-back' | 'restored' | string;
  steps: Array<{ name: string; detail: string }>;
  commits: string[];
  changedFiles?: string[];
  reason?: string;
  error?: string;
  failedStep?: string;
  took?: number;
  fromSha?: string | null;
  toSha?: string | null;
  deployedSha?: string | null;
  subject?: string | null;
  restoreTo?: string | null;
  direction?: string | null;
  ephemeral?: boolean;
  ref?: string | null;
  restoreFailed?: boolean;
  /** The repo had no upstream, so the deploy used the working tree. */
  localOnly?: boolean;
}

// ----------------------------------------------------------------- commands

export interface CommandContext {
  cfg: Config;
  flags: Record<string, any>;
  positional: string[];
  passthrough: string[];
  json: boolean;
  yes: boolean;
  projects(options?: { refresh?: boolean }): Promise<Project[]>;
  project(name?: string, options?: { required?: boolean }): Promise<Project>;
  target(spec?: string, options?: { stackFlag?: string }): Promise<{ project: Project; stack: Stack }>;
  targets(specs: string[], options?: { stackFlag?: string; all?: boolean }): Promise<Array<{ project: Project; stack: Stack }>>;
}

export interface CommandDef {
  name: string;
  aliases?: string[];
  group?: string;
  describe: string;
  usage?: string;
  details?: string;
  examples?: string[][];
  options?: string[][];
  valueFlags?: string[];
  flagAliases?: Record<string, string>;
  needsConfig?: boolean;
  hidden?: boolean;
  run(ctx: any): any;
}
