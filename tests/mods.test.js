import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, nodes, byId, words } from './mod-harness.js';

const space = (id = 's1', machine = null) => ({ id, index: Number(id.slice(1)) || 1, name: `Theme ${id}`, machine, folder: '/not-a-repository-choice', status: 'blocked', tabs: [{ id: `${id}-tab`, name: 'Task' }] });
const repo = { root: '/repo', main: '/repo', repo: '/repo/.jj/repo', name: 'repo', linked: false };
const linked = { ...repo, root: '/workspaces/topic', linked: true };
const workspaces = [{ name: 'default', root: '/repo', main: true }, { name: 'topic', root: linked.root, main: false }];
const result = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const click = (h, id) => byId(h.render(), id).handlers.on_click({}, h.cx);
const plan = (scope = { kind: 'tab', id: 's1-tab' }, excluded = []) => ({ ...linked, workspace: 'topic', scope, excluded, terminals: ['owned-root', 'owned-child'], approval: 'approved' });
function manager(action, data = {}) {
  const calls = [];
  const h = load('jj-workspace', { spaces: [space()], props: { space: 's1', action, overlay: 'overlay' }, ...data, exec: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (data.exec) return data.exec(cmd, args, opts);
      if (args[0] === 'probe') return result(args.at(-1) === linked.root ? linked : repo);
      if (args[0] === 'list') return result(workspaces);
      if (args[0] === 'remove-plan') return result(plan({ kind: args[1].slice(2), id: args[2] }));
      if (args[0] === 'create') return result({ ...linked, created: true });
      return result({ root: linked.root, completed: ['deleted checkout'] });
    } });
  h.calls = calls;
  return h;
}
async function choose(h) { h.view.chooseRepository('/repo/subdir', h.cx); await h.drain(); }
async function chooseLinked(h) { await choose(h); h.view.chooseWorkspace(workspaces[1], h.cx); await h.drain(); }

test('organizational rows never inspect repositories, schedule work, or show one pane status as a checkout', async () => {
  const s = space();
  s.tabs.push({ id: 'second', name: 'Other repository' });
  const h = load('jj-spaces', { spaces: [s], panes: [{ tab: 's1-tab', cwd: '/one' }, { tab: 'second', cwd: '/two' }],
    exec: () => assert.fail('Space rows must not run a command') });
  for (let i = 0; i < 100; i++) h.render();
  await h.drain();
  assert.equal(h.tasks.length, 0);
  assert.equal(h.timers.length, 0);
  assert.deepEqual(words(byId(h.render(), 'jj-space-s1')), ['!', 'Theme s1']);
});

test('rows preserve user order within machine groups and support manual reorder', () => {
  const h = load('jj-spaces', { spaces: [space('s3', 'remote'), space('s2'), space('s1')] });
  assert.deepEqual(nodes(h.render()).filter(n => /^jj-space-s\d$/.test(n.calls.id?.[0])).map(n => n.calls.id[0]), ['jj-space-s3', 'jj-space-s2', 'jj-space-s1']);
  byId(h.render(), 'jj-space-s2').handlers['on_mouse_down:left']({}, h.cx);
  byId(h.render(), 'jj-space-s1').handlers['on_mouse_up:left']({}, h.cx);
  assert.equal(h.actions.at(-1).name, 'space.move');
  assert.equal(h.actions.at(-1).args.id, 's2');
  assert.equal(h.actions.at(-1).args.index, 1);
});

test('space menu is organizational, does no probing and Close stays non-destructive', async () => {
  const h = load('jj-menu', { props: { tab: 'space', target: { id: 's1' } }, spaces: [space()], exec: () => assert.fail('No probes') });
  await h.drain();
  assert.ok(words(h.render()).includes('Workspaces…'));
  assert.equal(words(h.render()).some(w => /Remove .*workspace|Git|Refresh/.test(w)), false);
  const rows = nodes(h.render()).filter(n => n.calls.id?.[0]?.startsWith('mi-'));
  rows.find(n => words(n).includes('Close')).handlers.on_click({}, h.cx);
  assert.equal(h.actions.at(-1).name, 'space.close');
  assert.equal(h.overlays.filter(o => o.mod === 'jj-workspace').length, 0);
});

