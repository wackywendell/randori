import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, byId, words, nodes } from './mod-harness.js';

const ok = stdout => ({ code: 0, stdout, stderr: '' });
const fail = stderr => ({ code: 1, stdout: '', stderr });
// Values from the mod's sandbox, as plain data for deepEqual.
const plain = v => JSON.parse(JSON.stringify(v));
const isLog = c => c.cmd === 'jj' && c.args.includes('log');

// Two jj repositories: /r/main with a linked workspace /r/w1, and /o.
// /g is in no jj repository.
const ROOTS = { '/r/main': '/r/main', '/r/main/sub': '/r/main', '/r/w1': '/r/w1', '/o': '/o' };
const FILES = { '/r/main/.jj/repo/store/type': 'git', '/o/.jj/repo/store/type': 'git', '/r/w1/.jj/repo': '../../main/.jj/repo' };
const STACK = [
  { commit: 'a', at: true, bookmarks: [], empty: false, files: 3, added: 120, removed: 8 },
  { commit: 'b', at: false, bookmarks: [] }, { commit: 'c', at: false, bookmarks: [] }, { commit: 'd', at: false, bookmarks: [] },
  { commit: 'e', at: false, bookmarks: ['master', 'other'] },
];

// A fake exec over that world. `over(cmd, args, opts)` answers first when it returns something.
function world(over = () => undefined) {
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, cwd: opts.cwd, on: opts.on ?? null });
    const answer = await over(cmd, args, opts);
    if (answer) return answer;
    if (cmd === 'jj' && args.join(' ') === '--ignore-working-copy workspace root') {
      const root = ROOTS[opts.cwd];
      return root ? ok(`${root}\n`) : fail('Error: There is no jj repo in "."');
    }
    if (isLog({ cmd, args })) return ok(STACK.map(l => JSON.stringify(l)).join('\n') + '\n');
    if (cmd === 'git') return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
  const readTextFile = async path => {
    if (path in FILES) return FILES[path];
    throw new Error(`no file ${path}`);
  };
  return { calls, exec, readTextFile };
}

const sidebar = (extra = {}, props = {}) => ({ type: 'row', children: [{ id: 'sidebar', type: 'column', size: { px: 320 }, ...extra,
  children: [{ id: 'spaces', type: 'block', content: { mod: 'jj-spaces', props } }] }] });
const space = (id, cwd, machine = null) => ({ id, name: '', machine, folder: cwd, tabs: [{ id: `${id}-tab` }] });
const pane = (id, cwd, status = 'idle') => ({ pane: `${id}-pane`, tab: `${id}-tab`, terminal: `${id}-term`, cwd, status, program: { shell: true } });

function spacesWith(list, w = world(), data = {}) {
  const h = load('jj-spaces', { layout: sidebar(), spaces: list.map(([id, cwd, m]) => space(id, cwd, m)),
    panes: list.map(([id, cwd]) => pane(id, cwd)), exec: w.exec, readTextFile: w.readTextFile, ...data });
  h.calls = w.calls;
  return h;
}
async function settle(h) { await h.advance(250); await h.advance(250); }
const row = (h, id) => words(byId(h.render(), `space-${id}`));

test('a jj space shows its nearest bookmark and the changes in @', async () => {
  const h = spacesWith([['s1', '/r/main']]);
  await settle(h);
  for (const w of ['master~4', '~3', '+120', '-8']) assert.ok(row(h, 's1').includes(w), `${w} in ${row(h, 's1')}`);
  const log = h.calls.find(isLog);
  assert.deepEqual(plain(log.args.slice(0, 7)), ['--ignore-working-copy', 'log', '--no-graph', '--limit', '64', '-r', '@ | heads(::@ & bookmarks())::@']);
});

test('an empty @ shows \u2205 and a bookmark on @ shows no distance', async () => {
  const w = world((cmd, args) => isLog({ cmd, args }) ? ok(JSON.stringify({ ...STACK[0], empty: true, bookmarks: ['topic'] }) + '\n') : undefined);
  const h = spacesWith([['s1', '/r/main']], w);
  await settle(h);
  assert.ok(row(h, 's1').includes('topic'));
  assert.ok(row(h, 's1').includes('\u2205'));
  assert.equal(row(h, 's1').some(x => x.startsWith('+')), false);
});

