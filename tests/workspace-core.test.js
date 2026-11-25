import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tilde,
  untilde,
  worktreesBase,
  resolveWorktreePath,
  validateLink,
  tabLabel,
  parseDiskScan,
  resolveDiskCandidates,
  parseProps,
  slug,
  rowKey,
  whereOpen,
  upsertRepo,
  sortRepos,
  parseQuery,
  shouldAutoCompleteSlash,
  buildItems,
  initialIndex,
  resolveSelection,
  computeGhost,
  placement,
} from '../mods/jj-workspace/core.js';

test('tilde, untilde, worktreesBase, resolveWorktreePath, and validateLink enforce boundaries and safe homes', () => {
  // tilde requires a path-segment boundary
  assert.equal(tilde('/home/u/repo', '/home/u'), '~/repo');
  assert.equal(tilde('/home/u', '/home/u'), '~');
  assert.equal(tilde('/home/user2/repo', '/home/u'), '/home/user2/repo');
  assert.equal(tilde('/home/u/repo', '/home/u/'), '~/repo');

  // untilde never strips ~ into filesystem root `/` when userHome is empty
  assert.equal(untilde('~/.herdr/worktrees/a/b', '/home/u/'), '/home/u/.herdr/worktrees/a/b');
  assert.equal(untilde('~/.herdr/worktrees/a/b', ''), '~/.herdr/worktrees/a/b');
  assert.equal(untilde('~', ''), '~');

  // worktreesBase returns empty when home is unknown for a tilde template
  assert.equal(worktreesBase('~/.herdr/worktrees/{repo}/{name}', '/home/u'), '/home/u/.herdr/worktrees');
  assert.equal(worktreesBase('~/.herdr/worktrees/{repo}/{name}', ''), '');
  assert.equal(worktreesBase('/srv/wt/{repo}/{name}', ''), '/srv/wt');

  // resolveWorktreePath flags unresolved tilde cleanly
  assert.deepEqual(
    resolveWorktreePath({ template: '~/.herdr/worktrees/{repo}/{name}', repoMain: '/r/app', repoName: 'app', wsName: 'feat', home: '' }),
    { path: '~/.herdr/worktrees/app/feat', unresolvedTilde: true },
  );
  assert.deepEqual(
    resolveWorktreePath({ template: '~/.herdr/worktrees/{repo}/{name}', repoMain: '/r/app', repoName: 'app', wsName: 'feat', home: '/home/u' }),
    { path: '/home/u/.herdr/worktrees/app/feat', unresolvedTilde: false },
  );
  assert.deepEqual(
    resolveWorktreePath({ template: '../wt/{name}', repoMain: '/r/app', repoName: 'app', wsName: 'feat', home: '' }),
    { path: '/r/wt/feat', unresolvedTilde: false },
  );

  // validateLink rejects absolute, tilde, empty, and traversal paths
  assert.equal(validateLink('.envrc'), true);
  assert.equal(validateLink('config/mise.local.toml'), true);
  assert.equal(validateLink('/etc/passwd'), false);
  assert.equal(validateLink('~/secret'), false);
  assert.equal(validateLink('../escape'), false);
  assert.equal(validateLink('a/../b'), false);
  assert.equal(validateLink(''), false);

  // tabLabel names main checkouts after repo name and linked checkouts after workspace name
  assert.equal(tabLabel({ name: 'randori' }, 'default', true), 'randori');
  assert.equal(tabLabel({ name: 'randori' }, 'fix-bug', false), 'fix-bug');
});

test('parseDiskScan requires strict 3-field tab records, drops GNU stat junk lines, and resolves relative .jj/repo pointers', () => {
  const stdout = [
    '  File: "/home/bits/dd/app/.jj/repo/op_heads/heads"',
    '    ID: 12345 Namelen: 255     Type: ext2/ext3',
    'Block size: 4096       Fundamental block size: 4096',
    '1700000100\t/home/bits/dd/app\t',
    '1700000200\t/home/bits/wt/app/w1\t/home/bits/dd/app/.jj/repo',
    '1700000250\t/home/bits/dd/rel-wt\t../../app/.jj/repo',
    'not-a-number\t/home/bits/bad\t',
    '1700000300\t/home/bits/only-two-fields',
  ].join('\n');
  const parsed = parseDiskScan(stdout);
  assert.equal(parsed.size, 3);
  const candidates = resolveDiskCandidates(parsed, [], 'retriever');
  assert.deepEqual([...candidates.entries()], [
    ['/home/bits/dd/app', 1700000250],
  ]);
});

