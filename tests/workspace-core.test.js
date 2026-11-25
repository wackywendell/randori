import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseSettings,
  tilde,
  untilde,
  worktreesBase,
  resolveWorktreePath,
  normalizeLink,
  planCreate,
  buildLinkScript,
  DISK_SCAN,
  parseDiskScan,
  resolveDiskCandidates,
  emptyModel,
  reduce,
  sortedRepos,
  resolveSlashChip,
  matchingIdleDiskRepos,
  indexOpenCheckouts,
  destination,
  placementFor,
  project,
  locKey,
  ownerRoot,
} from '../mods/jj-workspace/core.js';

test('segment-bounded tilde/untilde and worktreesBase', () => {
  assert.equal(tilde('/Users/alice', '/Users/alice'), '~');
  assert.equal(tilde('/Users/alice/code', '/Users/alice'), '~/code');
  assert.equal(tilde('/Users/alice2/code', '/Users/alice'), '/Users/alice2/code');
  assert.equal(untilde('~/code', '/Users/alice'), '/Users/alice/code');
  assert.equal(untilde('~alice/code', '/Users/alice'), '~alice/code');
  assert.equal(worktreesBase('~/.herdr/worktrees/{repo}/{name}', '/Users/alice'), '/Users/alice/.herdr/worktrees');
  assert.equal(
    resolveWorktreePath('~/.herdr/worktrees/{repo}/{name}', '/Users/alice/code/randori', 'feat/auth', '/Users/alice'),
    '/Users/alice/.herdr/worktrees/randori/feat-auth',
  );
});

test('parseSettings and normalizeLink validate at the boundary', () => {
  const s = parseSettings({ openIn: 'tab', links: [' mise.toml ', '/abs', '../up', 'sub/file.txt', 'dir/'], miseTrust: false, repos: ['~/code/*', ''] });
  assert.equal(s.openIn, 'tab');
  assert.equal(s.miseTrust, false);
  assert.deepEqual(s.repos, ['~/code/*']);

  const plan = planCreate({ repo: { main: '/r/app' }, name: 'fix', settings: s, home: '/home/u' });
  assert.deepEqual(plan.links.map((l) => l.rel), ['mise.toml', 'sub/file.txt']);
  assert.equal(plan.links[0].isMise, true);
  assert.equal(plan.links[1].isMise, false);

  assert.equal(normalizeLink(''), null);
  assert.equal(normalizeLink('/etc/passwd'), null);
  assert.equal(normalizeLink('a/../b'), null);
  assert.equal(normalizeLink('dir/'), null);
  assert.deepEqual(normalizeLink('  .mise.toml '), { rel: '.mise.toml', isMise: true });
});

