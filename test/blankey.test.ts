import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { parseYaml, toYaml } from '../src/yaml.js';
import { parseArgs } from '../src/args.js';
import { classifyComposeFile, detectStackMode, extractRoutes, labelsToObject, readProject } from '../src/discover.js';
import { summarize } from '../src/docker.js';
import { normalize, deepMerge, DEFAULTS } from '../src/config.js';
import { width, strip, truncate, pad } from '../src/ui/colors.js';
import { parseDockerJson, slug, bytes, score, levenshtein, parseSize } from '../src/util.js';
import { traefikCompose, traefikStatic } from '../src/templates.js';

// ---------------------------------------------------------------------- yaml

test('yaml: parses nested maps, sequences and inline collections', () => {
  const doc = parseYaml([
    'services:',
    '  web:',
    '    image: nginx:alpine   # trailing comment',
    '    ports:',
    "      - '8080:80'",
    '    environment:',
    '      DEBUG: false',
    '      RETRIES: 3',
    '    deploy:',
    "      limits: {cpus: '0.5', memory: 512M}",
    'volumes:',
    '  data:',
  ].join('\n'));

  assert.equal(doc.services.web.image, 'nginx:alpine');
  assert.deepEqual(doc.services.web.ports, ['8080:80']);
  assert.equal(doc.services.web.environment.DEBUG, false);
  assert.equal(doc.services.web.environment.RETRIES, 3);
  assert.equal(doc.services.web.deploy.limits.memory, '512M');
  assert.deepEqual(doc.volumes, { data: null });
});

test('yaml: keeps # inside quoted and backticked values', () => {
  const doc = parseYaml([
    'labels:',
    '  - traefik.http.routers.a.rule=Host(`a.example.com`)',
    '  - fragment=#not-a-comment',
    '  - real=value # comment',
  ].join('\n'));
  assert.equal(doc.labels[0], 'traefik.http.routers.a.rule=Host(`a.example.com`)');
  assert.equal(doc.labels[1], 'fragment=#not-a-comment');
  assert.equal(doc.labels[2], 'real=value');
});

test('yaml: sequence of maps', () => {
  const doc = parseYaml(['items:', '  - name: a', '    value: 1', '  - name: b', '    value: 2'].join('\n'));
  assert.deepEqual(doc.items, [{ name: 'a', value: 1 }, { name: 'b', value: 2 }]);
});

test('yaml: round-trips through the emitter', () => {
  const original = { projectsDir: '/srv/apps', traefik: { network: 'proxy', dashboard: true }, ignore: ['.git'] };
  assert.deepEqual(parseYaml(toYaml(original)), original);
});

// ---------------------------------------------------------------------- args

test('args: flags, values, bundles, negation and passthrough', () => {
  const { flags, positional, passthrough } = parseArgs(
    ['deploy', 'shop', '-s', 'staging', '--build', '--no-pull', '-yv', '--timeout=30', '--', 'extra', '--raw'],
    { valueFlags: ['stack', 'timeout'], aliases: { s: 'stack', y: 'yes', v: 'verbose' } },
  );
  assert.deepEqual(positional, ['deploy', 'shop']);
  assert.equal(flags.stack, 'staging');
  assert.equal(flags.build, true);
  assert.equal(flags.pull, false);
  assert.equal(flags.yes, true);
  assert.equal(flags.verbose, true);
  assert.equal(flags.timeout, 30);
  assert.deepEqual(passthrough, ['extra', '--raw']);
});

test('args: dashed flag names become camelCase', () => {
  const { flags } = parseArgs(['--projects-dir', '/srv/x', '--dry-run'], { valueFlags: ['projectsDir'] });
  assert.equal(flags.projectsDir, '/srv/x');
  assert.equal(flags.dryRun, true);
});

// ------------------------------------------------------------------ discover

test('discover: classifies compose file names', () => {
  assert.deepEqual(classifyComposeFile('docker-compose.yml'), { kind: 'base', stack: 'default', file: 'docker-compose.yml' });
  assert.deepEqual(classifyComposeFile('compose.yaml'), { kind: 'base', stack: 'default', file: 'compose.yaml' });
  assert.equal(classifyComposeFile('docker-compose.override.yml')!.kind, 'override');
  assert.equal(classifyComposeFile('docker-compose.staging.yml')!.stack, 'staging');
  assert.equal(classifyComposeFile('compose.prod.yaml')!.stack, 'prod');
  assert.equal(classifyComposeFile('notes.yml'), null);
  assert.equal(classifyComposeFile('docker-compose.yml.bak'), null);
});

test('discover: overlay vs standalone detection', () => {
  const base = { services: { web: { image: 'nginx' }, db: { image: 'postgres' } } };
  const patch = { services: { web: { environment: { A: 1 } } } };
  const full = { services: { web: { image: 'nginx:1' }, worker: { image: 'busybox' } } };
  assert.equal(detectStackMode(base, patch), 'overlay');
  assert.equal(detectStackMode(base, full), 'standalone');
  assert.equal(detectStackMode(null, patch), 'standalone');
});

test('discover: labels parse from both list and map form', () => {
  assert.deepEqual(labelsToObject(['a=1', 'b=two']), { a: '1', b: 'two' });
  assert.deepEqual(labelsToObject({ a: 1, b: null }), { a: '1', b: '' });
});

test('discover: extracts traefik routes including multi-host rules', () => {
  const routes = extractRoutes({
    web: {
      labels: [
        'traefik.enable=true',
        'traefik.http.routers.site.rule=Host(`a.com`) || Host(`www.a.com`)',
        'traefik.http.routers.site.entrypoints=websecure',
        'traefik.http.routers.site.tls.certresolver=le',
        'traefik.http.services.site.loadbalancer.server.port=3000',
      ],
    },
    hidden: { labels: ['traefik.enable=false', 'traefik.http.routers.x.rule=Host(`x.com`)'] },
  });
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0]!.hosts, ['a.com', 'www.a.com']);
  assert.equal(routes[0]!.port, 3000);
  assert.equal(routes[0]!.tls, true);
  assert.deepEqual(routes[0]!.urls, ['https://a.com', 'https://www.a.com']);
});

test('discover: PathPrefix becomes part of the url', () => {
  const [route] = extractRoutes({
    api: { labels: ['traefik.http.routers.api.rule=Host(`a.com`) && PathPrefix(`/api`)'] },
  });
  assert.deepEqual(route!.urls, ['http://a.com/api']);
});

test('discover: reads a repo with a base and an overlay stack', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'shop');
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, 'docker-compose.yml'), [
    'services:',
    '  api:',
    '    build: .',
    '    labels:',
    '      - traefik.enable=true',
    '      - traefik.http.routers.shop.rule=Host(`shop.example.com`)',
    '      - traefik.http.services.shop.loadbalancer.server.port=3000',
  ].join('\n'));
  await fs.writeFile(path.join(repo, 'docker-compose.staging.yml'), [
    'services:',
    '  api:',
    '    labels:',
    '      - traefik.http.routers.shop.rule=Host(`staging.example.com`)',
  ].join('\n'));

  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: dir }));
  const project = (await readProject(cfg, 'shop', repo))!;

  assert.equal(project.stacks.length, 2);
  const staging = project.stacks.find((s) => s.name === 'staging')!;
  assert.equal(staging.mode, 'overlay');
  assert.deepEqual(staging.files, ['docker-compose.yml', 'docker-compose.staging.yml']);
  // The overlay must inherit the port label it does not restate.
  assert.equal(staging.routes[0].port, 3000);
  assert.deepEqual(staging.routes[0].hosts, ['staging.example.com']);
  // The default stack runs without -f so compose picks up its own override file.
  assert.deepEqual(project.stacks.find((s) => s.name === 'default')!.explicitFiles, []);
});

test('discover: named stacks are isolated from each other by default', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'test-project-4');
  await fs.mkdir(repo, { recursive: true });
  // Both declare their own build, so this is standalone, not an overlay,
  // exactly the shape that silently shared a project name before.
  await fs.writeFile(path.join(repo, 'docker-compose.yml'), 'services:\n  web:\n    build: .\n    ports: ["8084:80"]\n');
  await fs.writeFile(path.join(repo, 'docker-compose.staging.yml'), 'services:\n  web:\n    build: .\n    ports: ["9084:80"]\n');

  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: dir }));
  const project = (await readProject(cfg, 'test-project-4', repo))!;
  const def = project.stacks.find((s) => s.name === 'default')!;
  const staging = project.stacks.find((s) => s.name === 'staging')!;

  // The default stack always matches what Compose would pick on its own, so
  // it never orphans containers started by hand before adopting blankey.
  assert.equal(def.projectName, 'test-project-4');
  // Every other stack gets its own project name automatically: sharing one
  // would mean the same containers, since Compose keys by project + service,
  // not by which file created them.
  assert.equal(staging.projectName, 'test-project-4-staging');
});

test('discover: isolateStacks can be turned off, in the repo or centrally', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'shop');
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, 'docker-compose.yml'), 'services:\n  api:\n    build: .\n');
  await fs.writeFile(path.join(repo, 'docker-compose.staging.yml'), 'services:\n  api:\n    build: .\n');

  // Centrally, in blankey.yml, without touching the repo at all.
  const central = normalize(deepMerge(DEFAULTS, {
    projectsDir: dir,
    projects: { shop: { isolateStacks: false } },
  }));
  const viaCentral = (await readProject(central, 'shop', repo))!;
  assert.equal(viaCentral.stacks.find((s) => s.name === 'staging')!.projectName, 'shop');

  // The repo's own .blankey.yml still wins over the central setting.
  await fs.writeFile(path.join(repo, '.blankey.yml'), 'isolateStacks: true\n');
  const repoOverride = normalize(deepMerge(DEFAULTS, {
    projectsDir: dir,
    projects: { shop: { isolateStacks: false } },
  }));
  const viaRepo = (await readProject(repoOverride, 'shop', repo))!;
  assert.equal(viaRepo.stacks.find((s) => s.name === 'staging')!.projectName, 'shop-staging');
});

