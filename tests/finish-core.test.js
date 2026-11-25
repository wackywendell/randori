import test from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotHerdr,
  collectScopeFolders,
  planAffected,
  detectDrift,
  findNestedWorkspace,
  planCleanup,
} from '../mods/jj-finish/core.js';

test('snapshotHerdr and planAffected strictly isolate machines even when paths are identical', () => {
  const spaces = [
    { id: 's-local', name: 'local-ws', machine: null, folder: '/work/repo/fix', tabs: [{ id: 'tab-l', name: 'fix', active: true }] },
    { id: 's-remote', name: 'remote-ws', machine: 'retriever', folder: '/work/repo/fix', tabs: [{ id: 'tab-r', name: 'fix', active: true }] },
  ];
  const panes = [
    { pane: 'p-l', tab: 'tab-l', terminal: 't1', cwd: '/work/repo/fix' },
    { pane: 'p-r', tab: 'tab-r', terminal: 'retriever/t1', cwd: '/work/repo/fix' },
  ];
  const terminals = [
    { address: 't1', state: 'live', cwd: '/work/repo/fix', name: 'zsh' },
    { address: 't2', state: 'live', cwd: '/other', parent: 't1', name: 'bg-local' },
    { address: 'retriever/t1', state: 'live', cwd: '/work/repo/fix', name: 'zsh' },
    { address: 'retriever/t9', state: 'live', cwd: '/work/repo/fix', name: 'parked-remote' },
  ];

  // Local finish sees ONLY local terminals and panes.
  const localSnap = snapshotHerdr({ spaces, panes, terminals, spaceId: 's-local' });
  assert.equal(localSnap.machine, null);
  const localPlan = planAffected(localSnap, '/work/repo/fix');
  assert.deepEqual(localPlan.direct.map((t) => t.address), ['t1']);
  assert.deepEqual(localPlan.dependentChildren.map((t) => t.address), ['t2']);

  // Remote finish sees ONLY retriever terminals (both pane and parked) and labels machine.
  const remoteSnap = snapshotHerdr({ spaces, panes, terminals, spaceId: 's-remote' });
  assert.equal(remoteSnap.machine, 'retriever');
  const remotePlan = planAffected(remoteSnap, '/work/repo/fix');
  assert.deepEqual(remotePlan.direct.map((t) => t.address).sort(), ['retriever/t1', 'retriever/t9']);
  assert.ok(remotePlan.direct[0].label.startsWith('retriever · '));
  assert.deepEqual(remotePlan.dependentChildren, []);
});

test('collectScopeFolders fails closed when explicit spaceId or tabId is missing', () => {
  const spaces = [{ id: 's1', name: 'main', machine: null, folder: '/r', tabs: [{ id: 'tab1', active: true }] }];
  const panes = [{ pane: 'p1', tab: 'tab1', terminal: 't1', cwd: '/r' }];

  const missingSpace = collectScopeFolders(snapshotHerdr({ spaces, panes, terminals: [], spaceId: 's-gone' }));
  assert.equal(missingSpace.ok, false);
  assert.match(missingSpace.error, /space is no longer open/i);

  const missingTab = collectScopeFolders(snapshotHerdr({ spaces, panes, terminals: [], spaceId: 's1', tabId: 'tab-gone' }));
  assert.equal(missingTab.ok, false);
  assert.match(missingTab.error, /tab is no longer open/i);
});

test('planAffected honors Herdr terminal.kill branch-sparing rules and separates mustExit from dependentChildren', () => {
  const spaces = [
    { id: 's1', name: 'fix', machine: null, folder: '/r/fix', tabs: [{ id: 'tab1', active: true }, { id: 'tab2', active: false }] },
  ];
  const panes = [
    { pane: 'p1', tab: 'tab1', terminal: 't1', cwd: '/r/fix' },
    { pane: 'p2', tab: 'tab2', terminal: 't-kept-pane', cwd: '/outside' },
  ];
  const terminals = [
    { address: 't1', state: 'live', cwd: '/r/fix', name: 'pi' },
    // Child in a pane outside /r/fix -> spared by terminal.kill (branch stops here).
    { address: 't-kept-pane', state: 'live', cwd: '/outside', parent: 't1', name: 'kept' },
    { address: 't-grandchild-of-kept', state: 'live', cwd: '/outside', parent: 't-kept-pane', name: 'gc' },
    // Child with herdr.space label outside /r/fix -> spared by terminal.kill.
    { address: 't-labeled', state: 'live', cwd: '/outside', parent: 't1', labels: { 'herdr.space': 's2' } },
    // Plain hidden child outside /r/fix -> advisory dependentChild, NOT in mustExit.
    { address: 't-hidden', state: 'live', cwd: '/outside', parent: 't1', name: 'worker' },
    // Child whose CWD IS inside /r/fix -> directly in direct + mustExit even if kept in a pane!
    { address: 't-inside', state: 'live', cwd: '/r/fix/sub', parent: 't1', name: 'sub-inside' },
  ];

  const snap = snapshotHerdr({ spaces, panes, terminals, spaceId: 's1' });
  const plan = planAffected(snap, '/r/fix');
  assert.deepEqual(plan.direct.map((t) => t.address).sort(), ['t-inside', 't1']);
  assert.deepEqual(plan.mustExit.map((t) => t.address).sort(), ['t-inside', 't1']);
  assert.deepEqual(plan.dependentChildren.map((t) => t.address), ['t-hidden']);
});