test('slug preserves normal names and hashes symbol-only names instead of returning empty', () => {
  assert.equal(slug('feat/auth'), 'feat-auth');
  assert.equal(slug(''), '');
  const bang = slug('!!!');
  assert.match(bang, /^ws-[0-9a-f]{6}$/);
  assert.equal(slug('!!!'), bang);
  assert.notEqual(slug('!!!'), slug('???'));
  assert.match(slug('..'), /^ws-[0-9a-f]{6}$/);
});

test('rowKey separates create rows from workspaces literally named +new', () => {
  assert.notEqual(rowKey('create', '\0/r/main'), rowKey('ws', '\0/r/main', '+new'));
});

test('whereOpen returns the matched tab even on dedicated spaces so inactive tabs get selected', () => {
  const spaces = [
    { id: 's1', machine: null, folder: '/r/w1', tabs: [{ id: 'k1', active: false }, { id: 'k2', active: true }] },
  ];
  const panes = [
    { pane: 'p1', tab: 'k1', terminal: 't1', cwd: '/r/w1' },
    { pane: 'p2', tab: 'k2', terminal: 't2', cwd: '/r/other' },
  ];
  const loc = whereOpen(spaces, panes, null, '/r/w1');
  assert.equal(loc.dedicated, true);
  assert.equal(loc.space.id, 's1');
  assert.equal(loc.tab.id, 'k1');
  assert.equal(loc.tab.active, false);
});

test('upsertRepo promotes disk -> other -> space with deterministic spaceId and sortRepos prioritizes current machine', () => {
  const repos = [];
  const first = upsertRepo(repos, { main: '/home/u/a', checkout: '/home/u/a', on: null, source: 'disk', mtime: 500 });
  assert.equal(first.added, true);
  assert.equal(first.repo.state, 'loading');

  // Later-sidebar other space promotes disk -> other
  upsertRepo(repos, { main: '/home/u/a', checkout: '/home/u/a', on: null, source: 'other', spaceId: 's-late', order: 5 });
  assert.equal(repos[0].source, 'other');
  assert.equal(repos[0].spaceId, 's-late');

  // Earlier-sidebar other space resolving second updates BOTH order AND spaceId
  upsertRepo(repos, { main: '/home/u/a', checkout: '/home/u/a', on: null, source: 'other', spaceId: 's-early', order: 1 });
  assert.equal(repos[0].order, 1);
  assert.equal(repos[0].spaceId, 's-early');

  upsertRepo(repos, { main: '/rem/cur', checkout: '/rem/cur', on: 'retriever', source: 'space', spaceId: 's1', order: 0 });
  upsertRepo(repos, { main: '/rem/other', checkout: '/rem/other', on: 'retriever', source: 'other', spaceId: 's3', order: 5 });
  upsertRepo(repos, { main: '/rem/disk', checkout: '/rem/disk', on: 'retriever', source: 'disk', mtime: 100 });
  upsertRepo(repos, { main: '/home/u/disk', checkout: '/home/u/disk', on: null, source: 'disk', mtime: 900 });

  sortRepos(repos, { focusKey: 'retriever\0/rem/cur', curMachine: 'retriever' });
  assert.deepEqual(repos.map(r => [r.name, r.source, r.on]), [
    ['cur', 'space', 'retriever'],
    ['other', 'other', 'retriever'],
    ['a', 'other', null],
    ['disk', 'disk', 'retriever'],
    ['disk', 'disk', null],
  ]);
});