test('linked jj workspaces nest under their main checkout', async () => {
  const h = spacesWith([['s1', '/r/main'], ['s3', '/o'], ['s2', '/r/w1']]);
  await settle(h);
  const order = nodes(h.render()).map(n => n.calls.id?.[0]).filter(id => /^space-s\d$/.test(id ?? ''));
  assert.deepEqual([...new Set(order)], ['space-s1', 'space-s2', 'space-s3']);
});

test('a space working in two jj repositories shows no status line', async () => {
  const s = space('s1', '/r/main');
  s.tabs.push({ id: 'second' });
  const w = world();
  const h = load('jj-spaces', { layout: sidebar(), spaces: [s], panes: [pane('s1', '/r/main'), { ...pane('s1', '/o'), pane: 'p2', tab: 'second' }],
    exec: w.exec, readTextFile: w.readTextFile });
  await settle(h);
  assert.equal(row(h, 's1').includes('master~4'), false);
});

test('stale, divergent and failed reads show one dim word with jj\u2019s message', async () => {
  for (const [stderr, word] of [['Error: The working copy is stale (not updated since operation 1).', 'stale'],
    ['Error: The "@" expression resolved to more than one operation', 'divergent'], ['Error: boom', 'error']]) {
    const h = spacesWith([['s1', '/r/main']], world((cmd, args) => isLog({ cmd, args }) ? fail(stderr) : undefined));
    await settle(h);
    const el = byId(h.render(), 'jj-status-s1');
    assert.deepEqual(words(el), [word]);
    assert.equal(el.calls.tooltip[0], stderr);
    assert.ok(h.logs.some(l => l.includes(stderr)));
  }
});

test('an agent turn ending snapshots only its own space', async () => {
  const h = spacesWith([['s1', '/r/main'], ['s2', '/r/w1']]);
  await settle(h);
  h.calls.length = 0;
  h.state.panes[0].status = 'working';
  await h.advance(250);
  h.state.panes[0].status = 'idle';
  await h.advance(250);
  const logs = h.calls.filter(isLog);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].cwd, '/r/main');
  assert.equal(logs[0].args.includes('--ignore-working-copy'), false);
});

test('an operation in the repository rereads every space on it, without snapshots', async () => {
  const h = spacesWith([['s1', '/r/main'], ['s2', '/r/w1'], ['s3', '/o']]);
  await settle(h);
  assert.deepEqual(h.watches.map(w => w.path).sort(), ['/o/.jj/repo/op_heads/heads', '/r/main/.jj/repo/op_heads/heads']);
  h.calls.length = 0;
  await h.fire('/r/main/.jj/repo/op_heads/heads');
  const logs = h.calls.filter(isLog);
  assert.deepEqual(logs.map(c => c.cwd).sort(), ['/r/main', '/r/w1']);
  assert.ok(logs.every(c => c.args[0] === '--ignore-working-copy'));
});

test('with a working watch no timer starts jj', async () => {
  const h = spacesWith([['s1', '/r/main']]);
  await settle(h);
  h.calls.length = 0;
  await h.advance(10 * 60 * 1000);
  assert.deepEqual(h.calls, []);
});

test('a refused watch or another machine reads every 30 seconds instead', async () => {
  const w = world();
  const h = spacesWith([['s1', '/r/main'], ['s4', '/o', 'box']], w, { watchFolder: async () => { throw new Error('too many files'); } });
  await settle(h);
  h.calls.length = 0;
  await h.advance(31_000);
  assert.deepEqual(h.calls.filter(isLog).map(c => [c.cwd, c.on]).sort(), [['/o', 'box'], ['/r/main', null]]);
  assert.ok(h.logs.some(l => l.includes('too many files')));
});

test('a hidden sidebar starts no command and reads everything once shown', async () => {
  const h = spacesWith([['s1', '/r/main']], world(), { layout: sidebar({ hidden: true }) });
  await h.advance(60_000);
  assert.deepEqual(h.calls, []);
  h.state.layout = sidebar();
  await settle(h);
  assert.ok(h.calls.some(isLog));
});