test('planAffected and planCleanup use longest-prefix ownerRoot so nested checkouts do not alias parent', () => {
  const spaces = [
    { id: 's1', name: 'ws', machine: null, folder: '/repo', tabs: [{ id: 'tab1', active: true }, { id: 'tab2', active: false }] },
  ];
  const panes = [
    { pane: 'p1', tab: 'tab1', terminal: 't1', cwd: '/repo/.wt/nested' },
    { pane: 'p2', tab: 'tab2', terminal: 't2', cwd: '/repo/src' },
  ];
  const terminals = [
    { address: 't1', state: 'live', cwd: '/repo/.wt/nested' },
    { address: 't2', state: 'live', cwd: '/repo/src' },
  ];
  const snap = snapshotHerdr({ spaces, panes, terminals, spaceId: 's1' });
  const knownRoots = ['/repo', '/repo/.wt/nested'];

  const nestedPlan = planAffected(snap, '/repo/.wt/nested', { knownRoots });
  assert.deepEqual(nestedPlan.direct.map((t) => t.address), ['t1']);

  const parentPlan = planAffected(snap, '/repo', { knownRoots });
  assert.deepEqual(parentPlan.direct.map((t) => t.address), ['t2']);

  const cleanup = planCleanup(snap, '/repo/.wt/nested', knownRoots);
  assert.deepEqual(cleanup, { closeSpace: false, closePanes: ['p1'] });
});

test('planCleanup never closes a space with an empty pane list', () => {
  const spaces = [{ id: 's1', name: 'empty', machine: null, folder: '/r/w1', tabs: [{ id: 'tab1', active: true }] }];
  const snap = snapshotHerdr({ spaces, panes: [], terminals: [], spaceId: 's1' });
  assert.deepEqual(planCleanup(snap, '/r/w1'), { closeSpace: false, closePanes: [] });
});

test('planCleanup closes whole space only when every pane belongs to the finished checkout', () => {
  const spaces = [{ id: 's1', name: 'w1', machine: null, folder: '/r/w1', tabs: [{ id: 't1' }, { id: 't2' }] }];
  const panesAll = [
    { pane: 'p1', tab: 't1', terminal: 'x1', cwd: '/r/w1' },
    { pane: 'p2', tab: 't2', terminal: 'x2', cwd: '/r/w1/sub' },
  ];
  const snapAll = snapshotHerdr({ spaces, panes: panesAll, terminals: [], spaceId: 's1' });
  assert.deepEqual(planCleanup(snapAll, '/r/w1'), { closeSpace: true, closePanes: [] });

  const panesMixed = [
    { pane: 'p1', tab: 't1', terminal: 'x1', cwd: '/r/w1' },
    { pane: 'p2', tab: 't2', terminal: 'x2', cwd: '/other' },
  ];
  const snapMixed = snapshotHerdr({ spaces, panes: panesMixed, terminals: [], spaceId: 's1' });
  assert.deepEqual(planCleanup(snapMixed, '/r/w1'), { closeSpace: false, closePanes: ['p1'] });
});

test('detectDrift and findNestedWorkspace catch new direct terminals and nested checkouts', () => {
  assert.deepEqual(
    detectDrift(new Set(['t1']), [{ address: 't1' }, { address: 't2' }]).map((t) => t.address),
    ['t2'],
  );
  assert.deepEqual(findNestedWorkspace('/r/outer', ['/r/outer', '/r/outer/sub/inner', '/r/other']), {
    outer: '/r/outer',
    inner: '/r/outer/sub/inner',
  });
  assert.equal(findNestedWorkspace('/r/outer', ['/r/outer', '/r/outer-sibling']), null);
});