test('discover: a repo can opt out with ignore', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'skipme');
  await fs.mkdir(repo, { recursive: true });
  await fs.writeFile(path.join(repo, 'docker-compose.yml'), 'services:\n  a:\n    image: nginx\n');
  await fs.writeFile(path.join(repo, '.blankey.yml'), 'ignore: true\n');
  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: dir }));
  assert.equal(await readProject(cfg, 'skipme', repo), null);
});

// -------------------------------------------------------------------- docker

test('docker: summarize maps container states to a stack state', () => {
  const running = [{ state: 'running', health: null }, { state: 'running', health: null }] as any[];
  assert.equal(summarize(running, ['a', 'b']).state, 'running');
  assert.equal(summarize([{ state: 'running', health: 'unhealthy' }] as any[], ['a']).state, 'unhealthy');
  assert.equal(summarize([{ state: 'restarting', health: null }] as any[], ['a']).state, 'restarting');
  assert.equal(summarize([], ['a']).state, 'stopped');
  assert.equal(summarize([{ state: 'running', health: null }] as any[], ['a', 'b']).state, 'partial');
  assert.equal(summarize([{ state: 'running', health: 'starting' }] as any[], ['a']).state, 'starting');
});

test('util: parses docker json arrays and ndjson', () => {
  assert.equal(parseDockerJson('{"a":1}\n{"a":2}').length, 2);
  assert.equal(parseDockerJson('[{"a":1}]').length, 1);
  assert.deepEqual(parseDockerJson(''), []);
  assert.deepEqual(parseDockerJson('not json'), []);
});

// -------------------------------------------------------------------- config

test('config: normalize fills defaults and derives paths', () => {
  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: '/srv/apps', domain: 'example.com' }));
  assert.equal(cfg.traefik.network, 'proxy');
  assert.equal(cfg.traefik.dashboardHost, 'traefik.example.com');
  assert.ok(cfg.traefik.dir.includes('.blankey'), 'traefik state lives under .blankey, alongside backups and routes');
  assert.ok(cfg.traefik.dir.includes('traefik'));
  assert.equal(cfg.defaults.gitStrategy, 'ff-only');
});

test('config: a bare ssh string becomes an ssh object', () => {
  const cfg = normalize(deepMerge(DEFAULTS, { ssh: 'root@example.com' }));
  assert.deepEqual(cfg.ssh, { host: 'root@example.com' });
});

test('config: deepMerge does not mutate the defaults', () => {
  const before = JSON.stringify(DEFAULTS);
  deepMerge(DEFAULTS, { traefik: { network: 'edge' } });
  assert.equal(JSON.stringify(DEFAULTS), before);
});

// ------------------------------------------------------------------------ ui

test('ui: width and truncate ignore ansi escapes', () => {
  const colored = '\x1b[31mhello\x1b[39m';
  assert.equal(width(colored), 5);
  assert.equal(strip(colored), 'hello');
  assert.equal(strip(truncate('abcdefgh', 5)).length <= 5, true);
  assert.equal(width(pad('ab', 6)), 6);
});

test('util: helpers behave', () => {
  assert.equal(slug('My App!'), 'my-app');
  assert.equal(bytes(1536), '1.5KB');
  assert.ok(score('shop', 'shop-api') > 0);
  assert.equal(score('zzz', 'shop-api'), -1);
  assert.equal(levenshtein('deploy', 'delpoy'), 2);
});

// ------------------------------------------------------------- one-shot bits

test('cleanup: tasks run once and then clear', async () => {
  const { onCleanup, runCleanups, pendingCleanups } = await import('../src/cleanup.js');
  let calls = 0;
  onCleanup(() => { calls++; });
  const remove = onCleanup(() => { calls += 10; });
  remove();
  assert.equal(pendingCleanups(), 1);
  assert.equal(await runCleanups(), 1);
  assert.equal(calls, 1);
  assert.equal(pendingCleanups(), 0);
  await runCleanups();
  assert.equal(calls, 1, 'a drained task must not run twice');
});

test('cleanup: a throwing task does not block the others', async () => {
  const { onCleanup, runCleanups } = await import('../src/cleanup.js');
  let ran = false;
  onCleanup(() => { throw new Error('boom'); });
  onCleanup(() => { ran = true; });
  await runCleanups();
  assert.equal(ran, true);
});