test('a narrow sidebar finds checkouts but reads no status lines', async () => {
  const h = spacesWith([['s1', '/r/main']], world(), { layout: sidebar({ size: { px: 100 } }) });
  await settle(h);
  assert.ok(h.calls.some(c => c.args.includes('root')));
  assert.equal(h.calls.some(isLog), false);
  h.state.layout = sidebar();
  await settle(h);
  assert.ok(h.calls.some(isLog));
});

test('status reads run one at a time', async () => {
  let inFlight = 0, most = 0;
  const w = world(async (cmd, args) => {
    if (!isLog({ cmd, args })) return undefined;
    most = Math.max(most, ++inFlight);
    await new Promise(r => setImmediate(r));
    inFlight--;
    return undefined;
  });
  const h = spacesWith([['s1', '/r/main'], ['s2', '/r/w1'], ['s3', '/o']], w);
  await settle(h);
  await h.fire('/r/main/.jj/repo/op_heads/heads');
  assert.equal(h.calls.filter(isLog).length >= 3, true);
  assert.equal(most, 1);
});

test('a request during a read produces exactly one more read', async () => {
  let release;
  const w = world(async (cmd, args) => {
    if (isLog({ cmd, args }) && !release) await new Promise(r => { release = r; });
    return undefined;
  });
  const h = spacesWith([['s1', '/r/main']], w);
  await settle(h);
  await h.fire('/r/main/.jj/repo/op_heads/heads');
  await h.fire('/r/main/.jj/repo/op_heads/heads');
  assert.equal(h.calls.filter(isLog).length, 1);
  release();
  await h.drain();
  assert.equal(h.calls.filter(isLog).length, 2);
});

test('a folder whose probe is pending runs no Git command', async () => {
  const w = world((cmd, args) => args?.includes('root') ? new Promise(() => {}) : undefined);
  const h = spacesWith([['s1', '/r/main']], w);
  await h.advance(60_000);
  assert.equal(h.calls.some(c => c.cmd === 'git'), false);
});

test('a probe failure other than no jj repo shows error', async () => {
  const w = world((cmd, args) => args.includes('root') ? fail('Error: Config error: bad toml') : undefined);
  const h = spacesWith([['s1', '/r/main']], w);
  await settle(h);
  assert.deepEqual(words(byId(h.render(), 'jj-status-s1')), ['error']);
  assert.equal(h.calls.some(c => c.cmd === 'git'), false);
});

test('folders outside jj keep the shipped Git code', async () => {
  const h = spacesWith([['s5', '/g']]);
  await settle(h);
  assert.ok(h.calls.some(c => c.cmd === 'git'));
  assert.equal(h.calls.some(isLog), false);
});

test('right-click opens jj-menu', async () => {
  const h = spacesWith([['s1', '/r/main']]);
  await settle(h);
  byId(h.render(), 'space-s1').handlers.on_mouse_down({ button: 'right' }, h.cx);
  assert.equal(h.overlays.at(-1).mod, 'jj-menu');
});

// jj-workspace

function dialog(action, over, data = {}) {
  const w = world(over);
  const h = load('jj-workspace', { spaces: [space('s1', '/r/main'), space('s2', '/r/w1')], panes: [pane('s1', '/r/main'), pane('s2', '/r/w1')],
    props: { space: 's1', folder: '/r/main', action, overlay: 'o1' }, exec: w.exec, readTextFile: w.readTextFile, ...data });
  h.calls = w.calls;
  return h;
}
const line = c => [c.cmd, ...c.args].join(' ');