test('parseQuery, shouldAutoCompleteSlash, and computeGhost handle exact repo names without hijacking', () => {
  const repos = [
    { key: '\0/r/randori-docs', name: 'randori-docs' },
    { key: '\0/r/randori', name: 'randori' },
    { key: '\0/r/streams', name: 'streams' },
  ];
  assert.deepEqual(parseQuery('streams/  fix-auth  ', repos), {
    mode: 'scoped', q: 'fix-auth', name: 'fix-auth', scoped: new Set(['\0/r/streams']),
  });
  assert.deepEqual(parseQuery('feat/auth', repos), {
    mode: 'filter', q: 'feat/auth', name: 'feat/auth', scoped: null,
  });

  // Typing `randori/` when `randori` is an exact loaded repo MUST NOT hijack to `randori-docs/`!
  assert.equal(
    shouldAutoCompleteSlash({ prevText: 'randori', nextText: 'randori/', prevCurrent: { repo: repos[0] }, repos }),
    null,
  );
  // Typing `rando/` (prefix, not an exact repo name) DOES complete to `randori-docs/`.
  assert.equal(
    shouldAutoCompleteSlash({ prevText: 'rando', nextText: 'rando/', prevCurrent: { repo: repos[0] }, repos }),
    repos[0],
  );

  // Ghost prefix vs substring
  assert.deepEqual(computeGhost({ text: 'str', current: { repo: repos[2] } }), {
    repo: repos[2], suffix: 'eams/', full: 'streams/', kind: 'prefix',
  });
  assert.deepEqual(computeGhost({ text: 'ream', current: { repo: repos[2] } }), {
    repo: repos[2], suffix: ' \u2192 streams/', full: 'streams/', kind: 'substring',
  });
  assert.equal(computeGhost({ text: 'streams/x', current: { repo: repos[2] } }), null);
});

test('placement handles case-insensitive scoping, openIn, cross-machine fallback, and inactive spaces', () => {
  const localRepo = { key: '\0/r/Main', name: 'Main', main: '/r/Main', on: null, list: [{ name: 'default', path: '/r/Main', main: true }, { name: 'open-w', path: '/r/open-w', main: false }, { name: 'closed-w', path: '/r/closed-w', main: false }, { name: 'old', path: '', main: false }] };
  const remoteRepo = { key: 'retriever\0/rem/s', name: 's', main: '/rem/s', on: 'retriever', list: [{ name: 'open-r', path: '/rem/open-r', main: false }, { name: 'closed-r', path: '/rem/closed-r', main: false }] };
  const baseCtx = {
    text: '',
    spaceId: 's1',
    spaceMachine: null,
    spaceName: 'local-a',
    openIn: 'space',
    spaces: [
      { id: 's1', name: 'local-a', active: true, machine: null, folder: '/r/Main', tabs: [{ id: 'k1', active: true }] },
      { id: 's2', name: 'open-w', active: false, machine: null, folder: '/r/open-w', tabs: [{ id: 'k2', active: true }] },
      { id: 's3', name: 'open-r', active: false, machine: 'retriever', folder: '/rem/open-r', tabs: [{ id: 'k3', active: true }] },
    ],
    panes: [
      { pane: 'p1', tab: 'k1', terminal: 't1', cwd: '/r/Main' },
      { pane: 'p2', tab: 'k2', terminal: 't2', cwd: '/r/open-w' },
      { pane: 'p3', tab: 'k3', terminal: 't3', cwd: '/rem/open-r' },
    ],
  };

  // Case-insensitive scoped empty create row says "type a name to create"
  assert.deepEqual(
    placement({ kind: 'create', repo: localRepo, name: '' }, false, { ...baseCtx, text: 'main/' }),
    { kind: 'none', label: 'type a name to create' },
  );
  assert.equal(placement({ kind: 'create', repo: localRepo, name: '' }, false, baseCtx).kind, 'complete');

  // Named create row
  assert.equal(placement({ kind: 'create', repo: localRepo, name: 'x' }, false, baseCtx).kind, 'space');
  assert.equal(placement({ kind: 'create', repo: localRepo, name: 'x' }, true, baseCtx).kind, 'tab');
  assert.equal(placement({ kind: 'create', repo: localRepo, name: 'x' }, false, { ...baseCtx, openIn: 'tab' }).kind, 'tab');
  assert.equal(placement({ kind: 'create', repo: localRepo, name: 'x' }, true, { ...baseCtx, openIn: 'tab' }).kind, 'space');

  // Closed remote falls back to space on Enter even when openIn='tab'; Shift+Enter refuses under BOTH openIn='space' and openIn='tab'
  assert.equal(placement({ kind: 'ws', repo: remoteRepo, ws: remoteRepo.list[1] }, false, { ...baseCtx, openIn: 'tab' }).kind, 'space');
  assert.match(placement({ kind: 'ws', repo: remoteRepo, ws: remoteRepo.list[1] }, true, { ...baseCtx, openIn: 'tab' }).reason, /Press Enter for a new space\./);
  assert.match(placement({ kind: 'ws', repo: remoteRepo, ws: remoteRepo.list[1] }, true, { ...baseCtx, openIn: 'space' }).reason, /Press Enter for a new space\./);

  // Open remote switches on Enter, refuses Shift+Enter with "Press Enter to switch."
  assert.equal(placement({ kind: 'ws', repo: remoteRepo, ws: remoteRepo.list[0] }, false, { ...baseCtx, openIn: 'tab' }).kind, 'switch');
  assert.match(placement({ kind: 'ws', repo: remoteRepo, ws: remoteRepo.list[0] }, true, { ...baseCtx, openIn: 'tab' }).reason, /Press Enter to switch\./);

  // Inactive target space labels tab with space name
  const inactiveCtx = { ...baseCtx, spaces: [{ ...baseCtx.spaces[0], active: false }, { ...baseCtx.spaces[1], active: true }] };
  assert.equal(placement({ kind: 'create', repo: localRepo, name: 'x' }, true, inactiveCtx).label, 'new tab in local-a');
});