test('git: a one-shot round trip puts the repo back on its branch', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-git-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = await import('../src/git.js');
  const { exec } = await import('../src/host.js');

  // git on Windows may rewrite line endings on checkout, so compare trimmed.
  const readFile = async (f) => (await fs.readFile(path.join(dir, f), 'utf8')).trim();
  const run = async (cmd) => {
    const r = await exec(cmd, { cwd: dir });
    if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr}`);
    return r.stdout;
  };
  await run('git init -q -b main .');
  await run('git config user.email t@t.io');
  await run('git config user.name Test');
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
  await run('git add -A');
  await run('git commit -qm first');
  const first = (await git.currentSha(dir))!.slice(0, 7);
  await fs.writeFile(path.join(dir, 'a.txt'), 'two\n');
  await run('git commit -qam second');
  const second = (await git.currentSha(dir))!.slice(0, 7);

  const origin = await git.currentPosition(dir);
  assert.equal(origin.branch, 'main');

  const target = await git.resolveRef(dir, first);
  assert.ok(target);

  const co = await git.checkoutRef(dir, first);
  assert.equal(co.ok, true);
  assert.equal(co.detached, true, 'a commit is checked out detached, leaving the branch alone');
  assert.equal(await readFile('a.txt'), 'one');
  assert.equal(await git.isDetached(dir), true);

  const back = await git.restorePosition(dir, origin);
  assert.equal(back.ok, true);
  assert.equal(await git.isDetached(dir), false);
  assert.equal((await git.currentPosition(dir)).branch, 'main');
  assert.equal((await git.currentSha(dir))!.slice(0, 7), second);
  assert.equal(await readFile('a.txt'), 'two');
  assert.notEqual(first, second);
});

test('git: a repo with no upstream is recognised, not treated as broken', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-local-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = await import('../src/git.js');
  const { exec } = await import('../src/host.js');

  const work = path.join(dir, 'work');
  const origin = path.join(dir, 'origin.git');
  await fs.mkdir(work, { recursive: true });

  const run = async (cmd: string, cwd = work) => {
    const r = await exec(cmd, { cwd });
    if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  };
  await run(`git init --bare -q "${origin}"`, dir);
  await run('git init -q -b main .');
  await run('git config user.email t@t.io');
  await run('git config user.name Test');
  await fs.writeFile(path.join(work, 'a.txt'), 'one\n');
  await run('git add -A');
  await run('git commit -qm "local only"');

  // Nothing to pull from: deploys should build the working tree, not fail.
  assert.equal(await git.tracksRemote(work), false);
  const before = await git.status(work);
  assert.equal(before.isRepo, true);
  assert.equal(before.upstream, null);
  assert.equal(before.subject, 'local only');

  await run(`git remote add origin "${origin}"`);
  await run('git push -q -u origin main');

  assert.equal(await git.tracksRemote(work), true, 'an upstream makes it pullable');
  const after = await git.status(work);
  assert.ok(after.upstream);
});

test('git: subjectOf names a commit, and copes with one that is gone', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-subject-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = await import('../src/git.js');
  const { exec } = await import('../src/host.js');

  const run = async (cmd: string) => {
    const r = await exec(cmd, { cwd: dir });
    if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  };
  await run('git init -q -b main .');
  await run('git config user.email t@t.io');
  await run('git config user.name Test');
  await fs.writeFile(path.join(dir, 'a.txt'), 'x\n');
  await run('git add -A');
  await run('git commit -qm "pin postgres to alpine"');

  const sha = (await git.currentSha(dir))!;
  assert.equal(await git.subjectOf(dir, sha), 'pin postgres to alpine');
  // History can outlive the commit it points at, so a miss must not throw.
  assert.equal(await git.subjectOf(dir, '0000000'), null);
});

test('render: a local repo reads as local rather than in sync', async () => {
  const { gitCell, commitCell } = await import('../src/ui/render.js');

  const local = strip(gitCell({ isRepo: true, branch: 'main', upstream: null, dirty: 0 }));
  assert.match(local, /main/);
  assert.match(local, /local/);
  assert.doesNotMatch(local, /✔|v$/, 'no tick, which would imply it is in sync with a remote');

  const tracked = strip(gitCell({ isRepo: true, branch: 'main', upstream: 'origin/main', dirty: 0, ahead: 0, behind: 0 }));
  assert.doesNotMatch(tracked, /local/);

  // A sha alone identifies nothing, so the message rides along.
  const cell = strip(commitCell({ isRepo: true, head: '1fc22c6', subject: 'pin postgres to alpine' }));
  assert.match(cell, /1fc22c6/);
  assert.match(cell, /pin postgres/);
  assert.equal(strip(commitCell({ isRepo: false })), '—');
});

test('state: rollback ignores one-shot deploys, which never moved the tree', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-state-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { lastGoodSha, lastDeploy } = await import('../src/state.js');
  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: dir }));
  await fs.mkdir(path.join(dir, '.blankey'), { recursive: true });
  await fs.writeFile(path.join(dir, '.blankey', 'deploys.json'), JSON.stringify({
    version: 1,
    deploys: [
      { at: '2026-01-02T00:00:00Z', project: 'shop', stack: 'default', ok: true, ephemeral: true, fromSha: 'bbbbbbb', toSha: 'bbbbbbb', deployedSha: 'ccccccc' },
      { at: '2026-01-01T00:00:00Z', project: 'shop', stack: 'default', ok: true, fromSha: 'aaaaaaa', toSha: 'bbbbbbb' },
    ],
  }));
  assert.equal(await lastGoodSha(cfg, 'shop', 'default'), 'aaaaaaa');
  assert.equal((await lastDeploy(cfg, 'shop', 'default'))!.deployedSha, 'ccccccc');
});

// ------------------------------------------------------------------- layout

test('style: a bordered block is rectangular and the requested width', async () => {
  const { style } = await import('../src/ui/style.js');
  const block = style(['one', 'a much longer line'], { width: 30, border: 'rounded', padding: [0, 1] });
  for (const line of block) assert.equal(width(line), 30, 'every line matches, so blocks can sit side by side');
  assert.equal(block.length, 4, 'two content lines plus a top and bottom border');
});

test('style: padding, height and alignment shape the block', async () => {
  const { style } = await import('../src/ui/style.js');
  const padded = style(['x'], { width: 20, padding: [1, 2], border: false });
  assert.equal(padded.length, 3, 'one line of padding above and below');
  for (const line of padded) assert.equal(width(line), 20);

  const tall = style(['x'], { width: 10, height: 5, border: false, valign: 'middle' });
  assert.equal(tall.length, 5);
  assert.equal(strip(tall[2]!).trim(), 'x', 'content sits in the middle');

  const right = style(['x'], { width: 10, border: false, align: 'right' });
  assert.match(strip(right[0]!), /^ +x$/);
});

test('style: a title and tag sit in the top border without changing the width', async () => {
  const { style } = await import('../src/ui/style.js');
  const block = style(['body'], { width: 40, border: 'rounded', title: 'Panel', tag: '3/9' });
  for (const line of block) assert.equal(width(line), 40);
  assert.match(strip(block[0]!), /Panel/);
  assert.match(strip(block[0]!), /3\/9/);
});

test('style: blocks join horizontally and vertically', async () => {
  const { style, joinHorizontal, joinVertical, blockWidth } = await import('../src/ui/style.js');
  const left = style(['a', 'b', 'c'], { width: 12, border: 'rounded' });
  const right = style(['x'], { width: 20, border: 'rounded' });

  const side = joinHorizontal('top', left, right);
  assert.equal(side.length, Math.max(left.length, right.length), 'the shorter block is padded out');
  for (const line of side) assert.equal(width(line), 32, 'widths add up exactly');

  const stacked = joinVertical('left', left, right);
  assert.equal(stacked.length, left.length + right.length);
  assert.equal(blockWidth(stacked), 20, 'stacked blocks share the widest width');
});

test('style: place positions a block inside a region', async () => {
  const { place } = await import('../src/ui/style.js');
  const centred = place(20, 5, ['hi'], { align: 'center', valign: 'middle' });
  assert.equal(centred.length, 5);
  for (const line of centred) assert.equal(width(line), 20);
  assert.equal(strip(centred[2]!).trim(), 'hi');
});

test('style: wrapping hard-breaks tokens that have no spaces', async () => {
  const { wrap } = await import('../src/ui/style.js');
  // Paths and URLs would otherwise run straight past the edge of a panel.
  const path = '/srv/apps/some-very-long-project-name/docker-compose.staging.yml';
  const lines = wrap(path, 20);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(width(line) <= 20, `"${line}" fits`);
  assert.equal(lines.join(''), path, 'nothing is lost');

  const words = wrap('the quick brown fox jumps', 10);
  for (const line of words) assert.ok(width(line) <= 10);
  assert.equal(words.join(' '), 'the quick brown fox jumps');
});

test('style: paths elide from the middle so the end stays readable', async () => {
  const { elideMiddle } = await import('../src/ui/style.js');
  const path = '/srv/apps/a-very-long-project/docker-compose.staging.yml';

  const short = elideMiddle(path, 30);
  assert.ok(width(short) <= 30);
  assert.ok(short.startsWith('/srv/apps'), 'the start survives');
  assert.ok(short.endsWith('.yml'), 'and so does the filename');
  // Anything that already fits is left alone.
  assert.equal(elideMiddle('short', 30), 'short');
});

test('style: bar and sparkline stay within their size', async () => {
  const { bar, sparkline } = await import('../src/ui/style.js');
  assert.equal(width(bar(3, 4, 10)), 10);
  assert.equal(width(bar(0, 0, 8)), 8, 'a zero total does not divide by zero');
  assert.equal(width(bar(99, 4, 6)), 6, 'over-full stays clamped');
  assert.equal(width(sparkline([1, 5, 3, 9])), 4);
  assert.equal(sparkline([]), '');
});

test('style: spacing shorthands expand like CSS', async () => {
  const { expandSpacing } = await import('../src/ui/style.js');
  assert.deepEqual(expandSpacing(2), [2, 2, 2, 2]);
  assert.deepEqual(expandSpacing([1, 3]), [1, 3, 1, 3]);
  assert.deepEqual(expandSpacing([1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(expandSpacing(), [0, 0, 0, 0]);
});

// ------------------------------------------------------------------------ tui

test('keys: decodes arrows, control keys and text', async () => {
  const { decodeKeys } = await import('../src/tui/keys.js');
  const names = (s) => decodeKeys(s).map((k) => k.name);

  assert.deepEqual(names('\x1b[A\x1b[B\x1b[C\x1b[D'), ['up', 'down', 'right', 'left']);
  // Application cursor mode sends a different prefix for the same keys.
  assert.deepEqual(names('\x1bOA\x1bOB'), ['up', 'down']);
  assert.deepEqual(names('\x1b[5~\x1b[6~\x1b[3~'), ['pageup', 'pagedown', 'delete']);
  assert.deepEqual(names('\r\n\t\x7f'), ['enter', 'enter', 'tab', 'backspace']);
  assert.deepEqual(names('\x1b'), ['escape']);

  const [ctrlC] = decodeKeys('\x03');
  assert.equal(ctrlC.ctrl, true);
  assert.equal(ctrlC.name, 'c');
});

test('keys: one chunk can carry several keypresses', async () => {
  const { decodeKeys } = await import('../src/tui/keys.js');
  // Held arrow keys and pastes arrive coalesced.
  assert.deepEqual(decodeKeys('\x1b[B\x1b[B\x1b[B').map((k) => k.name), ['down', 'down', 'down']);
  const typed = decodeKeys('shop');
  assert.equal(typed.length, 4);
  assert.deepEqual(typed.map((k) => k.char), ['s', 'h', 'o', 'p']);
});

test('keys: modifiers and whole codepoints survive', async () => {
  const { decodeKeys } = await import('../src/tui/keys.js');
  const [shiftUp] = decodeKeys('\x1b[1;2A');
  assert.equal(shiftUp.name, 'up');
  assert.equal(shiftUp.shift, true);

  const [emoji] = decodeKeys('\u{1F600}');
  assert.equal(emoji.char, '\u{1F600}', 'a surrogate pair is one key, not two');
  assert.deepEqual(decodeKeys(' ').map((k) => k.name), ['space']);
});

test('screen: each drawn line erases its own tail', async () => {
  const { Screen } = await import('../src/tui/screen.js');
  const writes: any[] = [];
  const stdout = { rows: 10, columns: 40, isTTY: true, write: (s) => writes.push(s), on() {}, off() {} };
  const stdin = { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };

  new Screen(stdin, stdout).draw(['a much longer first line', 'short']);
  const frame = writes.join('');

  // Without a per-line erase, the tail of a longer previous line stays visible
  // to the right of a shorter new one.
  assert.equal((frame.match(/\x1b\[K/g) || []).length, 2);
  assert.ok(frame.startsWith('\x1b[H'), 'painting starts from the top left');
  assert.ok(frame.endsWith('\x1b[0J'), 'and clears anything below the last line');
});

interface FakeKey { name: string; ctrl?: boolean; alt?: boolean; shift?: boolean; char?: string }

/** A screen that renders into strings and replays scripted keys. */
function fakeScreen(keys: FakeKey[] = []): any {
  return {
    rows: 24,
    columns: 80,
    frames: [] as string[],
    queue: [...keys] as any[],
    start() { return this; },
    stop() { return this; },
    hideCursor() {},
    placeCursor() {},
    flush() {},
    draw(lines) { this.frames.push(Array.isArray(lines) ? lines.join('\n') : String(lines)); },
    async readKey() { return this.queue.shift() || { name: 'escape' }; },
    async suspend(fn: any) { return fn ? fn() : undefined; },
    last() { return strip(this.frames[this.frames.length - 1] || ''); },
  };
}

const K = {
  down: { name: 'down' } as FakeKey,
  up: { name: 'up' } as FakeKey,
  enter: { name: 'enter' } as FakeKey,
  escape: { name: 'escape' } as FakeKey,
  backspace: { name: 'backspace' } as FakeKey,
  char: (ch: string): FakeKey => ({ name: 'char', char: ch }),
};

test('menu: arrows move and enter selects', async () => {
  const { menu } = await import('../src/tui/widgets.js');
  const screen = fakeScreen([K.down, K.down, K.enter]);
  const value = await menu(screen, {
    items: [{ label: 'one', value: 1 }, { label: 'two', value: 2 }, { label: 'three', value: 3 }],
  });
  assert.equal(value, 3);
});

test('menu: separators are drawn but skipped when moving', async () => {
  const { menu } = await import('../src/tui/widgets.js');
  const screen = fakeScreen([K.down, K.enter]);
  const value = await menu(screen, {
    items: [
      { separator: 'group' },
      { label: 'first', value: 'a' },
      { separator: 'other' },
      { label: 'second', value: 'b' },
    ],
  });
  assert.equal(value, 'b', 'one step down lands on the next item, not the separator');
  assert.match(screen.frames[0], /GROUP/);
});

test('menu: typing filters, and escape clears the filter before leaving', async () => {
  const { menu, CANCEL } = await import('../src/tui/widgets.js');
  const screen = fakeScreen([K.char('t'), K.char('h'), K.enter]);
  const value = await menu(screen, {
    items: [{ label: 'deploy', value: 'd' }, { label: 'three', value: 't' }],
  });
  assert.equal(value, 't');

  // First escape drops the filter, a second one exits.
  const two = fakeScreen([K.char('x'), K.escape, K.escape]);
  assert.equal(await menu(two, { items: [{ label: 'one', value: 1 }] }), CANCEL);
});

test('menu: filtering stays precise on long keyword lists', async () => {
  const { menu } = await import('../src/tui/widgets.js');
  const items = [
    { label: 'Overview', hint: 'what is running', keywords: 'Fleet status Live dashboard Projects and stacks Routes' },
    { label: 'Deploy', hint: 'update and release', keywords: 'Deploy a project Roll back History' },
  ];
  // A subsequence of the *keywords* would match almost anything, so "dep" must
  // not drag Overview along with it.
  const screen = fakeScreen([K.char('d'), K.char('e'), K.char('p'), K.enter]);
  await menu(screen, { items: items.map((i) => ({ ...i, value: i.label })) });
  const shown = strip(screen.frames[screen.frames.length - 1]);
  assert.match(shown, /Deploy/);
  assert.doesNotMatch(shown, /Overview/);

  // A keyword substring still finds the group that owns the action.
  const byKeyword = fakeScreen([K.char('r'), K.char('o'), K.char('u'), K.char('t'), K.enter]);
  assert.equal(await menu(byKeyword, { items: items.map((i) => ({ ...i, value: i.label })) }), 'Overview');
});

test('menu: shortcuts only fire when nothing is being filtered', async () => {
  const { menu } = await import('../src/tui/widgets.js');
  // Bare q quits.
  const quick = fakeScreen([K.char('q')]);
  assert.equal(await menu<any>(quick, {
    items: [{ label: 'one', value: 1 }],
    shortcuts: { q: '__quit' },
  }), '__quit');

  // But q inside a search term is just a letter.
  const typing = fakeScreen([K.char('q'), K.enter]);
  assert.equal(await menu(typing, {
    items: [{ label: 'queue', value: 'queue' }],
    shortcuts: {},
  }), 'queue');
});

test('menu: wraps around the ends', async () => {
  const { menu } = await import('../src/tui/widgets.js');
  const screen = fakeScreen([K.up, K.enter]);
  const value = await menu(screen, {
    items: [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }, { label: 'c', value: 'c' }],
  });
  assert.equal(value, 'c', 'up from the first item lands on the last');
});

test('input: editing, validation and cancelling', async () => {
  const { input, CANCEL } = await import('../src/tui/widgets.js');

  const typed = fakeScreen([K.char('h'), K.char('i'), K.enter]);
  assert.equal(await input(typed, { label: 'Name' }), 'hi');

  const edited = fakeScreen([K.backspace, K.char('o'), K.enter]);
  assert.equal(await input(edited, { label: 'Name', value: 'hi' }), 'ho');

  // A failed validation keeps the view open rather than returning bad input.
  const validated = fakeScreen([K.enter, K.char('x'), K.enter]);
  const result = await input(validated, {
    label: 'Required',
    validate: (t) => (t ? null : 'required'),
  });
  assert.equal(result, 'x');
  assert.match(strip(validated.frames[1]), /required/);

  assert.equal(await input(fakeScreen([K.escape]), { label: 'Name' }), CANCEL);
});

test('settings: the config file is generated with its help as comments', async () => {
  const { renderConfigFile, valuesFrom, getPath, setPath } = await import('../src/tui/settings.js');
  const values = valuesFrom({ projectsDir: '/srv/apps', domain: 'example.com' });
  values['backup.s3.bucket'] = 'my-bucket';
  values['backup.s3.provider'] = 'hetzner';

  const text = renderConfigFile(values);
  assert.match(text, /^# blankey configuration/);
  assert.match(text, /# Folder holding one directory per repo\.\nprojectsDir: \/srv\/apps/);
  assert.match(text, /bucket: my-bucket/);
  // Empty settings are left out rather than written as blanks.
  assert.doesNotMatch(text, /accessKeyId/);
  assert.doesNotMatch(text, /ssh:/);

  const parsed = parseYaml(text);
  assert.equal(parsed.projectsDir, '/srv/apps');
  assert.equal(parsed.backup.s3.provider, 'hetzner');
  assert.equal(getPath(parsed, 'backup.s3.bucket'), 'my-bucket');
  assert.equal(getPath(setPath({}, 'a.b.c', 7), 'a.b.c'), 7);
});

test('settings: setup only asks what is still relevant', async () => {
  const { essentialSteps, valuesFrom } = await import('../src/tui/settings.js');
  const values = valuesFrom(null);

  // Domain and the ACME address are per-project concerns, so setup leaves them
  // to the settings editor rather than asking up front.
  const keysWith = (v: Record<string, any>) => essentialSteps(v).map((f) => f.key);
  assert.ok(!keysWith(values).includes('domain'));
  assert.ok(!keysWith(values).includes('traefik.acme.email'));

  // No storage provider means no region, bucket or endpoint question.
  values['backup.s3.provider'] = '';
  assert.deepEqual(keysWith(values), ['projectsDir', 'ssh.host', 'backup.s3.provider']);

  // Picking a known provider adds the two it needs, in order.
  values['backup.s3.provider'] = 'hetzner';
  assert.deepEqual(keysWith(values), [
    'projectsDir', 'ssh.host', 'backup.s3.provider', 'backup.s3.region', 'backup.s3.bucket',
  ]);

  // A service blankey has no endpoint for has to be asked for one.
  values['backup.s3.provider'] = 'custom';
  assert.deepEqual(keysWith(values), [
    'projectsDir', 'ssh.host', 'backup.s3.provider',
    'backup.s3.endpoint', 'backup.s3.region', 'backup.s3.bucket',
  ]);
});

test('settings: a setting that does not apply is never written', async () => {
  const { renderConfigFile, valuesFrom } = await import('../src/tui/settings.js');
  const values = valuesFrom({ projectsDir: '/srv/apps' });

  // Someone picks a bucket, then decides against backups. The stale bucket must
  // not survive into the file as live configuration.
  values['backup.s3.bucket'] = 'left-over';
  values['backup.s3.region'] = 'fsn1';
  values['backup.s3.provider'] = '';

  const off = parseYaml(renderConfigFile(values));
  assert.equal(off.backup?.s3?.bucket, undefined);
  assert.equal(off.backup?.s3?.region, undefined);

  values['backup.s3.provider'] = 'hetzner';
  const on = parseYaml(renderConfigFile(values));
  assert.equal(on.backup.s3.bucket, 'left-over');
  assert.equal(on.backup.s3.region, 'fsn1');
});

test('settings: help can depend on the answers already given', async () => {
  const { SCHEMA, helpFor } = await import('../src/tui/settings.js');
  const region = SCHEMA.find((f) => f.key === 'backup.s3.region') as any;

  assert.match(helpFor(region, { 'backup.s3.provider': 'hetzner' }), /fsn1/);
  assert.doesNotMatch(helpFor(region, { 'backup.s3.provider': 'hetzner' }), /nyc3/);
  assert.match(helpFor(region, { 'backup.s3.provider': 'digitalocean' }), /nyc3/);
  // Nothing known about the service, so it says so rather than listing regions
  // that do not apply.
  assert.match(helpFor(region, { 'backup.s3.provider': 'custom' }), /us-east-1/);
});

test('settings: defaults presented to the user match what deploy actually does', async () => {
  const { valuesFrom } = await import('../src/tui/settings.js');
  const values = valuesFrom(null);
  // Deploy treats a missing value as true, so the editor must not show "off"
  // and then write false when saved.
  assert.equal(values['defaults.rollbackOnFailure'], true);
  assert.equal(values['defaults.gitStrategy'], 'ff-only');
  assert.equal(values['backup.retentionDays'], 21);
});

test('output: command output can be captured instead of hitting the terminal', async () => {
  const { setSink } = await import('../src/ui/output.js');
  const { log } = await import('../src/ui/log.js');

  const seen: Array<[string, string]> = [];
  setSink((text, stream) => seen.push([stream, text]));
  try {
    log.raw('hello');
    log.fail('broken');
  } finally {
    setSink(null);
  }

  assert.equal(seen.length, 2);
  assert.equal(seen[0]![0], 'out');
  assert.match(seen[0]![1], /hello/);
  // Failures keep their own stream so a panel can colour them differently.
  assert.equal(seen[1]![0], 'err');
  assert.match(seen[1]![1], /broken/);
});

test('output: a captured spinner reports status, not cursor movement', async () => {
  const { setSink } = await import('../src/ui/output.js');
  const { Spinner } = await import('../src/ui/spinner.js');

  const seen: Array<[string, string]> = [];
  setSink((text, stream) => seen.push([stream, text]));
  try {
    const sp = new Spinner('starting').start();
    sp.update('halfway');
    sp.succeed('finished');
  } finally {
    setSink(null);
  }

  const statuses = seen.filter(([s]) => s === 'status').map(([, t]) => t);
  const lines = seen.filter(([s]) => s === 'out').map(([, t]) => t);
  assert.deepEqual(statuses.slice(0, 2), ['starting', 'halfway']);
  assert.equal(statuses[statuses.length - 1], '', 'the status clears when the step ends');
  assert.equal(lines.length, 1);
  assert.match(strip(lines[0]!), /finished/);
  // Escape sequences that move the cursor would corrupt a panel.
  for (const [, text] of seen) assert.doesNotMatch(text, /\x1b\[2K|\r/);
});

test('output: with no sink installed, nothing is captured', async () => {
  const { isCaptured, emit } = await import('../src/ui/output.js');
  assert.equal(isCaptured(), false);
  assert.equal(emit('anything'), false, 'callers fall through to stdout');
});

test('tui: only genuinely interactive actions take over the terminal', async () => {
  const { MENU } = await import('../src/tui/app.js');
  const terminal = (MENU as any[])
    .flatMap((g) => g.items)
    .filter((i: any) => i.needsTerminal)
    .map((i: any) => i.label)
    .sort();

  // Everything else renders inside the program. These four read keys of their
  // own, so they need the real terminal.
  assert.deepEqual(terminal, ['Live dashboard', 'Open a shell', 'Proxy logs', 'Watch logs']);
});

test('tui: every menu entry points at a real command', async () => {
  const { MENU } = await import('../src/tui/app.js');
  const { findCommand } = await import('../src/commands/index.js');
  const actions = new Set([
    'settings', 'setup', 'config-path', 'schedule-backup', 'routing', 'traefik-init',
    'traefik-settings', 'backup-settings', 'deploy-settings', 'core-settings', 'update-repos',
    'ssl-configs', 'ssh-identities', 'add-project', 'remove-project',
  ]);

  for (const group of MENU as any[]) {
    assert.ok(group.label && group.items.length, `${group.id} needs a label and items`);
    for (const item of group.items) {
      if (item.separator !== undefined) continue;
      assert.ok(item.label, `an item in ${group.id} has no label`);
      if (item.action) {
        assert.ok(actions.has(item.action), `unknown action ${item.action}`);
        continue;
      }
      assert.ok(findCommand(item.command), `${group.id}/${item.label} points at missing command ${item.command}`);
    }
  }
});

// -------------------------------------------------------------- managed routes

const routeStack = (services: any[], name = 'default') => ({
  name, project: 'app', dir: '/srv/apps/app', files: ['docker-compose.yml'],
  explicitFiles: [], mode: 'base', projectName: 'app', envFile: null, profiles: [],
  healthcheck: null, services, routes: [], networks: [], volumes: [], doc: {},
}) as any;

test('routes: the container port is inferred from the compose ports', async () => {
  const { inferPort } = await import('../src/routes.js');
  // "8084:80" means the container listens on 80, whatever the host publishes.
  assert.equal(inferPort({ ports: ['8084:80'] } as any), 80);
  assert.equal(inferPort({ ports: ['80'] } as any), 80);
  assert.equal(inferPort({ ports: ['0.0.0.0:8084:80/tcp'] } as any), 80);
  // Ambiguous or absent means it has to be stated, not guessed.
  assert.equal(inferPort({ ports: ['8080:80', '8443:443'] } as any), null);
  assert.equal(inferPort({ ports: [] } as any), null);
  assert.equal(inferPort(undefined), null);
});

test('routes: a bare hostname is enough for a single-service stack', async () => {
  const { resolveRoutes } = await import('../src/routes.js');
  const cfg = normalize(deepMerge(DEFAULTS, {
    projectsDir: '/srv/apps',
    traefik: { acme: { email: 'ops@example.com' } },
    projects: { app: { routes: ['app.example.com'] } },
  })) as any;
  const project = { name: 'app', repoConfig: {} } as any;
  const stack = routeStack([{ name: 'web', ports: ['8084:80'], networks: [] }]);

  const { routes, problems } = resolveRoutes(cfg, project, stack);
  assert.deepEqual(problems, []);
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.service, 'web', 'the only service needs no naming');
  assert.equal(routes[0]!.port, 80);
  assert.equal(routes[0]!.tls, true, 'TLS follows from having a certificate resolver');
  assert.equal(routes[0]!.entrypoint, 'websecure');
});

test('routes: what cannot be resolved is reported, not guessed', async () => {
  const { resolveRoutes } = await import('../src/routes.js');
  const base = { projectsDir: '/srv/apps' };
  const project = { name: 'app', repoConfig: {} } as any;

  // Two services and no `service:`, so blankey must not pick one.
  const ambiguous = normalize(deepMerge(DEFAULTS, { ...base, projects: { app: { routes: ['a.com'] } } })) as any;
  const two = resolveRoutes(ambiguous, project, routeStack([
    { name: 'web', ports: ['80'], networks: [] },
    { name: 'api', ports: ['3000'], networks: [] },
  ]));
  assert.equal(two.routes.length, 0);
  assert.match(two.problems[0]!, /which service/);

  // Named service that does not exist.
  const wrong = normalize(deepMerge(DEFAULTS, { ...base, projects: { app: { routes: [{ host: 'a.com', service: 'nope' }] } } })) as any;
  assert.match(resolveRoutes(wrong, project, routeStack([{ name: 'web', ports: ['80'], networks: [] }])).problems[0]!, /does not define/);

  // No port to infer and none given.
  const portless = normalize(deepMerge(DEFAULTS, { ...base, projects: { app: { routes: ['a.com'] } } })) as any;
  assert.match(resolveRoutes(portless, project, routeStack([{ name: 'web', ports: [], networks: [] }])).problems[0]!, /explicit port/);
});

test('routes: operator config outranks the repo, and stacks can differ', async () => {
  const { routeSpecsFor } = await import('../src/routes.js');
  const cfg = normalize(deepMerge(DEFAULTS, {
    projectsDir: '/srv/apps',
    projects: {
      app: {
        routes: ['live.example.com'],
        stacks: { staging: { routes: ['staging.example.com'] } },
      },
    },
  })) as any;
  const project = { name: 'app', repoConfig: { routes: ['from-the-repo.example.com'] } } as any;

  // The whole point is controlling routing without editing the repo.
  assert.deepEqual(routeSpecsFor(cfg, project, 'default'), [{ host: 'live.example.com' }]);
  // A stack-specific list replaces rather than adds to the project-wide one.
  assert.deepEqual(routeSpecsFor(cfg, project, 'staging'), [{ host: 'staging.example.com' }]);

  // With nothing configured centrally, the repo's own file is used.
  const bare = normalize(deepMerge(DEFAULTS, { projectsDir: '/srv/apps' })) as any;
  assert.deepEqual(routeSpecsFor(bare, project, 'default'), [{ host: 'from-the-repo.example.com' }]);
});

test('routes: the overlay is valid compose that adds labels and the network', async () => {
  const { resolveRoutes, renderOverlay } = await import('../src/routes.js');
  const cfg = normalize(deepMerge(DEFAULTS, {
    projectsDir: '/srv/apps',
    traefik: { network: 'proxy', acme: { email: 'ops@example.com', resolver: 'le' } },
    projects: { app: { routes: [{ host: 'app.example.com', path: '/api' }] } },
  })) as any;
  const { routes } = resolveRoutes(cfg, { name: 'app', repoConfig: {} } as any,
    routeStack([{ name: 'web', ports: ['8084:80'], networks: [] }]));

  const overlay = parseYaml(renderOverlay(cfg, routes));
  assert.deepEqual(overlay.services.web.networks, ['proxy']);
  assert.equal(overlay.networks.proxy.external, true);

  const labels = overlay.services.web.labels as string[];
  assert.ok(labels.includes('traefik.enable=true'));
  assert.ok(labels.some((l) => l.includes('rule=Host(`app.example.com`) && PathPrefix(`/api`)')));
  assert.ok(labels.some((l) => l.endsWith('loadbalancer.server.port=80')));
  assert.ok(labels.some((l) => l.includes('tls.certresolver=le')));
});

test('routes: several hostnames become one router rule', async () => {
  const { resolveRoutes, renderOverlay } = await import('../src/routes.js');
  const cfg = normalize(deepMerge(DEFAULTS, {
    projectsDir: '/srv/apps',
    projects: { app: { routes: [{ hosts: ['a.com', 'www.a.com'], tls: false }] } },
  })) as any;
  const { routes } = resolveRoutes(cfg, { name: 'app', repoConfig: {} } as any,
    routeStack([{ name: 'web', ports: ['80'], networks: [] }]));

  assert.deepEqual(routes[0]!.hosts, ['a.com', 'www.a.com']);
  assert.equal(routes[0]!.entrypoint, 'web', 'no TLS means the plain entrypoint');
  const labels = parseYaml(renderOverlay(cfg, routes)).services.web.labels as string[];
  assert.ok(labels.some((l) => l.includes('Host(`a.com`) || Host(`www.a.com`)')));
});

test('routes: the published host port is caught, not the container port', async () => {
  const { resolveRoutes } = await import('../src/routes.js');
  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: '/srv/apps' })) as any;
  const project = { name: 'app', repoConfig: {} } as any;
  // "8081:80": the container listens on 80, 8081 only exists on the host.
  const stack = routeStack([{ name: 'web', ports: ['8081:80'], networks: [] }]);

  // The exact mistake a person makes reaching for "the port I browse to".
  const wrong = normalize(deepMerge(DEFAULTS, {
    projectsDir: '/srv/apps', projects: { app: { routes: [{ host: 'app1.localhost', port: 8081 }] } },
  })) as any;
  const bad = resolveRoutes(wrong, project, stack);
  assert.equal(bad.routes.length, 0, 'a route that would 502 must not be written');
  assert.match(bad.problems[0]!, /published host port/);
  assert.match(bad.problems[0]!, /use the container port \(80\)/);

  // The correct container-side port must not be flagged.
  const right = normalize(deepMerge(DEFAULTS, {
    projectsDir: '/srv/apps', projects: { app: { routes: [{ host: 'app1.localhost', port: 80 }] } },
  })) as any;
  const good = resolveRoutes(right, project, stack);
  assert.equal(good.problems.length, 0);
  assert.equal(good.routes[0]!.port, 80);

  // Leaving port out entirely still infers correctly.
  const inferred = normalize(deepMerge(DEFAULTS, {
    projectsDir: '/srv/apps', projects: { app: { routes: ['app1.localhost'] } },
  })) as any;
  assert.equal(resolveRoutes(inferred, project, stack).routes[0]!.port, 80);
});

test('routes: a port that matches neither side of any mapping is not second-guessed', async () => {
  const { resolveRoutes } = await import('../src/routes.js');
  const cfg = normalize(deepMerge(DEFAULTS, {
    projectsDir: '/srv/apps', projects: { app: { routes: [{ host: 'a.com', port: 9000 }] } },
  })) as any;
  // An internal admin port the app listens on but nothing in compose publishes.
  const stack = routeStack([{ name: 'web', ports: ['8081:80'], networks: [] }]);
  const { routes, problems } = resolveRoutes(cfg, { name: 'app', repoConfig: {} } as any, stack);
  assert.equal(problems.length, 0, 'only a published-port match is flagged, not an unrelated number');
  assert.equal(routes[0]!.port, 9000);
});

test('routes: a plain repo gets routed without being edited', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-routes-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'test-project-4');
  await fs.mkdir(repo, { recursive: true });

  // Exactly the compose file a developer would write: no deployment concerns.
  const original = 'services:\n  web:\n    build: .\n    ports:\n      - "8084:80"\n';
  await fs.writeFile(path.join(repo, 'docker-compose.yml'), original);

  const cfg = normalize(deepMerge(DEFAULTS, {
    projectsDir: dir,
    traefik: { acme: { email: 'ops@example.com' } },
    projects: { 'test-project-4': { routes: ['app.example.com'] } },
  })) as any;

  const project = (await readProject(cfg, 'test-project-4', repo))!;
  const stack = project.stacks[0]!;

  // The route shows up everywhere routes are read from.
  assert.equal(stack.routes.length, 1);
  assert.deepEqual(stack.routes[0]!.urls, ['https://app.example.com']);
  assert.equal(stack.routes[0]!.port, 80);

  // Compose is given the repo file first, then the generated overlay, so
  // relative paths like `build: .` still resolve inside the repo.
  assert.equal(stack.explicitFiles.length, 2);
  assert.equal(stack.explicitFiles[0], 'docker-compose.yml');
  assert.match(stack.explicitFiles[1]!, /\.blankey[\\/]routes[\\/]/);

  // The overlay lives outside the repo, and the repo is untouched.
  assert.equal(await fs.readFile(path.join(repo, 'docker-compose.yml'), 'utf8'), original);
  assert.deepEqual(await fs.readdir(repo), ['docker-compose.yml']);
  assert.equal(await fs.readFile(stack.explicitFiles[1]!, 'utf8') !== '', true);
});

test('routes: a route naming an SSL configuration serves TLS without an ACME resolver', async () => {
  const { resolveRoutes, renderOverlay } = await import('../src/routes.js');
  const cfg = normalize(deepMerge(DEFAULTS, {
    projectsDir: '/srv/apps',
    traefik: { acme: { email: 'ops@example.com', resolver: 'le' } },
    projects: { app: { routes: [{ host: 'app.domainly.com', cert: 'domainly' }] } },
  })) as any;
  const { routes, problems } = resolveRoutes(cfg, { name: 'app', repoConfig: {} } as any,
    routeStack([{ name: 'web', ports: ['80'], networks: [] }]), { knownCerts: ['domainly'] });

  assert.deepEqual(problems, []);
  assert.equal(routes[0]!.tls, true, 'naming a certificate is itself the decision to serve HTTPS');
  assert.equal(routes[0]!.entrypoint, 'websecure');

  const labels = parseYaml(renderOverlay(cfg, routes)).services.web.labels as string[];
  assert.ok(labels.includes(`traefik.http.routers.${routes[0]!.router}.tls=true`));
  assert.ok(!labels.some((l) => l.includes('certresolver')), 'a named cert must not also trigger ACME');
});

test('routes: naming an SSL configuration that does not exist is reported', async () => {
  const { resolveRoutes } = await import('../src/routes.js');
  const cfg = normalize(deepMerge(DEFAULTS, {
    projectsDir: '/srv/apps',
    projects: { app: { routes: [{ host: 'app.domainly.com', cert: 'nope' }] } },
  })) as any;
  const { routes, problems } = resolveRoutes(cfg, { name: 'app', repoConfig: {} } as any,
    routeStack([{ name: 'web', ports: ['80'], networks: [] }]), { knownCerts: ['domainly'] });

  assert.equal(routes.length, 0);
  assert.match(problems[0]!, /SSL configuration "nope"/);

  // Omitting knownCerts entirely trusts the name instead, for callers that
  // only have the specs, not the filesystem.
  const trusting = resolveRoutes(cfg, { name: 'app', repoConfig: {} } as any,
    routeStack([{ name: 'web', ports: ['80'], networks: [] }]));
  assert.equal(trusting.problems.length, 0);
});

test('certs: installing writes both files under the traefik directory and refreshes the dynamic config', async (t) => {
  const { installCert, listCerts, removeCert, certsDynamicPath } = await import('../src/certs.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-certs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const source = path.join(dir, 'source');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'cert.pem'), '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
  await fs.writeFile(path.join(source, 'key.pem'), '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n');

  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: dir })) as any;
  await installCert(cfg, 'domainly', {
    certSourcePath: path.join(source, 'cert.pem'),
    keySourcePath: path.join(source, 'key.pem'),
    domains: ['domainly.com', '*.domainly.com'],
  });

  const certs = await listCerts(cfg);
  assert.equal(certs.length, 1);
  assert.equal(certs[0]!.name, 'domainly');
  assert.deepEqual(certs[0]!.domains, ['domainly.com', '*.domainly.com']);
  assert.equal(certs[0]!.hasFiles, true);

  // Traefik's file provider watches this file; a fixed container path so it
  // still resolves wherever traefik.dir actually is on the host.
  const dynamic = await fs.readFile(certsDynamicPath(cfg), 'utf8');
  assert.match(dynamic, /certFile: \/etc\/traefik\/certs\/domainly\/cert\.pem/);
  assert.match(dynamic, /keyFile: \/etc\/traefik\/certs\/domainly\/key\.pem/);

  await removeCert(cfg, 'domainly');
  assert.deepEqual(await listCerts(cfg), []);
  const afterRemove = await fs.readFile(certsDynamicPath(cfg), 'utf8');
  assert.ok(!afterRemove.includes('certFile'), 'the dynamic file is rewritten once nothing is left to list');
});

test('certs: a name with only one of the two files is not usable yet', async (t) => {
  const { certDir, listCerts } = await import('../src/certs.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-certs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: dir })) as any;

  await fs.mkdir(certDir(cfg, 'half'), { recursive: true });
  await fs.writeFile(path.join(certDir(cfg, 'half'), 'cert.pem'), 'only the cert so far');

  const certs = await listCerts(cfg);
  assert.equal(certs.length, 1);
  assert.equal(certs[0]!.hasFiles, false);
});

test('certs: files uploaded to the drop folder are listed, and never mistaken for a registered configuration', async (t) => {
  const { incomingCertsDir, listIncoming, listCerts } = await import('../src/certs.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-certs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: dir })) as any;

  await fs.mkdir(incomingCertsDir(cfg), { recursive: true });
  await fs.writeFile(path.join(incomingCertsDir(cfg), 'domainly.pem'), 'cert content');
  await fs.writeFile(path.join(incomingCertsDir(cfg), 'domainly.key'), 'key content');

  const incoming = await listIncoming(cfg);
  assert.deepEqual(incoming.map((f) => f.name), ['domainly.key', 'domainly.pem']);
  assert.ok(incoming.every((f) => f.size! > 0));

  // The drop folder sits next to certs/, not inside it, so its own contents
  // never show up as a half-registered SSL configuration.
  assert.deepEqual(await listCerts(cfg), []);
});

test('git: an SSH identity survives a clone, and can be unset again', async (t) => {
  const git = await import('../src/git.js');
  const { exec } = await import('../src/host.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-git-ssh-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const source = path.join(dir, 'source');
  const clonedDir = path.join(dir, 'clone');
  await fs.mkdir(source, { recursive: true });
  const run = async (cmd) => {
    const r = await exec(cmd, { cwd: source });
    if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr}`);
    return r.stdout;
  };
  await run('git init -q -b main .');
  await run('git config user.email t@t.io');
  await run('git config user.name Test');
  await fs.writeFile(path.join(source, 'a.txt'), 'one\n');
  await run('git add -A');
  await run('git commit -qm first');

  // A local path clone never actually invokes ssh, so core.sshCommand is
  // simply unused config, enough to prove it is accepted and, crucially,
  // still persisted afterwards for every later pull to pick up on its own.
  const fakeSsh = 'ssh -i /fake/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new';
  const cloned = await git.clone(source, clonedDir, { sshCommand: fakeSsh });
  assert.equal(cloned.ok, true, cloned.error ?? '');

  assert.equal(await git.sshIdentityCommand(clonedDir), null, 'a clone-time -c override is not persisted on its own');
  await git.setSshIdentity(clonedDir, fakeSsh);
  assert.equal(await git.sshIdentityCommand(clonedDir), fakeSsh);

  await git.clearSshIdentity(clonedDir);
  assert.equal(await git.sshIdentityCommand(clonedDir), null);
});

