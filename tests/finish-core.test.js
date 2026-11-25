import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tilde,
  inside,
  snapshotHerdr,
  planAffected,
  detectDrift,
  findNestedWorkspace,
  planCleanup,
  collectScopeFolders,
} from '../mods/jj-finish/core.js';

test('tilde and inside enforce path-segment boundaries and handle null/empty', () => {
  assert.equal(tilde('/home/u/repo', '/home/u'), '~/repo');
  assert.equal(tilde('/home/u', '/home/u'), '~');
  assert.equal(tilde('/home/user2/repo', '/home/u'), '/home/user2/repo');
  assert.equal(tilde(null, '/home/u'), '');
  assert.equal(tilde('/home/u/repo', ''), '/home/u/repo');
  assert.equal(inside('/r/w1/sub', '/r/w1'), true);
  assert.equal(inside('/r/w10', '/r/w1'), false);
  assert.equal(inside(null, '/r/w1'), false);
});

test('snapshotHerdr + planAffected catch terminals that cd into a checkout via live pane.cwd and include transitive children', () => {
  const snap = snapshotHerdr({
    spaceId: 's1',
    spaces: [
      { id: 's1', name: 'w1', tabs: [{ id: 'k1', name: 'shell', named: true, index: 1, active: true }, { id: 'k2', name: 'kept-kid', named: true, index: 2, active: false }] },
      { id: 's2', name: 'other', tabs: [{ id: 'k3', name: 'aux', named: true, index: 1, active: true }] },
    ],
    panes: [
      { pane: 'p1', tab: 'k1', terminal: 't-cd', cwd: '/r/w1/sub' }, // launched in ~, cd'd into /r/w1/sub!
      { pane: 'p2', tab: 'k2', terminal: 't-kid', cwd: '/home/u' }, // child kept in pane in s1!
      { pane: 'p3', tab: 'k3', terminal: 't-other', cwd: '/r/w1' },
    ],
    terminals: [
      { address: 't-cd', name: 'zsh', cwd: '/home/u' }, // launch cwd is ~, NOT /r/w1
      { address: 't-kid', name: 'sub-agent', cwd: '/home/u', parent: 't-cd' },
      { address: 't-grand', name: 'grandchild', cwd: '/home/u', parent: 't-kid' },
      { address: 't-other', name: 'aux-sh', cwd: '/r/w1' },
      { address: 't-dead', name: 'exited', cwd: '/r/w1', state: 'exited' },
    ],
  });

  const plan = planAffected(snap, ['/r/w1']);
  assert.deepEqual(plan.direct.map(t => t.address), ['t-cd', 't-other']);
  assert.deepEqual(plan.children.map(t => t.address), ['t-kid', 't-grand']);
  assert.deepEqual([...plan.addresses], ['t-cd', 't-other', 't-kid', 't-grand']);
  assert.equal(plan.addresses.has('t-dead'), false);

  const rowItems = plan.rowOf.get('/r/w1');
  assert.ok(rowItems.some(i => i.term.address === 't-cd' && i.label === 'zsh (shell)'));
  assert.ok(rowItems.some(i => i.term.address === 't-kid' && i.label === 'sub-agent (child of zsh, kept-kid)'));
  assert.ok(rowItems.some(i => i.term.address === 't-grand' && i.label === 'grandchild (child of sub-agent)'));
});

test('planCleanup uses all affected terminals (including kept child panes) and preserves mod panes', () => {
  const baseSpaces = [{ id: 's1', name: 'w1', tabs: [{ id: 'k1' }, { id: 'k2' }] }, { id: 's2', name: 'aux', tabs: [{ id: 'k3' }] }];
  const snapAllEnded = snapshotHerdr({
    spaceId: 's1',
    spaces: baseSpaces,
    panes: [
      { pane: 'p1', tab: 'k1', terminal: 't1', cwd: '/r/w1' },
      { pane: 'p2', tab: 'k2', terminal: 't-kid', cwd: '/home/u' },
      { pane: 'p3', tab: 'k3', terminal: 't-other', cwd: '/r/w1' },
    ],
    terminals: [],
  });
  // All panes in s1 (direct t1 + kept child t-kid) are in affected -> closeSpace = true, closePanes = ['p3']!
  assert.deepEqual(planCleanup(snapAllEnded, new Set(['t1', 't-kid', 't-other'])), {
    closeSpace: true,
    spaceId: 's1',
    closePanes: ['p3'],
  });

  // With a non-terminal mod pane in s1 -> keep s1 open and close only terminal panes!
  const snapWithMod = snapshotHerdr({
    spaceId: 's1',
    spaces: baseSpaces,
    panes: [
      { pane: 'p1', tab: 'k1', terminal: 't1', cwd: '/r/w1' },
      { pane: 'p-mod', tab: 'k2', cwd: '/r/w1' },
    ],
    terminals: [],
  });
  assert.deepEqual(planCleanup(snapWithMod, new Set(['t1'])), {
    closeSpace: false,
    spaceId: 's1',
    closePanes: ['p1'],
  });
});

test('detectDrift and findNestedWorkspace catch unexpected terminals and nested checkouts', () => {
  const live = { all: [{ address: 't1' }, { address: 't2' }] };
  assert.deepEqual(detectDrift(live, new Set(['t1'])).map(t => t.address), ['t2']);
  assert.deepEqual(detectDrift(live, new Set(['t1', 't2'])), []);
  assert.deepEqual(detectDrift({ all: [] }, new Set()), []);

  assert.deepEqual(
    findNestedWorkspace([{ name: 'outer', root: '/r/w1' }], [{ name: 'w1', path: '/r/w1' }, { name: 'nested-b', path: '/r/w1/nested-b' }]),
    { outer: { name: 'outer', root: '/r/w1' }, inner: '/r/w1/nested-b', innerName: 'nested-b' },
  );
  assert.equal(findNestedWorkspace([{ name: 'w1', root: '/r/w1' }], ['/r/w1', '/r/w10']), null);
});

test('collectScopeFolders scopes to clicked tab or whole space with active-tab pre-check', () => {
  const s = { id: 's1', tabs: [{ id: 'k1', active: false }, { id: 'k2', active: true }] };
  const ps = [
    { pane: 'p1', tab: 'k1', terminal: 't1', cwd: '/r/w1' },
    { pane: 'p2', tab: 'k2', terminal: 't2', cwd: '/r/w2' },
    { pane: 'p3', tab: 'k2', cwd: '/r/mod-only' },
  ];
  const spaceScope = collectScopeFolders(s, ps, null);
  assert.deepEqual(spaceScope.folders, ['/r/w1', '/r/w2']);
  assert.deepEqual([...spaceScope.checkFolders], ['/r/w2']);

  const tabScope = collectScopeFolders(s, ps, 'k1');
  assert.deepEqual(tabScope.folders, ['/r/w1']);
  assert.deepEqual([...tabScope.checkFolders], ['/r/w1']);
});