test('buildLinkScript creates symlinks in one sh invocation and skips missing/existing silently', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'randori-links-'));
  try {
    const main = path.join(tmp, 'main');
    const dest = path.join(tmp, 'wt');
    await fs.mkdir(path.join(main, 'nested'), { recursive: true });
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(main, 'AGENTS.local.md'), 'hello');
    await fs.writeFile(path.join(main, 'nested/cfg.txt'), 'cfg');
    await fs.writeFile(path.join(dest, 'existing.txt'), 'keep');
    await fs.writeFile(path.join(main, 'existing.txt'), 'main-ver');

    const plan = planCreate({
      repo: { main },
      name: 'wt',
      settings: parseSettings({
        directory: dest,
        links: ['AGENTS.local.md', 'nested/cfg.txt', 'missing.txt', 'existing.txt'],
        miseTrust: false,
      }),
      home: tmp,
    });
    const { script, args } = buildLinkScript({ ...plan, dest });
    execFileSync('sh', ['-c', script, 'sh', ...args], { encoding: 'utf8' });

    assert.equal(await fs.readlink(path.join(dest, 'AGENTS.local.md')), path.join(main, 'AGENTS.local.md'));
    assert.equal(await fs.readlink(path.join(dest, 'nested/cfg.txt')), path.join(main, 'nested/cfg.txt'));
    assert.equal(await fs.readFile(path.join(dest, 'existing.txt'), 'utf8'), 'keep');
    await assert.rejects(() => fs.lstat(path.join(dest, 'missing.txt')));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('DISK_SCAN handles depth-1 and depth-2 worktrees, linked pointer mtime, strict globs, and exits 0', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'randori-scan-'));
  try {
    const code = path.join(tmp, 'code');
    const wtBase = path.join(tmp, 'wt');
    const plain = path.join(tmp, 'plain-dir');
    const dot = path.join(tmp, '.dotfiles');
    // Main repo under code/*
    await fs.mkdir(path.join(code, 'alpha/.jj/repo/op_heads/heads'), { recursive: true });
    // Plain dir with nested child repo (plain path must NOT descend)
    await fs.mkdir(path.join(plain, 'nested/.jj/repo/op_heads/heads'), { recursive: true });
    // Plain path that IS a jj repo
    await fs.mkdir(path.join(dot, '.jj/repo/op_heads/heads'), { recursive: true });
    // Depth-1 linked worktree under wtBase: wt/beta-topic -> points to code/beta/.jj/repo
    await fs.mkdir(path.join(code, 'beta/.jj/repo/op_heads/heads'), { recursive: true });
    await fs.mkdir(path.join(wtBase, 'beta-topic/.jj'), { recursive: true });
    await fs.writeFile(path.join(wtBase, 'beta-topic/.jj/repo'), path.join(code, 'beta/.jj/repo'));
    // Depth-2 linked worktree under wtBase: wt/gamma/fix -> points to code/gamma/.jj/repo
    await fs.mkdir(path.join(code, 'gamma/.jj/repo/op_heads/heads'), { recursive: true });
    await fs.mkdir(path.join(wtBase, 'gamma/fix/.jj'), { recursive: true });
    await fs.writeFile(path.join(wtBase, 'gamma/fix/.jj/repo'), path.join(code, 'gamma/.jj/repo'));

    const stdout = execFileSync(
      'sh',
      ['-c', DISK_SCAN, 'sh', wtBase, `${code}/*`, plain, dot, `${tmp}/does-not-exist/*`],
      { encoding: 'utf8' },
    );
    const entries = parseDiskScan(stdout);
    const mains = resolveDiskCandidates(entries).map((c) => c.main).sort();
    assert.deepEqual(
      mains,
      [dot, path.join(code, 'alpha'), path.join(code, 'beta'), path.join(code, 'gamma')].sort(),
    );
    assert.ok(entries.every((e) => e.mtime > 0));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('destination() covers all 16 combinations of the placement truth table', () => {
  // !canTab: shift always refuses; Enter switches if open else new space
  for (const openIn of ['space', 'tab']) {
    assert.equal(destination({ isOpen: false, canTab: false, shift: false, openIn }), 'space');
    assert.equal(destination({ isOpen: true, canTab: false, shift: false, openIn }), 'switch');
    assert.equal(destination({ isOpen: false, canTab: false, shift: true, openIn }), 'refuse-tab');
    assert.equal(destination({ isOpen: true, canTab: false, shift: true, openIn }), 'refuse-tab');
  }
  // canTab + openIn: "space"
  assert.equal(destination({ isOpen: false, canTab: true, shift: false, openIn: 'space' }), 'space');
  assert.equal(destination({ isOpen: true, canTab: true, shift: false, openIn: 'space' }), 'switch');
  assert.equal(destination({ isOpen: false, canTab: true, shift: true, openIn: 'space' }), 'tab');
  assert.equal(destination({ isOpen: true, canTab: true, shift: true, openIn: 'space' }), 'tab');
  // canTab + openIn: "tab"
  assert.equal(destination({ isOpen: false, canTab: true, shift: false, openIn: 'tab' }), 'tab');
  assert.equal(destination({ isOpen: true, canTab: true, shift: false, openIn: 'tab' }), 'switch');
  assert.equal(destination({ isOpen: false, canTab: true, shift: true, openIn: 'tab' }), 'space');
  assert.equal(destination({ isOpen: true, canTab: true, shift: true, openIn: 'tab' }), 'space');
});

test('indexOpenCheckouts uses tab order, ownerRoot nested protection, and dedicated-space preference', () => {
  const spaces = [
    { id: 's-mixed', name: 'Mixed', machine: null, folder: '/r/app', tabs: [{ id: 't1' }, { id: 't2' }] },
    { id: 's-ded', name: 'Dedicated', machine: null, folder: '/r/app/.wt/sub', tabs: [{ id: 't3' }] },
  ];
  const panes = [
    { pane: 'p2', tab: 't2', terminal: 'x2', cwd: '/r/app/.wt/sub' },
    { pane: 'p1', tab: 't1', terminal: 'x1', cwd: '/r/app/src' },
    { pane: 'p3', tab: 't3', terminal: 'x3', cwd: '/r/app/.wt/sub/pkg' },
  ];
  const rootsByMachine = new Map([['', ['/r/app', '/r/app/.wt/sub']]]);
  const open = indexOpenCheckouts(spaces, panes, rootsByMachine);

  // Nested checkout is attributed to /r/app/.wt/sub (NOT /r/app) and prefers dedicated space s-ded.
  assert.equal(ownerRoot(null, '/r/app/.wt/sub/pkg', ['/r/app', '/r/app/.wt/sub']), '/r/app/.wt/sub');
  assert.equal(open.get(locKey(null, '/r/app/.wt/sub'))?.spaceId, 's-ded');
  assert.equal(open.get(locKey(null, '/r/app'))?.spaceId, 's-mixed');
  assert.equal(open.get(locKey(null, '/r/app'))?.tabId, 't1');
});

test('reduce is immutable and sortedRepos prioritizes space > same-machine other > cross-machine other > disk', () => {
  const m0 = emptyModel();
  let m = reduce(m0, { type: 'TargetResolved', spaceId: 's1', machine: 'retriever' });
  m = reduce(m, { type: 'RepoFound', on: null, main: '/local/disk-old', source: 'disk', mtime: 10 });
  m = reduce(m, { type: 'RepoFound', on: 'retriever', main: '/rem/disk-new', source: 'disk', mtime: 50 });
  m = reduce(m, { type: 'RepoFound', on: null, main: '/local/other', source: 'other', order: 0 });
  m = reduce(m, { type: 'RepoFound', on: 'retriever', main: '/rem/other', source: 'other', order: 2 });
  m = reduce(m, { type: 'RepoFound', on: 'retriever', main: '/rem/cur', source: 'space', order: 1, spaceId: 's1' });

  // Original model untouched
  assert.equal(m0.repos.size, 0);
  assert.deepEqual(
    sortedRepos(m).map((r) => `${r.source}:${r.on ?? 'local'}:${r.name}`),
    [
      'space:retriever:cur',
      'other:retriever:other',
      'other:local:other',
      'disk:retriever:disk-new',
      'disk:local:disk-old',
    ],
  );
  // Disk repos start idle; open-space repos start loading.
  assert.equal(m.repos.get(locKey('retriever', '/rem/disk-new')).load.state, 'idle');
  assert.equal(m.repos.get(locKey('retriever', '/rem/cur')).load.state, 'loading');
});

test('project() supports Flat Search, Option 1 disk folding, literal slashes, cross-repo search, and Repo Chip', () => {
  const settings = parseSettings({ openIn: 'space' });
  let m = emptyModel();
  m = reduce(m, { type: 'TargetResolved', spaceId: 's1', machine: null });
  m = reduce(m, { type: 'RepoFound', on: null, main: '/code/randori', source: 'space', order: 0, spaceId: 's1' });
  m = reduce(m, { type: 'FocusResolved', key: locKey(null, '/code/randori'), root: '/code/randori' });
  m = reduce(m, {
    type: 'RepoLoaded',
    key: locKey(null, '/code/randori'),
    list: [
      { name: 'default', path: '/code/randori', main: true },
      { name: 'ux-fixes', path: '/wt/randori/ux-fixes', main: false },
    ],
  });
  m = reduce(m, { type: 'RepoFound', on: null, main: '/code/streams', source: 'other', order: 1, spaceId: 's2' });
  m = reduce(m, {
    type: 'RepoLoaded',
    key: locKey(null, '/code/streams'),
    list: [
      { name: 'default', path: '/code/streams', main: true },
      { name: 'cli-by-entity', path: '/wt/streams/cli-by-entity', main: false },
    ],
  });
  m = reduce(m, { type: 'RepoFound', on: null, main: '/home/u/.dotfiles', source: 'disk', mtime: 100 });
  m = reduce(m, { type: 'TargetLoaded' });

  const spaces = [{ id: 's1', name: 'Randori', machine: null, folder: '/code/randori', tabs: [{ id: 't1' }] }];
  const panes = [{ pane: 'p1', tab: 't1', terminal: 'x1', cwd: '/code/randori' }];

  // 1. Empty query folds disk repo into disk-hint (Option 1) and emits no selectable repo rows.
  const emptyVm = project({ model: m, query: '', spaces, panes, settings });
  assert.ok(emptyVm.items.some((it) => it.kind === 'disk-hint' && it.count === 1));
  assert.ok(!emptyVm.items.some((it) => it.kind === 'repo'));
  assert.equal(emptyVm.picks[0].kind, 'ws');
  assert.equal(emptyVm.picks[0].ws.name, 'default');

  // 2. Typing "dot" reveals matching idle disk repo for lazy load + New workspace in .dotfiles…
  assert.deepEqual(matchingIdleDiskRepos(m, 'dot').map((r) => r.name), ['.dotfiles']);
  const dotVm = project({ model: m, query: 'dot', spaces, panes, settings });
  assert.ok(dotVm.items.some((it) => it.kind === 'header' && it.repo.name === '.dotfiles'));
  assert.equal(dotVm.picks[0].kind, 'create');
  assert.equal(dotVm.picks[0].name, '');
  assert.equal(dotVm.picks[0].repo.name, '.dotfiles');
  assert.equal(dotVm.primary.action, 'scope');

  // 3. Unconditional `/` rule while unscoped:
  //    - bare `/` locks the highlighted row's repo (`randori` on empty, or `streams` if arrowed there)
  //    - `strea` selects `+ New workspace in streams…` FIRST, and `strea/` locks `streams`
  //    - pasted `/feat/auth` locks `randori` with rest `"feat/auth"`
  //    - pasted `streams/fix` locks `streams` with rest `"fix"`
  const streaVm = project({ model: m, query: 'strea', spaces, panes, settings });
  assert.equal(streaVm.picks[0].kind, 'create');
  assert.equal(streaVm.picks[0].name, '');
  assert.equal(streaVm.picks[0].repo.name, 'streams');
  assert.equal(streaVm.picks[1].kind, 'ws');
  assert.equal(streaVm.picks[1].ws.name, 'default');

  const allRepos = sortedRepos(m);
  const randori = allRepos.find((r) => r.name === 'randori');
  const streams = allRepos.find((r) => r.name === 'streams');
  assert.deepEqual(
    resolveSlashChip('', '/', emptyVm.current, randori, allRepos),
    { repo: randori, rest: '' },
  );
  assert.deepEqual(
    resolveSlashChip('', '/', { repo: streams }, randori, allRepos),
    { repo: streams, rest: '' },
  );
  assert.deepEqual(
    resolveSlashChip('strea', 'strea/', streaVm.picks[0], randori, allRepos),
    { repo: streams, rest: '' },
  );
  assert.deepEqual(
    resolveSlashChip('', '/feat/auth', emptyVm.current, randori, allRepos),
    { repo: randori, rest: 'feat/auth' },
  );
  assert.deepEqual(
    resolveSlashChip('', 'streams/fix', emptyVm.current, randori, allRepos),
    { repo: streams, rest: 'fix' },
  );
  // Arrowing to the 2nd duplicate repo before typing `/` locks THAT repo unambiguously.
  const dup = [
    { name: 'api', on: null },
    { name: 'api', on: 'retriever' },
  ];
  assert.equal(resolveSlashChip('ap', 'ap/', { repo: dup[1] }, dup[0], dup)?.repo.on, 'retriever');

  // 4. Cross-repo workspace search: typing "cli-by" finds streams/cli-by-entity directly.
  const crossVm = project({ model: m, query: 'cli-by', spaces, panes, settings });
  assert.equal(crossVm.picks[0].kind, 'ws');
  assert.equal(crossVm.picks[0].repo.name, 'streams');
  assert.equal(crossVm.picks[0].ws.name, 'cli-by-entity');

  // 5. Scoped Repo Chip mode: filters only streams, and literal slashes work cleanly inside a chip.
  const scopedVm = project({
    model: m,
    query: 'feat/auth',
    scopedRepoKey: locKey(null, '/code/streams'),
    spaces,
    panes,
    settings,
  });
  assert.equal(scopedVm.scopedRepo.name, 'streams');
  assert.equal(scopedVm.picks.length, 1);
  assert.equal(scopedVm.picks[0].kind, 'create');
  assert.equal(scopedVm.picks[0].repo.name, 'streams');
  assert.equal(scopedVm.picks[0].name, 'feat/auth');
});

test('project() falls back to showing disk repos on empty query when no open-space repos exist', () => {
  const settings = parseSettings({});
  let m = emptyModel();
  m = reduce(m, { type: 'RepoFound', on: null, main: '/home/u/.dotfiles', source: 'disk', mtime: 100 });
  m = reduce(m, { type: 'TargetLoaded' });

  const vm = project({ model: m, query: '', spaces: [], panes: [], settings });
  assert.ok(!vm.items.some((it) => it.kind === 'disk-hint'));
  assert.ok(vm.items.some((it) => it.kind === 'header' && it.repo.name === '.dotfiles'));
  assert.equal(vm.picks[0].kind, 'create');
  assert.equal(vm.picks[0].name, '');
  assert.equal(vm.picks[0].repo.name, '.dotfiles');
});

test('selection stability: late background discovery never hijacks implicit or pinned selection', () => {
  const settings = parseSettings({});
  let m = emptyModel();
  m = reduce(m, { type: 'TargetResolved', spaceId: 's1', machine: null });
  m = reduce(m, { type: 'RepoFound', on: null, main: '/code/randori', source: 'space', order: 0, spaceId: 's1' });
  m = reduce(m, { type: 'FocusResolved', key: locKey(null, '/code/randori'), root: '/code/randori' });
  m = reduce(m, {
    type: 'RepoLoaded',
    key: locKey(null, '/code/randori'),
    list: [{ name: 'default', path: '/code/randori', main: true }],
  });
  m = reduce(m, { type: 'TargetLoaded' });

  const spaces = [{ id: 's1', name: 'Randori', machine: null, folder: '/code/randori', tabs: [{ id: 't1' }] }];
  const panes = [{ pane: 'p1', tab: 't1', terminal: 'x1', cwd: '/code/randori' }];

  // User types "fix": implicit selection locks onto Create "fix" in randori.
  const before = project({ model: m, query: 'fix', spaces, panes, settings });
  const implicitSel = { mode: 'implicit', key: before.picks[0].key };
  assert.equal(before.picks[0].kind, 'create');

  // Background discovery arrives with a repo named "fix" AND another repo with workspace "fix"!
  let m2 = reduce(m, { type: 'RepoFound', on: null, main: '/code/fix', source: 'other', order: 1, spaceId: 's2' });
  m2 = reduce(m2, {
    type: 'RepoLoaded',
    key: locKey(null, '/code/fix'),
    list: [
      { name: 'default', path: '/code/fix', main: true },
      { name: 'fix', path: '/wt/fix/fix', main: false },
    ],
  });

  const after = project({ model: m2, query: 'fix', selection: implicitSel, spaces, panes, settings });
  // Even though "fix" repo and "fix" workspace sorted above Create, current stays locked on Create!
  assert.equal(after.current.key, implicitSel.key);
  assert.equal(after.current.kind, 'create');
});

test('placementFor refuses tab creation when target space no longer exists', () => {
  const item = { kind: 'create', key: 'c1', repo: { on: null, main: '/r' }, name: 'x' };
  const p = placementFor(item, {
    openIndex: new Map(),
    targetSpaceExists: false,
    targetMachine: null,
    openIn: 'tab',
    shift: true,
  });
  assert.equal(p.action, 'refuse-tab');
});