test('workspace menu opens a chooser without a guessed repository', async () => {
  const h = load('jj-menu', { props: { tab: 'space', target: { id: 's1' } } });
  const row = nodes(h.render()).find(n => n.calls.id?.[0]?.startsWith('mi-') && words(n).includes('Workspaces…'));
  row.handlers.on_click({}, h.cx);
  const overlay = h.overlays.at(-1);
  assert.equal(overlay.mod, 'jj-workspace');
  assert.equal(overlay.props.space, 's1');
  assert.equal('folder' in overlay.props, false);
});

test('manager never chooses the first terminal or starts discovery on mount', async () => {
  const h = manager('new', { panes: [{ terminal: 'one', tab: 's1-tab', cwd: '/one' }, { terminal: 'two', tab: 's1-tab', cwd: '/two' }] });
  await h.drain();
  assert.equal(h.calls.length, 0);
  assert.equal(h.view.folder.value(), '');
  assert.ok(words(h.render()).includes('/one'));
  click(h, 'jj-folder-1');
  await h.drain();
  assert.equal(h.calls[0].args.at(-1), '/two');
});

test('Create uses the selected repository and opens a tab in the named theme', async () => {
  const h = manager('new');
  await choose(h);
  h.view.name.set_value('topic/new');
  h.view.go(h.cx);
  await h.drain();
  assert.equal(h.calls[1].args[0], 'create');
  assert.equal(h.calls[1].args.at(-1), '/repo');
  assert.equal(h.actions.at(-1).name, 'tab.new');
  assert.equal(h.actions.at(-1).args.space, 's1');
  assert.equal(h.actions.at(-1).args.folder, linked.root);
  assert.equal(h.actions.at(-1).args.name, 'topic-new');
  assert.equal(h.actions.some(a => a.name === 'space.new'), false);
});

test('a new organizational space is explicit and requires its own name', async () => {
  const h = manager('new');
  await choose(h);
  h.view.name.set_value('topic');
  click(h, 'jj-destination-new');
  h.view.go(h.cx);
  await h.drain();
  assert.equal(h.calls.length, 1);
  h.view.spaceName.set_value('Research');
  h.view.go(h.cx);
  await h.drain();
  assert.equal(h.actions.at(-1).name, 'space.new');
  assert.equal(h.actions.at(-1).args.name, 'Research');
});

test('Open explicitly selects a workspace and destination, with identity revalidation', async () => {
  const h = manager('open');
  await chooseLinked(h);
  assert.equal(h.actions.length, 0);
  h.view.go(h.cx);
  await h.drain();
  assert.equal(h.actions.at(-1).name, 'tab.new');
  assert.equal(h.actions.at(-1).args.folder, linked.root);
  assert.equal(h.calls.at(-1).args[0], 'probe');
  assert.equal(h.calls.at(-1).args.at(-1), linked.root);
});

test('Open refuses a checkout retargeted to another repository', async () => {
  const h = manager('open');
  await chooseLinked(h);
  h.view.workspace = { ...h.view.workspace, root: '/foreign' };
  h.view.go(h.cx);
  await h.drain();
  assert.match(h.view.error, /identity changed/);
  assert.equal(h.actions.length, 0);
});