test('buildItems, initialIndex, resolveSelection, and parseProps handle repo states and picker props', () => {
  const repos = [
    { key: '\0/r/a', name: 'a', main: '/r/a', on: null, source: 'space', state: 'loading', list: [], names: new Set(), error: '' },
    { key: '\0/r/b', name: 'b', main: '/r/b', on: null, source: 'space', state: 'error', list: [], names: new Set(), error: 'boom' },
    { key: '\0/r/c', name: 'c', main: '/r/c', on: null, source: 'space', state: 'ready', list: [{ name: '+new', path: '/r/c', main: true }, { name: 'w1', path: '/r/c-w1', main: false }], names: new Set(), error: '' },
  ];
  const rows = buildItems({ repos, text: '', loadingBg: true });
  assert.ok(rows.some(r => r.kind === 'repo-loading' && r.repo.name === 'a'));
  assert.ok(rows.some(r => r.kind === 'repo-error' && r.repo.name === 'b'));
  const picks = rows.filter(r => r.kind === 'ws' || r.kind === 'create');
  assert.equal(initialIndex(picks, { focusKey: '\0/r/c', focusRoot: '/r/c' }), 1); // lands on w1 (other workspace)
  assert.equal(resolveSelection(picks, { selectedKey: picks[2].key, text: '', focusKey: '\0/r/c', focusRoot: '/r/c' }), 2);
  assert.deepEqual(parseProps({ space: 's1', folder: '/r/a', overlay: 'o2', argv: ['zsh'] }), {
    overlay: 'o2', spaceId: 's1', folder: '/r/a', machine: null, argv: ['zsh'],
  });

  // Disk-only repos stay folded behind a disk-hint while empty if space/other repos exist,
  // appear immediately once searching, and show while empty when no space/other repos exist.
  const diskRepo = { key: '\0/d/extra', name: 'extra', main: '/d/extra', on: null, source: 'disk', state: 'ready', list: [{ name: 'default', path: '/d/extra', main: true }], names: new Set(), error: '' };
  const emptyWithDisk = buildItems({ repos: [repos[2], diskRepo], text: '', loadingBg: false });
  assert.equal(emptyWithDisk.some(i => i.repo?.key === diskRepo.key), false);
  assert.deepEqual(emptyWithDisk.find(i => i.kind === 'disk-hint'), { kind: 'disk-hint', key: 'disk-hint', count: 1 });
  const searchedWithDisk = buildItems({ repos: [repos[2], diskRepo], text: 'ext', loadingBg: false });
  assert.equal(searchedWithDisk.some(i => i.kind === 'header' && i.repo.key === diskRepo.key), true);
  assert.equal(searchedWithDisk.some(i => i.kind === 'disk-hint'), false);
  const diskOnlyEmpty = buildItems({ repos: [diskRepo], text: '', loadingBg: false });
  assert.equal(diskOnlyEmpty.some(i => i.kind === 'header' && i.repo.key === diskRepo.key), true);
  assert.equal(diskOnlyEmpty.some(i => i.kind === 'disk-hint'), false);
});