test('ssh-identities: generating makes a usable, fingerprintable key pair', async (t) => {
  const { generateIdentity, listIdentities, identitiesRoot } = await import('../src/ssh-identities.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-ssh-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: dir })) as any;

  assert.deepEqual(await listIdentities(cfg), []);
  await generateIdentity(cfg, 'deploy-key', { comment: 'shop-api deploy' });

  const identities = await listIdentities(cfg);
  assert.equal(identities.length, 1);
  const [identity] = identities;
  assert.equal(identity!.name, 'deploy-key');
  assert.equal(identity!.comment, 'shop-api deploy');
  assert.equal(identity!.hasFiles, true);
  assert.match(identity!.publicKey!, /^ssh-ed25519 /);
  assert.match(identity!.fingerprint!, /SHA256:/);
  assert.equal(identity!.privatePath, path.join(identitiesRoot(cfg), 'deploy-key', 'id_ed25519'));
});

test('ssh-identities: sshCommandFor never emits a backslash', async (t) => {
  // core.sshCommand is tokenized by git with its own shell-like rules
  // wherever it runs, so a raw Windows path would have its backslashes
  // silently eaten, breaking -i on the very next fetch or pull.
  const { generateIdentity, sshCommandFor } = await import('../src/ssh-identities.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-ssh-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: dir })) as any;

  await generateIdentity(cfg, 'deploy-key');
  const cmd = sshCommandFor(cfg, 'deploy-key');
  assert.ok(!cmd.includes('\\'), cmd);
  assert.match(cmd, /^ssh -i "[^"]+\/deploy-key\/id_ed25519" -o /);
});

test('ssh-identities: importing derives the public key when only the private one is given', async (t) => {
  const { importIdentity, listIdentities } = await import('../src/ssh-identities.js');
  const { exec } = await import('../src/host.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-ssh-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: dir })) as any;

  // Simulate "already had this key sitting somewhere" -- generated outside
  // blankey entirely, only the private half handed over.
  const existing = path.join(dir, 'existing_key');
  const keygen = await exec(`ssh-keygen -t ed25519 -N "" -C already-had-this -f ${existing}`);
  assert.equal(keygen.code, 0, keygen.stderr);
  const expectedPublic = (await fs.readFile(`${existing}.pub`, 'utf8')).trim();

  await importIdentity(cfg, 'imported', { privateSourcePath: existing, comment: 'imported' });

  const [identity] = await listIdentities(cfg);
  assert.equal(identity!.hasFiles, true);
  assert.equal(identity!.publicKey, expectedPublic);
});

test('ssh-identities: removing deletes the key pair', async (t) => {
  const { generateIdentity, removeIdentity, listIdentities } = await import('../src/ssh-identities.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-ssh-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: dir })) as any;

  await generateIdentity(cfg, 'temp');
  assert.equal((await listIdentities(cfg)).length, 1);
  await removeIdentity(cfg, 'temp');
  assert.deepEqual(await listIdentities(cfg), []);
});

test('ssh-identities: files uploaded to the drop folder are listed separately from the registry', async (t) => {
  const { incomingIdentitiesDir, listIncoming, listIdentities } = await import('../src/ssh-identities.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-ssh-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: dir })) as any;

  await fs.mkdir(incomingIdentitiesDir(cfg), { recursive: true });
  await fs.writeFile(path.join(incomingIdentitiesDir(cfg), 'id_deploy'), 'private key content');

  const incoming = await listIncoming(cfg);
  assert.deepEqual(incoming.map((f) => f.name), ['id_deploy']);
  assert.deepEqual(await listIdentities(cfg), []);
});

// --------------------------------------------------------------------- backup

test('backup: object keys round-trip their timestamp', async () => {
  const { stamp, parseStamp, objectKey, volumePrefix } = await import('../src/backup.js');
  const at = new Date('2026-09-07T03:15:00.000Z');
  const s = stamp(at);
  assert.equal(s, '20260907T031500Z');
  assert.equal(parseStamp(`x/y/${s}.tar.gz`)!.toISOString(), at.toISOString());
  assert.equal(parseStamp('x/y/not-a-stamp.tar.gz'), null);

  const cfg = { backup: { prefix: 'blankey' } };
  assert.equal(
    objectKey(cfg, { project: 'shop', stack: 'default', volume: 'shop_db', at: s }),
    'blankey/shop/default/shop_db/20260907T031500Z.tar.gz',
  );
  assert.equal(volumePrefix(cfg, { project: 'shop' }), 'blankey/shop');
});

test('backup: retention keeps three weeks and drops what is older', async () => {
  const { planRetention } = await import('../src/backup.js');
  const now = new Date('2026-09-07T00:00:00Z');
  const daysAgo = (d) => new Date(now.getTime() - d * 86400000);
  const obj = (volume, days, size = 100) => {
    const at = daysAgo(days);
    const s = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    return { key: `blankey/shop/default/${volume}/${s}.tar.gz`, size, at };
  };

  const objects = [obj('db', 1), obj('db', 10), obj('db', 20), obj('db', 22), obj('db', 60)];
  const plan = planRetention(objects, { retentionDays: 21, keepMinimum: 1, now });

  assert.equal(plan.remove.length, 2, 'the 22 and 60 day old copies go');
  assert.equal(plan.keep.length, 3);
  for (const kept of plan.keep) {
    assert.ok(now.getTime() - kept.at!.getTime() <= 21 * 86400000);
  }
  assert.equal(plan.freed, 200);
});

test('backup: the last copy of a volume survives however old it is', async () => {
  const { planRetention } = await import('../src/backup.js');
  const now = new Date('2026-09-07T00:00:00Z');
  const at = new Date(now.getTime() - 400 * 86400000);
  const s = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const objects = [{ key: `blankey/shop/default/uploads/${s}.tar.gz`, size: 10, at }];

  const plan = planRetention(objects, { retentionDays: 21, keepMinimum: 1, now });
  assert.deepEqual(plan.remove, [], 'deleting the only backup of a volume would leave nothing');
  assert.equal(plan.keep.length, 1);
});

test('backup: retention is per volume and ignores keys it did not write', async () => {
  const { planRetention } = await import('../src/backup.js');
  const now = new Date('2026-09-07T00:00:00Z');
  const old = new Date(now.getTime() - 30 * 86400000);
  const s = old.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const objects = [
    { key: `blankey/shop/default/db/${s}.tar.gz`, size: 1, at: old },
    { key: `blankey/shop/default/db/${stampFor(now)}.tar.gz`, size: 1, at: now },
    { key: `blankey/shop/default/uploads/${s}.tar.gz`, size: 1, at: old },
    { key: 'blankey/notes.txt', size: 1, at: old },
    { key: 'blankey/shop/default/db/manual-copy.tar.gz', size: 1, at: old },
  ];
  const plan = planRetention(objects, { retentionDays: 21, keepMinimum: 1, now });

  // db has a newer copy so the old one goes; uploads has only one so it stays.
  assert.deepEqual(plan.remove.map((o) => o.key), [`blankey/shop/default/db/${s}.tar.gz`]);
  assert.equal(plan.skippedForeign, 2, 'files this tool did not name are never touched');
});

function stampFor(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

test('config: s3 endpoints derive from provider and region', async () => {
  const { resolveBackup, backupProblems } = await import('../src/config.js');

  const hetzner = resolveBackup({ backup: { s3: { provider: 'hetzner', region: 'fsn1', bucket: 'b' } } });
  assert.equal(hetzner.s3.endpoint, 'https://fsn1.your-objectstorage.com');

  const ocean = resolveBackup({ backup: { s3: { provider: 'digitalocean', region: 'ams3', bucket: 'b' } } });
  assert.equal(ocean.s3.endpoint, 'https://ams3.digitaloceanspaces.com');

  // An explicit endpoint always wins.
  const custom = resolveBackup({ backup: { s3: { provider: 'hetzner', region: 'fsn1', endpoint: 'https://minio.local' } } });
  assert.equal(custom.s3.endpoint, 'https://minio.local');

  assert.equal(hetzner.retentionDays, 21);
  assert.ok(backupProblems(hetzner).some((p) => p.includes('accessKeyId')));
});

test('config: credentials can come from the environment instead of the file', async (t) => {
  const { resolveBackup, backupProblems } = await import('../src/config.js');
  process.env.BLANKEY_S3_ACCESS_KEY_ID = 'from-env';
  process.env.BLANKEY_S3_SECRET_ACCESS_KEY = 'secret-env';
  t.after(() => {
    delete process.env.BLANKEY_S3_ACCESS_KEY_ID;
    delete process.env.BLANKEY_S3_SECRET_ACCESS_KEY;
  });
  const cfg = resolveBackup({ backup: { s3: { provider: 'hetzner', region: 'fsn1', bucket: 'b', accessKeyId: 'in-file' } } });
  assert.equal(cfg.s3.accessKeyId, 'from-env', 'env wins so secrets need not live in the config');
  assert.deepEqual(backupProblems(cfg), []);
});

// ------------------------------------------------------------------ schedule

test('schedule: friendly specs become both cron and OnCalendar', async () => {
  const { normalizeSchedule } = await import('../src/schedule.js');

  const daily = normalizeSchedule('daily', { at: '03:30' });
  assert.equal(daily.cron, '30 3 * * *');
  assert.equal(daily.onCalendar, '*-*-* 03:30:00');

  const weekly = normalizeSchedule('weekly', { at: '04:05' });
  assert.equal(weekly.cron, '5 4 * * 1');
  assert.equal(weekly.onCalendar, 'Mon *-*-* 04:05:00');

  const hourly = normalizeSchedule('hourly', { at: '00:15' });
  assert.equal(hourly.cron, '15 * * * *');

  // A raw cron expression passes through untouched.
  const raw = normalizeSchedule('*/30 2 * * *');
  assert.equal(raw.cron, '*/30 2 * * *');
  assert.equal(raw.onCalendar, null);
});

test('schedule: the job is one fixed file, so installing replaces it', async () => {
  const { unitFiles } = await import('../src/schedule.js');
  const schedule = { cron: '30 3 * * *', onCalendar: '*-*-* 03:30:00' };
  const files = unitFiles('blankey-backup', {
    binary: '/usr/local/bin/blankey',
    configPath: '/etc/blankey/config.yml',
    schedule,
    args: '',
  });

  // Whatever the mechanism, the run is unattended and covers every project.
  assert.match(files.command, /backup --all --yes --quiet/);
  assert.match(files.command, /--config \/etc\/blankey\/config\.yml/);
  assert.match(files.service, /ExecStart=\/usr\/local\/bin\/blankey backup --all/);
  assert.match(files.timer, /OnCalendar=\*-\*-\* 03:30:00/);
  assert.match(files.timer, /Persistent=true/);
  // A cron.d line needs the user field, unlike a user crontab.
  assert.match(files.cron, /^30 3 \* \* \* root \//m);
});

// --------------------------------------------------------------------- lock

test('lock: a second holder is refused until the first releases', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { acquire, withLock } = await import('../src/lock.js');
  const cfg = { projectsDir: dir };

  const first = await acquire(cfg, 'backup');
  assert.equal(first.ok, true);

  const second = await acquire(cfg, 'backup');
  assert.equal(second.ok, false);
  assert.match(String((second as any).reason), /already running/);

  if (first.ok) await first.release();

  const third = await acquire(cfg, 'backup');
  assert.equal(third.ok, true, 'releasing must free the lock');
  if (third.ok) await third.release();
});

test('lock: a stale lock is broken rather than blocking forever', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { acquire } = await import('../src/lock.js');
  const cfg = { projectsDir: dir };

  const held = await acquire(cfg, 'backup');
  assert.equal(held.ok, true);

  // Same lock, but the owner looks hours old: it must be taken over.
  const fresh = await acquire(cfg, 'backup', { staleAfter: -1 });
  assert.equal(fresh.ok, true);
  if (fresh.ok) await fresh.release();
});

test('lock: withLock releases even when the body throws', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blankey-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { withLock, acquire } = await import('../src/lock.js');
  const cfg = { projectsDir: dir };

  await assert.rejects(withLock(cfg, 'backup', () => { throw new Error('boom'); }));
  const after = await acquire(cfg, 'backup');
  assert.equal(after.ok, true, 'a failed run must not leave the lock held');
  if (after.ok) await after.release();
});

// -------------------------------------------------------------------- cleanup

test('util: docker size strings parse back to bytes', () => {
  assert.equal(parseSize('1.2GB'), 1_200_000_000);
  assert.equal(parseSize('938.4MB'), 938_400_000);
  assert.equal(parseSize('6.1GB (66%)'), 6_100_000_000);
  assert.equal(parseSize('0B (virtual 123MB)'), 0);
  assert.equal(parseSize('142MB (virtual 1.1GB)'), 142_000_000);
  // docker stats reports binary units, docker system df decimal ones.
  assert.equal(parseSize('1.204GiB'), Math.round(1.204 * 1024 ** 3));
  assert.equal(parseSize('312.4MiB'), Math.round(312.4 * 1024 ** 2));
  assert.equal(parseSize(4096), 4096);
  // Anything unreadable counts as nothing, so totals stay addable.
  assert.equal(parseSize(''), 0);
  assert.equal(parseSize(undefined), 0);
  assert.equal(parseSize('N/A'), 0);
});

test('clean: volumes are never swept up by --safe', async () => {
  const { SAFE, ALL, resolveTargets } = await import('../src/commands/clean.js');
  assert.equal(SAFE.includes('volumes'), false, 'volumes hold data and must be asked for by name');
  assert.equal(SAFE.includes('unused-images'), false);
  assert.equal(ALL.includes('volumes'), true);

  const safe = resolveTargets({ positional: [], flags: { safe: true } });
  assert.deepEqual(safe.names.sort(), [...SAFE].sort());
  assert.equal(safe.names.includes('volumes'), false);
});

test('clean: target selection from names and flags', async () => {
  const { ALL, resolveTargets } = await import('../src/commands/clean.js');
  // No target named means preview only.
  assert.deepEqual(resolveTargets({ positional: [], flags: {} }).names, []);

  assert.deepEqual(resolveTargets({ positional: ['logs', 'cache'], flags: {} }).names, ['logs', 'cache']);
  assert.deepEqual(resolveTargets({ positional: [], flags: { all: true } }).names.sort(), [...ALL].sort());
  assert.deepEqual(resolveTargets({ positional: [], flags: { logs: true } }).names, ['logs']);

  // Named plus flag must not duplicate.
  const both = resolveTargets({ positional: ['logs'], flags: { safe: true } });
  assert.equal(new Set(both.names).size, both.names.length);

  const bad = resolveTargets({ positional: ['logz', 'cache'], flags: {} });
  assert.deepEqual(bad.invalid, ['logz']);
  assert.deepEqual(bad.names, ['cache']);
});

// ------------------------------------------------------------------ log files

test('docker: json-file logs are cleared at the path inspect reports', async () => {
  const { parseLogTarget } = await import('../src/docker.js');
  const target = parseLogTarget('json-file|/var/lib/docker/containers/abc/abc-json.log|abc', '');
  assert.equal(target.driver, 'json-file');
  assert.deepEqual(target.paths, ['/var/lib/docker/containers/abc/abc-json.log']);
});

test('docker: the local driver path is derived from the docker root', async () => {
  const { parseLogTarget } = await import('../src/docker.js');
  const target = parseLogTarget('local|<no value>|abc123', '/var/lib/docker/');
  assert.deepEqual(target.paths, ['/var/lib/docker/containers/abc123/local-logs/container.log']);
});

test('docker: drivers without a log file offer nothing to clear', async () => {
  const { parseLogTarget } = await import('../src/docker.js');
  for (const driver of ['journald', 'syslog', 'awslogs', 'none']) {
    const target = parseLogTarget(`${driver}|<no value>|abc123`, '/var/lib/docker');
    assert.deepEqual(target.paths, [], `${driver} must not be truncated`);
    assert.equal(target.driver, driver);
  }
  // Nothing usable from a blank inspect either.
  assert.deepEqual(parseLogTarget('', '').paths, []);
  assert.deepEqual(parseLogTarget('local|<no value>|', '/var/lib/docker').paths, []);
});

// --------------------------------------------------------- container grouping

test('lifecycle: containers group under the repo that owns their compose project', async () => {
  const { groupContainers } = await import('../src/commands/lifecycle.js');
  const projects = [
    { name: 'shop-api', stacks: [{ projectName: 'shop-api' }, { projectName: 'shop-api' }] },
    { name: 'blog', stacks: [{ projectName: 'blog-live' }] },
  ];
  const containers = [
    { name: 'traefik', project: 'traefik', service: 'traefik' },
    { name: 'shop-api-db-1', project: 'shop-api', service: 'db' },
    { name: 'shop-api-api-1', project: 'shop-api', service: 'api' },
    { name: 'blog-live-ghost-1', project: 'blog-live', service: 'ghost' },
  ];
  const groups = groupContainers(containers, projects);
  assert.deepEqual(groups.map(([name]) => name), ['blog', 'shop-api', 'traefik']);
  // Known repos come first, and services sort within a group.
  assert.deepEqual(groups[1][1].map((ct) => ct.service), ['api', 'db']);
  assert.equal(groups[2][1][0].name, 'traefik');
});

test('prompt: separators are never selectable', async () => {
  const { select } = await import('../src/ui/prompt.js');
  // Not a TTY under the test runner, so select resolves to the first pickable.
  const value = await select('pick', [
    { separator: 'group one' },
    { label: 'first', value: 'a' },
    { separator: 'group two' },
    { label: 'second', value: 'b' },
  ]);
  assert.equal(value, 'a');
  assert.equal(await select('pick', [{ separator: 'nothing here' }]), undefined);
});

// ----------------------------------------------------------------- templates

test('templates: generated traefik files are parseable and wired together', () => {
  const cfg = normalize(deepMerge(DEFAULTS, {
    projectsDir: '/srv/apps',
    domain: 'example.com',
    traefik: { acme: { email: 'ops@example.com' } },
  }));
  const compose = parseYaml(traefikCompose(cfg));
  assert.equal(compose.networks.proxy.external, true);
  assert.ok(compose.services.traefik.labels.includes('blankey.role=traefik'));
  assert.ok(compose.services.traefik.ports.includes('127.0.0.1:8080:8080'));

  const staticCfg = parseYaml(traefikStatic(cfg));
  assert.equal(staticCfg.providers.docker.exposedByDefault, false);
  assert.equal(staticCfg.providers.docker.network, 'proxy');
  assert.equal(staticCfg.certificatesResolvers.le.acme.email, 'ops@example.com');
  assert.equal(staticCfg.entryPoints.web.http.redirections.entryPoint.to, 'websecure');
});

test('templates: no acme email means no resolver and no https redirect', () => {
  const cfg = normalize(deepMerge(DEFAULTS, { projectsDir: '/srv/apps' }));
  const staticCfg = parseYaml(traefikStatic(cfg));
  assert.equal(staticCfg.certificatesResolvers, undefined);
  assert.equal(staticCfg.entryPoints.web.http, undefined);
});

// --------------------------------------------------------------- autostart

test('autostart: the login snippet is guarded so it cannot lock anyone out', async () => {
  const { renderSnippet } = await import('../src/commands/autostart.js');
  const snippet = renderSnippet();

  // Interactive-only, so `ssh host <command>` never reaches it.
  assert.match(snippet, /case \$- in/);
  assert.match(snippet, /\*i\*\)/);
  // A real terminal on both ends, so scp/sftp/rsync are unaffected.
  assert.ok(snippet.includes('[ -t 0 ]') && snippet.includes('[ -t 1 ]'));
  // Both escape hatches.
  assert.match(snippet, /BLANKEY_NO_AUTOSTART/);
  assert.match(snippet, /BLANKEY_ACTIVE/);
  // Never runs a binary that is not there.
  assert.match(snippet, /command -v blankey/);
  // Plain run, so quitting blankey leaves you at a shell.
  assert.ok(!/\bexit\b/.test(snippet));
});

test('autostart: kiosk ends the session, and never by exec', async () => {
  const { renderSnippet } = await import('../src/commands/autostart.js');
  const kiosk = renderSnippet({ kiosk: true });
  assert.match(kiosk, /\n\s+exit\n/);
  // `exec` would kill the shell outright if the binary could not be run.
  assert.ok(!/exec /.test(kiosk));
});

test('autostart: ssh-only adds the SSH_CONNECTION guard', async () => {
  const { renderSnippet } = await import('../src/commands/autostart.js');
  assert.ok(!renderSnippet().includes('SSH_CONNECTION'));
  assert.match(renderSnippet({ sshOnly: true }), /SSH_CONNECTION/);
});

test('autostart: the fish snippet uses fish syntax and checks it is a login shell', async () => {
  const { renderSnippet } = await import('../src/commands/autostart.js');
  const snippet = renderSnippet({ family: 'fish' });
  // fish conf.d runs for every interactive shell, not just login ones.
  assert.match(snippet, /status is-login/);
  assert.match(snippet, /command -q blankey/);
  assert.match(snippet, /\nend\n/);
  assert.ok(!snippet.includes('case $-'));
});

test('autostart: enabling is idempotent and disabling restores the file exactly', async () => {
  const { renderSnippet, withSnippet, withoutSnippet, hasSnippet } =
    await import('../src/commands/autostart.js');
  const original = 'export PATH="$HOME/bin:$PATH"\n# mine\numask 022\n';
  const snippet = renderSnippet();

  const once = withSnippet(original, snippet);
  assert.ok(hasSnippet(once));
  assert.ok(once.includes('umask 022'), 'existing content survives');

  // Re-running must replace the block, not stack a second copy.
  const twice = withSnippet(once, snippet);
  assert.equal(twice, once);
  assert.equal(twice.split('>>> blankey autostart >>>').length - 1, 1);

  // Changing the options rewrites in place rather than appending.
  const changed = withSnippet(once, renderSnippet({ kiosk: true }));
  assert.equal(changed.split('>>> blankey autostart >>>').length - 1, 1);
  assert.match(changed, /\n\s+exit\n/);

  assert.equal(withoutSnippet(once), original);
  assert.equal(withoutSnippet(changed), original);
  assert.equal(withoutSnippet(original), original, 'removing when absent changes nothing');
});

test('autostart: a file that is only the snippet comes back empty, not blank-padded', async () => {
  const { renderSnippet, withSnippet, withoutSnippet } = await import('../src/commands/autostart.js');
  const only = withSnippet('', renderSnippet());
  assert.equal(withoutSnippet(only).trim(), '');
});

test('autostart: shell family detection picks fish out', async () => {
  const { shellFamily } = await import('../src/commands/autostart.js');
  assert.equal(shellFamily('/usr/bin/fish'), 'fish');
  assert.equal(shellFamily('/bin/bash'), 'posix');
  assert.equal(shellFamily('/bin/zsh'), 'posix');
  assert.equal(shellFamily(''), 'posix');
});