test('Remove requires separate checkout, scope and final confirmation selections', async () => {
  const h = manager('remove');
  await choose(h);
  assert.equal(h.calls.some(c => c.args[0] === 'remove-plan'), false);
  h.view.chooseWorkspace(workspaces[0], h.cx);
  await h.drain();
  assert.equal(h.view.step, 'workspaces');
  h.view.chooseWorkspace(workspaces[1], h.cx);
  await h.drain();
  assert.equal(h.view.step, 'scope');
  assert.equal(h.calls.some(c => c.args[0] === 'remove-plan'), false);
  h.view.chooseScope(h.view.scopes()[0], h.cx);
  await h.drain();
  assert.equal(h.view.step, 'confirm');
  assert.equal(h.calls.at(-1).args[1], '--tab');
  assert.equal(h.calls.some(c => c.args[0] === 'remove'), false);
  assert.ok(words(h.render()).includes('Delete checkout: /workspaces/topic'));
  assert.ok(words(h.render()).some(w => w.includes('Tab “Task” in “Theme s1”')));
});

test('removal task survives view closure, uses the selected tab and unwraps partial errors', async () => {
  const h = manager('remove', { exec: async (_cmd, args) => {
    if (args[0] === 'probe') return result(args.at(-1) === linked.root ? linked : repo);
    if (args[0] === 'list') return result(workspaces);
    if (args[0] === 'remove-plan') return result(plan());
    return { code: 1, stderr: '{"error":"Stopped at snapshot. Completed: closed layout scope"}', stdout: '' };
  } });
  await chooseLinked(h);
  h.view.chooseScope(h.view.scopes()[0], h.cx);
  await h.drain();
  h.view.go(h.cx);
  assert.equal(h.tasks.at(-1).opts.owner, null);
  h.view.close();
  await h.drain();
  assert.equal(h.calls.at(-1).opts.cwd, '/repo');
  assert.equal(h.calls.at(-1).args[1], '--tab');
  assert.equal(h.calls.at(-1).args[2], 's1-tab');
  assert.equal(h.calls.at(-1).args.at(-1), linked.root);
  assert.equal(h.notifications.at(-1).body, 'Stopped at snapshot. Completed: closed layout scope');
});

test('whole-space removal names its broader scope and every excluded path', async () => {
  const excluded = Array.from({ length: 120 }, (_, i) => ({ path: `long-${i}\ncontrol\tname`, digest: String(i) }));
  const h = manager('remove');
  await chooseLinked(h);
  h.view.scope = h.view.scopes()[1];
  h.view.plan = plan({ kind: 'space', id: 's1' }, excluded);
  h.view.step = 'confirm';
  assert.ok(words(h.render()).some(w => /ALL 1 tabs, including any other repositories/.test(w)));
  assert.ok(byId(h.render(), 'jj-excluded').calls.overflow_y_scrollbar);
  assert.equal(nodes(h.render()).filter(n => n.calls.id?.[0]?.startsWith('jj-excluded-')).length, 120);
  assert.ok(words(h.render()).includes(JSON.stringify(excluded[119].path)));
  assert.ok(words(h.render()).includes('Terminal · owned-child'));
});

test('reset discards a removal approval and cannot execute it later', async () => {
  const h = manager('remove');
  await chooseLinked(h);
  h.view.chooseScope(h.view.scopes()[0], h.cx);
  await h.drain();
  h.view.reset('new', h.cx);
  h.view.go(h.cx);
  await h.drain();
  assert.equal(h.view.plan, null);
  assert.equal(h.calls.some(c => c.args[0] === 'remove'), false);
});

test('remote removal refuses before planning or changing resources', async () => {
  const h = manager('remove', { spaces: [space('s1', 'remote')] });
  await choose(h);
  assert.match(h.view.error, /Remote removal is not supported/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.actions.length, 0);
});

test('a non-jj selection stays in the explicit chooser without opening a Git dialog', async () => {
  const h = manager('new', { exec: async () => result(null) });
  await choose(h);
  assert.match(h.view.error, /Choose a jj repository/);
  assert.equal(h.view.step, 'repository');
  assert.equal(h.overlays.length, 0);
});

test('relative folder paths do not silently resolve against another process cwd', async () => {
  const h = manager('new');
  h.view.chooseRepository('.', h.cx);
  await h.drain();
  assert.match(h.view.error, /absolute folder/);
  assert.equal(h.calls.length, 0);
});