test('New workspace adds it on a matching bookmark, links files and trusts linked mise files', async () => {
  const exists = new Set(['/r/main/.env', '/r/main/mise.toml']);
  const h = dialog('new', (cmd, args) => {
    if (args.includes('bookmark')) return ok('feat/x\nmain\n');
    if (args.includes('add')) return ok('');
    if (cmd === 'test') return exists.has(args[1]) && args[0] === '-e' ? ok('') : fail('');
    if (['mkdir', 'ln', 'mise'].includes(cmd)) return ok('');
  }, { layout: sidebar({}, { directory: '~/wt/{repo}/{name}', links: ['.env', 'mise.toml', 'missing'] }) });
  await h.drain();
  h.inputs[0].emit('change', 'feat/x');
  assert.ok(words(h.render()).some(x => x.includes('~/wt/main/feat-x, starts on bookmark feat/x')));
  h.inputs[0].emit('submit');
  await h.drain();
  const lines = h.calls.map(line);
  assert.ok(lines.indexOf('mkdir -p /home/u/wt/main') < lines.indexOf('jj workspace add --name feat/x -r "feat/x" /home/u/wt/main/feat-x'));
  assert.ok(lines.indexOf('mkdir -p /home/u/wt/main') >= 0);
  assert.ok(lines.includes('ln -s /r/main/.env /home/u/wt/main/feat-x/.env'));
  assert.ok(lines.includes('mise trust /home/u/wt/main/feat-x/mise.toml'));
  assert.equal(lines.some(l => l.includes('mise trust') && l.includes('.env')), false);
  assert.match(h.notifications[0].body, /missing: not in the main checkout/);
  assert.deepEqual(plain(h.actions.at(-1)), { name: 'space.new', args: { folder: '/home/u/wt/main/feat-x', machine: '' } });
  assert.deepEqual(plain(h.overlays.at(-1)), { close: 'o1' });
});

test('New workspace without a matching bookmark starts from the parent, and skips mise when it is missing', async () => {
  const h = dialog('new', (cmd, args) => {
    if (args.includes('bookmark')) return ok('main\n');
    if (args.includes('add')) return ok('');
    if (cmd === 'test') return args[0] === '-e' && args[1].startsWith('/r/main') ? ok('') : fail('');
    if (cmd === 'mise') throw new Error('not installed');
    if (['mkdir', 'ln'].includes(cmd)) return ok('');
  }, { layout: sidebar({}, { links: ['mise.toml'] }) });
  await h.drain();
  h.inputs[0].emit('change', 'topic');
  assert.ok(words(h.render()).some(x => x.includes("starts from this checkout's parent")));
  h.inputs[0].emit('submit');
  await h.drain();
  const lines = h.calls.map(line);
  assert.ok(lines.includes('jj workspace add --name topic /home/u/.herdr/worktrees/main/topic'));
  assert.equal(lines.some(l => l.startsWith('mise trust')), false);
  assert.equal(h.notifications.length, 0);
});

test('New workspace never replaces a file already in the new checkout', async () => {
  const h = dialog('new', (cmd, args) => {
    if (args.includes('bookmark')) return ok('');
    if (args.includes('add')) return ok('');
    if (cmd === 'mkdir') return ok('');
    if (cmd === 'test') return args[0] === '-L' ? ok('') : args[1].startsWith('/r/main') ? ok('') : fail('');
  }, { layout: sidebar({}, { links: ['.env'] }) });
  await h.drain();
  h.inputs[0].emit('change', 'topic');
  h.inputs[0].emit('submit');
  await h.drain();
  assert.equal(h.calls.some(c => c.cmd === 'ln'), false);
  assert.match(h.notifications[0].body, /\.env: already in the new checkout/);
});

test('a failed jj workspace add shows jj\u2019s error and opens nothing', async () => {
  const h = dialog('new', (cmd, args) => {
    if (args.includes('bookmark')) return ok('');
    if (cmd === 'mkdir') return ok('');
    if (args.includes('add')) return fail('Error: Workspace named \'topic\' already exists');
  });
  await h.drain();
  h.inputs[0].emit('change', 'topic');
  h.inputs[0].emit('submit');
  await h.drain();
  assert.ok(words(h.render()).some(x => x.includes('already exists')));
  assert.deepEqual(h.actions, []);
});