test('Browse sets an explicit candidate but does not probe or create anything', async () => {
  const h = manager('new', { pickFolder: async () => '/chosen' });
  click(h, 'jj-browse');
  await h.drain();
  assert.equal(h.view.folder.value(), '/chosen');
  assert.equal(h.calls.length, 0);
});

test('a mismatched removal-plan scope cannot become a confirmation', async () => {
  const h = manager('remove', { exec: async (_cmd, args) => {
    if (args[0] === 'probe') return result(args.at(-1) === linked.root ? linked : repo);
    if (args[0] === 'list') return result(workspaces);
    return result(plan({ kind: 'space', id: 'wrong-space' }));
  } });
  await chooseLinked(h);
  h.view.chooseScope(h.view.scopes()[0], h.cx);
  await h.drain();
  assert.match(h.view.error, /Removal target changed/);
  assert.equal(h.view.step, 'scope');
  assert.equal(h.view.plan, null);
});

test('closing the view during create never opens a later tab', async () => {
  let finish;
  const h = manager('new', { exec: async (_cmd, args) => args[0] === 'create'
    ? new Promise(resolve => { finish = resolve; }) : result(repo) });
  await choose(h);
  h.view.name.set_value('topic');
  h.view.go(h.cx);
  const running = h.drain();
  h.view.close();
  finish(result(linked));
  await running;
  assert.equal(h.actions.length, 0);
});

const program = { key: 'pi', name: 'Pi', agent: true };
const agent = (address, space, status, extra = {}) => ({ address, pane: `pane-${address}`, space, space_name: `Workspace ${space}`,
  tab: `tab-${address}`, tab_name: `Task ${address}`, tab_index: 1, status, program, title: `Task ${address}`, seq: 1, pinned: false, focused: false, ...extra });
const ids = root => nodes(root).filter(n => n.calls.id?.[0]?.startsWith('ag-t')).map(n => n.calls.id[0].slice(3));

test('agent Focused/All filter, external attention and pins are preserved', () => {
  const h = load('jj-agents', { agents: [agent('t1', 's1', 'working'), agent('t2', 's2', 'idle'), agent('t3', 's2', 'blocked'), agent('t4', 's2', 'working', { pinned: true })] });
  assert.deepEqual(ids(h.render()).sort(), ['t1', 't3', 't4']);
  byId(h.render(), 'ag-view').handlers.on_click({}, h.cx);
  assert.deepEqual(ids(h.render()).sort(), ['t1', 't2', 't3', 't4']);
  byId(h.render(), 'ag-view').handlers.on_click({}, h.cx);
  assert.deepEqual(ids(h.render()).sort(), ['t1', 't3', 't4']);
});

test('external sub-agent attention and scoped navigation are preserved', () => {
  const h = load('jj-agents', { agents: [agent('t1', 's1', 'working'), agent('t2', 's2', 'working')],
    terminals: [{ address: 't3', parent: 't2', state: 'live', status: 'blocked', program }] });
  assert.ok(byId(h.render(), 'sub-t3'));
  h.state.focused.terminal = 't1';
  h.view.navigate('next');
  assert.equal(h.actions.at(-1).args.terminal, 't2');
  h.state.focused.terminal = 't2';
  h.view.navigate('next');
  assert.equal(h.actions.at(-1).args.terminal, 't1');
});

test('layout excludes the shipped Changes poller even while hidden', () => {
  const layout = JSON.parse(readFileSync(new URL('../layouts/jj-tui.json', import.meta.url)));
  const mods = [];
  const walk = node => { if (node.content?.mod) mods.push(node.content.mod); (node.children ?? []).forEach(walk); };
  walk(layout);
  assert.ok(mods.includes('jj-spaces'));
  assert.ok(mods.includes('jj-agents'));
  assert.ok(mods.includes('jj-tabs'));
  assert.equal(mods.includes('changes'), false);
});