test('Open workspace lists the main checkout first and selects a space already on one', async () => {
  const list = [{ name: 'w1', root: '/r/w1' }, { name: 'default', root: '/r/main' }, { name: 'old', root: '' }];
  const h = dialog('open', (cmd, args) => args.includes('list') ? ok(list.map(x => JSON.stringify(x)).join('\n')) : undefined);
  await h.drain();
  const text = words(h.render());
  assert.ok(text.indexOf('default') < text.indexOf('w1'));
  assert.ok(text.includes('main checkout'));
  assert.ok(text.includes('unavailable'));
  byId(h.render(), 'wt-2').handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.actions.at(-1)), { name: 'space.select', args: { id: 's2' } });
});

test('Open workspace opens a space on a workspace no space shows', async () => {
  const list = [{ name: 'default', root: '/r/main' }, { name: 'w2', root: '/r/w2' }];
  const h = dialog('open', (cmd, args) => args.includes('list') ? ok(list.map(x => JSON.stringify(x)).join('\n')) : undefined);
  await h.drain();
  byId(h.render(), 'wt-1').handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.actions.at(-1)), { name: 'space.new', args: { folder: '/r/w2', machine: '' } });
});

test('a folder outside jj says so', async () => {
  const h = dialog('new', undefined, { props: { space: 's1', folder: '/g', action: 'new' } });
  await h.drain();
  assert.ok(words(h.render()).some(x => x.includes('/g is not in a jj repository.')));
});

// Menus

test('a jj space\u2019s menu offers New and Open workspace in place of worktrees', async () => {
  const w = world();
  const h = load('jj-menu', { spaces: [space('s1', '/r/main')], panes: [pane('s1', '/r/main')], props: { tab: 'space', target: { id: 's1' } },
    exec: w.exec, readTextFile: w.readTextFile });
  await h.drain();
  const text = words(h.render());
  assert.ok(text.includes('New workspace') && text.includes('Open workspace'));
  assert.equal(text.includes('New worktree'), false);
  assert.equal(w.calls.some(c => c.cmd === 'git'), false);
});

test('a space outside jj keeps the shipped menu', async () => {
  const w = world();
  const h = load('jj-menu', { spaces: [space('s1', '/g')], panes: [pane('s1', '/g')], props: { tab: 'space', target: { id: 's1' } },
    exec: w.exec, readTextFile: w.readTextFile });
  await h.drain();
  assert.equal(words(h.render()).includes('New workspace'), false);
  assert.ok(w.calls.some(c => c.cmd === 'git'));
});

test('the New menu opens jj-workspace from a jj checkout', async () => {
  const w = world();
  const h = load('jj-new-menu', { spaces: [{ ...space('s1', '/r/main'), active: true }], panes: [{ ...pane('s1', '/r/main'), focused: true }],
    props: { overlay: 'o1' }, exec: w.exec, readTextFile: w.readTextFile });
  await h.drain();
  assert.ok(words(h.render()).includes('New workspace\u2026'));
  byId(h.render(), 'worktree').handlers.on_click({}, h.cx);
  assert.deepEqual(h.overlays.at(-1).mod, 'jj-workspace');
  assert.deepEqual(plain(h.overlays.at(-1).props), { space: 's1', folder: '/r/main', action: 'new' });
});

// Layout

test('the layout mounts Herdr\u2019s agents list and no Git poller, with settings on jj-spaces', () => {
  const layout = JSON.parse(readFileSync(new URL('../layouts/jj-tui.json', import.meta.url)));
  const blocks = [];
  const walk = node => { if (node.content?.mod) blocks.push(node.content); (node.children ?? []).forEach(walk); };
  walk(layout);
  const mods = blocks.map(b => b.mod);
  for (const m of ['jj-spaces', 'agents', 'jj-tabs']) assert.ok(mods.includes(m), m);
  assert.equal(mods.includes('changes'), false);
  assert.deepEqual(blocks.find(b => b.mod === 'jj-spaces').props, { directory: '~/.herdr/worktrees/{repo}/{name}', links: [], miseTrust: true });
});

test('jj-tabs offers only the Files panel', () => {
  assert.match(readFileSync(new URL('../mods/jj-tabs/main.js', import.meta.url), 'utf8'), /const enabled = \["files"\];/);
});
