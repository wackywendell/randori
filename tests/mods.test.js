import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { load, byId, words, nodes } from './mod-harness.js';

const ok = stdout => ({ code: 0, stdout, stderr: '' });
const fail = stderr => ({ code: 1, stdout: '', stderr });
// Values from the mod's sandbox, as plain data for deepEqual.
const plain = v => JSON.parse(JSON.stringify(v));
const isLog = c => c.cmd === 'jj' && c.args.includes('log');

// Two jj repositories: /r/main with a linked workspace /r/w1, and /o.
// /g is in no jj repository.
const ROOTS = { '/r/main': '/r/main', '/r/main/sub': '/r/main', '/r/w1': '/r/w1', '/r/w1/src': '/r/w1', '/r/w2': '/r/w2', '/o': '/o' };
const FILES = { '/r/main/.jj/repo/store/type': 'git', '/o/.jj/repo/store/type': 'git', '/r/w1/.jj/repo': '../../main/.jj/repo', '/r/w2/.jj/repo': '../../main/.jj/repo' };
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

// A space named "main" with a tab in /r/main and a tab in /o, whose @ is on bookmark "other-o".
function twoRepos(active) {
  const s = { ...space('s1', '/r/main'), name: 'main', tabs: [{ id: 's1-tab', active: active === 0 }, { id: 'second', active: active === 1 }] };
  const w = world((cmd, args, opts) => isLog({ cmd, args }) && opts.cwd === '/o'
    ? ok(JSON.stringify({ ...STACK[0], bookmarks: ['other-o'] }) + '\n') : undefined);
  const h = load('jj-spaces', { layout: sidebar(), spaces: [s], panes: [pane('s1', '/r/main'), { ...pane('s1', '/o'), pane: 'p2', terminal: 't2', tab: 'second' }],
    exec: w.exec, readTextFile: w.readTextFile });
  h.calls = w.calls;
  return h;
}

test('a space in two jj repositories shows its active tab’s, named when the space’s name differs', async () => {
  const h = twoRepos(1);
  await settle(h);
  assert.deepEqual(row(h, 's1').slice(-5), ['o', 'other-o', '~3', '+120', '-8']);
  h.state.spaces[0].tabs = h.state.spaces[0].tabs.map((t, i) => ({ ...t, active: i === 0 }));
  await settle(h);
  assert.deepEqual(row(h, 's1').slice(-4), ['master~4', '~3', '+120', '-8']);
});

test('going back to a tab rereads its checkout, which no operation reread while it was hidden', async () => {
  const h = twoRepos(1);
  await settle(h);
  const select = n => { h.state.spaces[0].tabs = h.state.spaces[0].tabs.map((t, i) => ({ ...t, active: i === n })); };
  select(0);
  await settle(h);
  h.calls.length = 0;
  await h.fire('/o/.jj/repo/op_heads/heads');
  assert.deepEqual(h.calls.filter(isLog), []);
  select(1);
  await settle(h);
  assert.deepEqual(h.calls.filter(isLog).map(c => [c.cwd, c.args[0]]), [['/o', '--ignore-working-copy']]);
});

test('an agent turn ending in a space’s active tab snapshots that tab’s checkout', async () => {
  const h = twoRepos(1);
  await settle(h);
  h.calls.length = 0;
  h.state.panes[1].status = 'working';
  await h.advance(250);
  h.state.panes[1].status = 'idle';
  await h.advance(250);
  const logs = h.calls.filter(isLog);
  assert.deepEqual(logs.map(c => [c.cwd, c.args.includes('--ignore-working-copy')]), [['/o', false]]);
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

test('an operation after a space closes reads nothing for the closed space’s checkout', async () => {
  const h = spacesWith([['s1', '/r/main'], ['s2', '/r/w1']]);
  await settle(h);
  h.state.spaces = h.state.spaces.filter(s => s.id !== 's2');
  h.state.panes = h.state.panes.filter(p => p.tab !== 's2-tab');
  await settle(h);
  h.calls.length = 0;
  await h.fire('/r/main/.jj/repo/op_heads/heads');
  assert.deepEqual(h.calls.filter(isLog).map(c => c.cwd), ['/r/main']);
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

// Finish: space s1 has a tab in w1 and a tab in w2, space s2 a terminal in
// w1, t4 is a parked terminal in w1 and t5 works in the main checkout.
const WS = [{ name: 'default', root: '/r/main' }, { name: 'w1', root: '/r/w1' }, { name: 'w2', root: '/r/w2' }];
const listed = (ws = WS) => ok(ws.map(x => JSON.stringify(x)).join('\n'));
function finishing(over = () => undefined) {
  const h = dialog('finish', (cmd, args, opts) => over(cmd, args, opts) ?? (args.includes('list') ? listed() : args[0] === 'status' || args.includes('remove') ? ok('') : undefined), {
    spaces: [{ id: 's1', name: 'review', machine: null, folder: '/r/w1', tabs: [{ id: 'k1' }, { id: 'k2' }] }, { id: 's2', name: 'nesting', machine: null, folder: '/r/w1', tabs: [{ id: 'k3' }] }],
    panes: [{ pane: 'p1', tab: 'k1', terminal: 't1', cwd: '/r/w1/src' }, { pane: 'p2', tab: 'k2', terminal: 't2', cwd: '/r/w2' }, { pane: 'p3', tab: 'k3', terminal: 't3', cwd: '/r/w1' }],
    terminals: [{ address: 't1', cwd: '/r/w1/src' }, { address: 't2', cwd: '/r/w2' }, { address: 't3', cwd: '/r/w1' }, { address: 't4', cwd: '/r/w1' }, { address: 't5', cwd: '/r/main' }],
    props: { space: 's1', folder: '/r/w1/src', action: 'finish', overlay: 'o1' },
  });
  return h;
}
const key = (h, k) => byId(h.render(), 'worktree').handlers.on_key_down({ key: k }, h.cx);
// Ends the killed terminals, as the core would, and lets Finish see it.
async function ended(h) {
  const killed = new Set(h.actions.filter(a => a.name === 'terminal.kill').map(a => a.args.terminal));
  h.state.terminals = h.state.terminals.filter(t => !killed.has(t.address));
  h.state.panes = h.state.panes.filter(p => !killed.has(p.terminal));
  await h.advance(200);
}
const runs = (h, name) => plain(h.actions.filter(a => a.name === name).map(a => a.args));
const jjLines = h => h.calls.filter(c => c.cmd === 'jj' && !c.args.includes('root')).map(c => `${c.cwd}: ${c.args.join(' ')}`);

test('Finish lists the space\u2019s linked workspaces in tab order, checks the first and names other spaces that end', async () => {
  const h = finishing();
  await h.drain();
  const text = words(h.render());
  assert.ok(text.indexOf('w1') < text.indexOf('w2'));
  assert.equal(byId(h.render(), 'finish-check-0').calls.checked[0], true);
  assert.equal(byId(h.render(), 'finish-check-1').calls.checked[0], false);
  assert.ok(text.includes('Its terminals in nesting end too.'));
  assert.ok(text.some(x => x.includes('Files jj does not track, including ignored files, are deleted.')));
  key(h, 'down'); key(h, 'space');
  assert.equal(byId(h.render(), 'finish-check-1').calls.checked[0], true);
  assert.deepEqual(h.actions, []);
});

test('Finish stops before ending anything when jj status fails', async () => {
  const h = finishing((cmd, args) => args[0] === 'status' ? fail('Error: The working copy is locked') : undefined);
  await h.drain();
  key(h, 'enter');
  await h.drain();
  assert.ok(words(h.render()).includes('Error: The working copy is locked'));
  assert.deepEqual(h.actions, []);
  assert.equal(jjLines(h).some(l => l.includes('remove')), false);
  assert.deepEqual(h.overlays, []);
});

test('Finish kills every terminal in a checked folder, closes their other panes and removes the workspace', async () => {
  const h = finishing();
  await h.drain();
  key(h, 'enter');
  await h.drain();
  assert.deepEqual(runs(h, 'terminal.kill'), [{ terminal: 't1' }, { terminal: 't3' }, { terminal: 't4' }]);
  assert.equal(jjLines(h).some(l => l.includes('remove')), false);
  await ended(h);
  assert.deepEqual(runs(h, 'space.close'), []);
  assert.deepEqual(runs(h, 'pane.close'), []);
  assert.deepEqual(jjLines(h), ['/r/main: --ignore-working-copy workspace list -T json({"name" => name, "root" => root}) ++ "\\n"',
    '/r/main: --ignore-working-copy workspace list -T json({"name" => name, "root" => root}) ++ "\\n"', '/r/w1: status', '/r/main: workspace remove w1']);
  assert.deepEqual(plain(h.overlays.at(-1)), { close: 'o1' });
});

test('Finish closes panes still showing an ended terminal', async () => {
  const h = finishing();
  await h.drain();
  key(h, 'enter');
  await h.drain();
  h.state.terminals = h.state.terminals.filter(t => !['t1', 't3', 't4'].includes(t.address));
  await h.advance(200);
  assert.deepEqual(runs(h, 'pane.close'), [{ pane: 'p1' }, { pane: 'p3' }]);
  assert.deepEqual(runs(h, 'space.close'), []);
});

test('Finish closes the space once none of its terminals are left and removes one name at a time', async () => {
  let release;
  const h = finishing((cmd, args) => args.includes('remove') && args.includes('w1') ? new Promise(r => { release = () => r(ok('')); }) : undefined);
  await h.drain();
  key(h, 'down'); key(h, 'space'); key(h, 'enter');
  await h.drain();
  assert.deepEqual(runs(h, 'terminal.kill'), [{ terminal: 't1' }, { terminal: 't2' }, { terminal: 't3' }, { terminal: 't4' }]);
  h.state.terminals = h.state.terminals.filter(t => t.address === 't5');
  h.state.panes = h.state.panes.filter(p => p.pane === 'p3');
  await h.advance(200);
  assert.deepEqual(runs(h, 'space.close'), [{ id: 's1', confirmed: true }]);
  assert.deepEqual(runs(h, 'pane.close'), [{ pane: 'p3' }]);
  assert.equal(jjLines(h).some(l => l.endsWith('remove w2')), false);
  release();
  await h.drain();
  assert.deepEqual(jjLines(h).filter(l => l.includes('remove')), ['/r/main: workspace remove w1', '/r/main: workspace remove w2']);
});

test('Finish stops when a terminal is still listed after 10 seconds', async () => {
  const h = finishing();
  await h.drain();
  key(h, 'enter');
  await h.drain();
  for (let i = 0; i < 50; i++) await h.advance(200);
  assert.ok(words(h.render()).includes('Terminal t1 in /r/w1/src did not stop.'));
  assert.equal(jjLines(h).some(l => l.includes('remove')), false);
  assert.deepEqual(runs(h, 'space.close'), []);
});

test('Enter after a failure retries only the names not yet removed', async () => {
  let gone = false, refuse = true;
  const h = finishing((cmd, args) => {
    if (args.includes('list')) return listed(gone ? WS.filter(w => w.name !== 'w1') : WS);
    if (args.includes('remove') && args.includes('w1')) { gone = true; return ok(''); }
    if (args.includes('remove') && refuse) { refuse = false; return fail('Error: lock held'); }
  });
  await h.drain();
  key(h, 'down'); key(h, 'space'); key(h, 'enter');
  await h.drain();
  await ended(h);
  assert.ok(words(h.render()).includes('Error: lock held'));
  assert.ok(words(h.render()).includes('removed'));
  h.calls.length = 0;
  key(h, 'enter');
  await h.drain();
  assert.deepEqual(jjLines(h).filter(l => !l.includes('list')), ['/r/w2: status', '/r/main: workspace remove w2']);
  assert.deepEqual(plain(h.overlays.at(-1)), { close: 'o1' });
});

test('Finish stops when jj no longer lists a checked workspace', async () => {
  let n = 0;
  const h = finishing((cmd, args) => args.includes('list') ? listed(n++ ? WS.filter(w => w.name !== 'w1') : WS) : undefined);
  await h.drain();
  key(h, 'enter');
  await h.drain();
  assert.ok(words(h.render()).includes('jj no longer lists w1. Its folder /r/w1 remains.'));
  assert.deepEqual(h.actions, []);
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

test('a space with a terminal in a linked workspace offers Finish workspace in a window', async () => {
  const w = world();
  const h = load('jj-menu', { spaces: [{ ...space('s1', '/r/main'), tabs: [{ id: 's1-tab' }, { id: 'k2' }] }],
    panes: [pane('s1', '/r/main'), { pane: 'p2', tab: 'k2', terminal: 't2', cwd: '/r/w1' }], props: { tab: 'space', target: { id: 's1' }, overlay: 'm1' },
    exec: w.exec, readTextFile: w.readTextFile });
  await h.drain();
  const list = words(h.render());
  assert.ok(list.includes('Finish workspace'));
  h.view.choose(list.filter(x => ['Rename', 'New workspace', 'Open workspace', 'Finish workspace', 'Close'].includes(x)).indexOf('Finish workspace'), h.cx);
  assert.equal(h.overlays.at(-1).kind, 'window');
  assert.deepEqual(plain(h.overlays.at(-1).props), { space: 's1', folder: '/r/main', action: 'finish' });
});

test('a space only in the main checkout offers no Finish workspace', async () => {
  const w = world();
  const h = load('jj-menu', { spaces: [space('s1', '/r/main')], panes: [pane('s1', '/r/main')], props: { tab: 'space', target: { id: 's1' } },
    exec: w.exec, readTextFile: w.readTextFile });
  await h.drain();
  assert.equal(words(h.render()).includes('Finish workspace'), false);
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
  const layout = JSON.parse(readFileSync(new URL('../layouts/jj.json', import.meta.url)));
  const blocks = [];
  const walk = node => { if (node.content?.mod) blocks.push(node.content); (node.children ?? []).forEach(walk); };
  walk(layout);
  const mods = blocks.map(b => b.mod);
  for (const m of ['jj-spaces', 'agents', 'jj-tabs', 'jj-changes']) assert.ok(mods.includes(m), m);
  assert.equal(mods.includes('changes'), false);
  assert.equal('preview' in layout, false);
  assert.deepEqual(blocks.find(b => b.mod === 'jj-spaces').props, { directory: '~/.herdr/worktrees/{repo}/{name}', links: [], miseTrust: true });
});

function loadPanelItems() {
  const src = readFileSync(new URL('../mods/jj-tabs/main.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class ', 'class ')
    .replace(/^export /gm, '');
  return vm.runInNewContext(`${src}\npanelItems`, { View: class {}, ScrollHandle: { new: () => ({}) } });
}

function tabsLayout({ panelHidden = true, activePanel = 'files', panels, terminalMenu, tabProps } = {}) {
  const children = panels ?? [
    { id: 'files', type: 'block', content: { mod: 'files' } },
    { id: 'changes', type: 'block', content: { mod: 'jj-changes' } },
  ];
  return {
    id: 'root',
    type: 'row',
    ...(terminalMenu !== undefined ? { terminal_menu: terminalMenu } : {}),
    children: [
      { id: 'tabs', type: 'block', content: { mod: 'jj-tabs', ...(tabProps ? { props: tabProps } : {}) } },
      {
        id: 'panel',
        type: 'column',
        hidden: panelHidden,
        children: [{ id: 'panel-body', type: 'stack', active: activePanel, children }],
      },
    ],
  };
}

function tabsWith(data = {}) {
  return load('jj-tabs', {
    spaces: [{ id: 's1', active: true, tabs: [{ id: 't1', name: 'shell', active: true }] }],
    panes: [{ pane: 'p1', tab: 't1', terminal: 'term1', program: { shell: true } }],
    layout: tabsLayout(),
    ...data,
  });
}

test('panelItems derives buttons from panel-body, gating built-ins on workspace.panels and including custom blocks', () => {
  const panelItems = loadPanelItems();
  assert.deepEqual(plain(panelItems(null, ['files', 'changes'])), []);
  assert.deepEqual(plain(panelItems({}, ['files', 'changes'])), []);
  assert.deepEqual(plain(panelItems({ children: [] }, ['files'])), []);
  const body = {
    children: [
      { id: 'files', type: 'block', content: { mod: 'files' } },
      { id: 'changes', type: 'block', content: { mod: 'jj-changes' } },
      { id: 'diff', type: 'block', content: { mod: 'diff-panel', props: { label: 'Diff', icon: '≋' } } },
      { id: 'notes', type: 'block', content: { mod: 'notes' } },
      { id: 'graph', type: 'block', content: { mod: 'graph', props: { label: 'Graph', icon: 'mods/graph/g.svg' } } },
      { id: 'constructor', type: 'block', content: { mod: 'ctor' } },
      { id: 'toString', type: 'block', content: { mod: 'tostr', props: { label: 'ToString' } } },
      { id: 'secret', type: 'block', hidden: true, content: { mod: 'secret', props: { label: 'Secret' } } },
    ],
  };
  assert.deepEqual(plain(panelItems(body, ['files'])), [
    { id: 'files', label: 'Files', icon: 'mods/files/file.svg' },
    { id: 'diff', label: 'Diff', icon: '≋' },
    { id: 'notes', label: 'Notes', icon: null },
    { id: 'graph', label: 'Graph', icon: 'mods/graph/g.svg' },
    { id: 'constructor', label: 'Constructor', icon: null },
    { id: 'toString', label: 'ToString', icon: null },
  ]);
});

test('jj-tabs renders zero panel buttons and runs nothing when panel, panel-body, or panel-body.children is missing or empty', () => {
  const panelIds = tree => nodes(tree).map(n => n.calls.id?.[0]).filter(id => id?.startsWith('panel-'));
  const layouts = [
    { id: 'root', type: 'row', children: [{ id: 'tabs', type: 'block', content: { mod: 'jj-tabs' } }] },
    { id: 'root', type: 'row', children: [{ id: 'tabs', type: 'block', content: { mod: 'jj-tabs' } }, { id: 'panel', type: 'column', hidden: false, children: [] }] },
    tabsLayout({ panelHidden: false, activePanel: 'files', panels: [] }),
  ];
  for (const layout of layouts) {
    const s1 = { id: 's1', active: true, tabs: [{ id: 't1', name: 'shell', active: true }] };
    const s2 = { id: 's2', active: false, tabs: [{ id: 't2', name: 'shell', active: true }] };
    const h = tabsWith({
      spaces: [s1, s2],
      panes: [
        { pane: 'p1', tab: 't1', terminal: 'term1', program: { shell: true } },
        { pane: 'p2', tab: 't2', terminal: 'term2', program: { shell: true } },
      ],
      layout,
      shared: { 'workspace.panels': ['files', 'changes'] },
    });
    assert.deepEqual(panelIds(h.render()), []);
    assert.deepEqual(h.actions, []);
    s1.active = false;
    s2.active = true;
    assert.deepEqual(panelIds(h.render()), []);
    assert.deepEqual(h.actions, []);
  }
});

test('jj-tabs offers the Files and Changes panels and renders custom panel-body blocks', () => {
  const panels = [
    { id: 'files', type: 'block', content: { mod: 'files' } },
    { id: 'changes', type: 'block', content: { mod: 'jj-changes' } },
    { id: 'diff', type: 'block', content: { mod: 'diff-panel', props: { label: 'Diff', icon: '≋' } } },
    { id: 'notes', type: 'block', content: { mod: 'notes' } },
    { id: 'graph', type: 'block', content: { mod: 'graph', props: { label: 'Graph', icon: 'mods/graph/g.svg' } } },
  ];
  const h = tabsWith({
    layout: tabsLayout({ panels }),
    shared: { 'workspace.panels': ['files', 'changes'] },
  });
  const tree = h.render();
  assert.deepEqual(words(byId(tree, 'panel-files')), ['Files']);
  assert.deepEqual(words(byId(tree, 'panel-changes')), ['Changes']);
  assert.deepEqual(words(byId(tree, 'panel-diff')), ['≋', 'Diff']);
  assert.equal(byId(tree, 'panel-diff')._children[0].calls.text_size[0], 12);
  assert.deepEqual(words(byId(tree, 'panel-notes')), ['Notes']);
  assert.equal(byId(tree, 'panel-notes')._children.length, 1);
  assert.deepEqual(words(byId(tree, 'panel-graph')), ['Graph']);
  assert.equal(byId(tree, 'panel-graph')._children[0].calls.size[0], 14);
  byId(tree, 'panel-diff').handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.actions), [
    { name: 'layout.select', args: { stack: 'panel-body', child: 'diff' } },
    { name: 'layout.show', args: { id: 'panel' } },
  ]);
});

test('jj-tabs leaves the open panel as it is when switching spaces, as Herdr does', () => {
  const panels = [
    { id: 'files', type: 'block', content: { mod: 'files' } },
    { id: 'changes', type: 'block', content: { mod: 'jj-changes' } },
    { id: 'diff', type: 'block', content: { mod: 'diff-panel', props: { label: 'Diff', icon: '≋' } } },
  ];
  const s1 = { id: 's1', active: true, tabs: [{ id: 't1', name: 'shell', active: true }] };
  const s2 = { id: 's2', active: false, tabs: [{ id: 't2', name: 'shell', active: true }] };
  const h = tabsWith({
    spaces: [s1, s2],
    panes: [
      { pane: 'p1', tab: 't1', terminal: 'term1', program: { shell: true } },
      { pane: 'p2', tab: 't2', terminal: 'term2', program: { shell: true } },
    ],
    layout: tabsLayout({ panelHidden: false, activePanel: 'diff', panels }),
    shared: { 'workspace.panels': ['files', 'changes'] },
  });
  for (const layout of [tabsLayout({ panelHidden: false, activePanel: 'diff', panels }), tabsLayout({ panelHidden: true, activePanel: 'files', panels })]) {
    h.state.layout = layout;
    h.render();
    [s1.active, s2.active] = [s2.active, s1.active];
    h.render();
  }
  assert.deepEqual(h.actions, []);
});

test('jj-tabs resolves tab context menu and new-tab menu from props and layout.terminal_menu', () => {
  const h1 = tabsWith({ layout: tabsLayout() });
  const t1 = h1.render();
  byId(t1, 'tab-t1').handlers['on_mouse_down:right']({}, h1.cx);
  byId(t1, 'tab-new').handlers.on_click({}, h1.cx);
  assert.deepEqual(h1.overlays.map(o => o.mod), ['jj-menu', 'jj-new-menu']);

  const h2 = tabsWith({ layout: tabsLayout({ terminalMenu: 'root-menu' }) });
  const t2 = h2.render();
  byId(t2, 'tab-t1').handlers['on_mouse_down:right']({}, h2.cx);
  byId(t2, 'tab-new').handlers.on_click({}, h2.cx);
  assert.deepEqual(h2.overlays.map(o => o.mod), ['root-menu', 'jj-new-menu']);

  const h3 = tabsWith({
    layout: tabsLayout({ terminalMenu: 'root-menu' }),
    props: { menu: 'prop-menu', newMenu: 'prop-new-menu' },
  });
  const t3 = h3.render();
  byId(t3, 'tab-t1').handlers['on_mouse_down:right']({}, h3.cx);
  byId(t3, 'tab-new').handlers.on_click({}, h3.cx);
  assert.deepEqual(h3.overlays.map(o => o.mod), ['prop-menu', 'prop-new-menu']);
});

// The changes panel, shown in the panel stack beside Files.
const panelLayout = (hidden = false, active = 'changes') => ({ type: 'row', children: [{ id: 'panel', type: 'column', hidden, children: [
  { id: 'panel-body', type: 'stack', active, children: [{ id: 'files', type: 'block', content: { mod: 'files' } }, { id: 'changes', type: 'block', content: { mod: 'jj-changes' } }] }] }] });
const PANEL_STACK = [
  { commit: 'c1', change: { prefix: 'a', rest: 'aaaaa' }, description: '', empty: false, conflict: false, at: true, bookmarks: [], base: false,
    files: [{ path: 'src/a.js', status: 'M', added: 2, removed: 1 }] },
  { commit: 'c2', change: { prefix: 'bb', rest: 'bbbb' }, description: 'two', empty: false, conflict: false, at: false, lines: ['1 0'],
    bookmarks: [{ name: 'feat' }, { name: 'feat', remote: 'git' }, { name: 'feat', remote: 'origin' }, { name: 'wip' }], base: false },
  { commit: 'c3', change: { prefix: 'c', rest: 'ccccc' }, description: 'one', empty: false, conflict: true, at: false, bookmarks: [], base: false, lines: ['3 0', '1 0'] },
  { commit: 'c4', change: { prefix: 'd', rest: 'ddddd' }, description: 'start', empty: false, conflict: false, at: false, bookmarks: [{ name: 'master' }], base: true },
];
const isSnap = c => c.cmd === 'jj' && c.args.join(' ') === 'util snapshot';
const stackRev = c => c.args.find(a => a.startsWith('@:: | ('));
const isStack = c => isLog(c) && Boolean(stackRev(c));

// A panel focused on `cwd`. `answers(cmd, args)` answers first.
function panel(cwd = '/r/main', answers = () => undefined, data = {}) {
  let stack = PANEL_STACK;
  const w = world((cmd, args, opts) => {
    const answer = answers(cmd, args, opts);
    if (answer) return answer;
    if (cmd !== 'jj') return undefined;
    if (args.join(' ') === 'util snapshot') return ok('');
    if (args.some(a => a.startsWith('@:: | ('))) return ok(stack.map(c => JSON.stringify({ ...c, files: c.files?.map(f => JSON.stringify(f)) })).join('\n') + '\n');
    if (args.includes('log')) return ok(JSON.stringify({ ...PANEL_STACK[1], files: [JSON.stringify({ path: 'b.txt', status: 'A', added: 1, removed: 0 })] }) + '\n');
    if (args.includes('diff')) return ok('{"path":"p.txt","status":"M"}\n');
    return undefined;
  });
  const h = load('jj-changes', { layout: panelLayout(), spaces: [{ id: 's1', active: true, folder: cwd, machine: null, tabs: [] }],
    panes: [{ pane: 'p1', cwd }], focused: { space: 's1', pane: 'p1' }, exec: w.exec, readTextFile: w.readTextFile, ...data });
  h.calls = w.calls;
  h.setStack = s => { stack = s; };
  return h;
}
async function shown(h) { h.render(); await h.drain(); h.render(); await h.drain(); }
const click = (h, id, shift = false) => byId(h.render(), id).handlers.on_click({ modifiers: { shift } }, h.cx);

test('the panel shows nothing and runs no Git while its probe is pending', async () => {
  const h = panel('/r/main', (cmd, args) => args.includes('root') ? new Promise(() => {}) : undefined);
  await shown(h);
  assert.deepEqual(words(h.render()), []);
  assert.deepEqual(plain(h.calls.map(c => c.cmd)), ['jj']);
});

test('the panel runs the shipped Git code in a Git-only folder', async () => {
  const h = panel('/g', (cmd, args) => cmd === 'git' ? (args.includes('--show-toplevel') ? ok('/g\n') : ok('')) : undefined);
  await shown(h);
  assert.ok(h.calls.some(c => c.cmd === 'git' && c.args.includes('status')));
  assert.equal(h.calls.some(isSnap), false);
  assert.ok(words(h.render()).includes('Commit'));
  assert.ok(h.timers.some(t => t.every === 10000));
});

test('showing the panel snapshots and reads the stack, with the files of @', async () => {
  const h = panel();
  await shown(h);
  const jjCalls = h.calls.filter(c => c.cmd === 'jj').map(c => c.args.slice(0, 2).join(' '));
  assert.deepEqual(plain(jjCalls), ['--ignore-working-copy workspace', 'util snapshot', '--ignore-working-copy log']);
  assert.equal(h.calls.some(c => c.cmd === 'git'), false);
  assert.equal(h.timers.some(t => t.every === 10000), false);
  const text = words(h.render());
  for (const w of ['main', '@ ', 'a', 'aaaaa', 'two', 'conflict', 'a.js', 'diff', 'trunk()', 'feat', 'feat@origin', '+1', 'start', 'base']) assert.ok(text.includes(w), `${w} in ${text}`);
  assert.equal(text.includes('wip') || text.some(w => w.endsWith('@git')), false, text.join(','));
  assert.ok(text.some(w => w.startsWith('updated ')));
  // Files changed, then line totals: @'s from its file list, other rows' from jj's per-file lines.
  const row = c => words(byId(h.render(), `stack-${c}`)).filter(w => /^[~+−]\d/.test(w));
  assert.deepEqual([row('c1'), row('c2'), row('c3'), row('c4')], [['~1', '+2', '−1'], ['+1', '~1', '+1'], ['~2', '+4'], []]);
  assert.match(h.calls.find(isStack).args.at(-1), /change_id\.shortest\(6\)/);
});

test('full rows, the default, put the description on a second line for every change including the base, and the rows prop compact keeps one', async () => {
  for (const rows of [undefined, 'full', 'compact']) {
    const layout = panelLayout();
    if (rows) layout.children[0].children[0].children[1].content.props = { rows };
    const h = panel('/r/main', () => undefined, { layout });
    await shown(h);
    const lines = c => byId(h.render(), `stack-${c}`)._children.map(words);
    const full = rows !== 'compact';
    assert.equal(lines('c2').length, full ? 2 : 1, rows);
    assert.deepEqual(full ? lines('c2')[1] : [], full ? ['two', '+', '↓'] : [], String(rows));
    assert.ok(lines('c2')[0].includes('~1') && lines('c2')[0].includes('feat'), rows);
    assert.equal(lines('c4').length, full ? 2 : 1, `${rows}: the base row has the same layout`);
  }
});

test('the idLength prop sets how many characters a change ID shows', async () => {
  const layout = panelLayout();
  layout.children[0].children[0].children[1].content.props = { idLength: 9 };
  const h = panel('/r/main', () => undefined, { layout });
  await shown(h);
  assert.match(h.calls.find(isStack).args.at(-1), /change_id\.shortest\(9\)/);
});

const BOOKMARKS = (cmd, args) => args.includes('bookmark') ? ok('main\nmain@origin\nfeat/x\n') : undefined;
const pick = (h, key) => byId(h.render(), 'changes-base-picker').handlers.on_key_down({ key }, h.cx);
const bases = h => plain(h.shared.get('jj-changes:bases'));
const lastBase = h => stackRev(h.calls.filter(isStack).at(-1));

test('the base picker lists the newest bookmarks, filters as you type and keeps each workspace’s base', async () => {
  const h = panel('/r/main', BOOKMARKS, { shared: { 'jj-changes:bases': { '/r/other': 'other@origin' } } });
  await shown(h);
  assert.equal(lastBase(h), '@:: | ((trunk()).. & first_ancestors(@)) | heads(::@ & ::(trunk()))');
  click(h, 'changes-base');
  await h.drain();
  assert.equal(h.inputs[1].value(), 'trunk()');
  assert.ok(h.calls.some(c => line(c) === 'jj --ignore-working-copy bookmark list --all-remotes --sort committer-date- -T if(!remote || remote != "git", name ++ if(remote, "@" ++ remote) ++ "\n")'));
  for (const name of ['main', 'main@origin', 'feat/x']) assert.ok(byId(h.render(), `changes-base-${name}`), name);
  h.inputs[1].emit('change', 'origin');
  assert.equal(byId(h.render(), 'changes-base-main'), undefined);
  pick(h, 'enter');
  await h.drain();
  assert.deepEqual(bases(h), { '/r/other': 'other@origin', '/r/main': 'main@origin' });
  assert.equal(lastBase(h), '@:: | ((main@origin).. & first_ancestors(@)) | heads(::@ & ::(main@origin))');
  assert.equal(byId(h.render(), 'changes-base-picker'), undefined);
  assert.ok(words(h.render()).includes('main@origin'));
  click(h, 'changes-base');
  await h.drain();
  h.inputs[1].emit('change', '');
  pick(h, 'enter');
  await h.drain();
  assert.deepEqual(bases(h), { '/r/other': 'other@origin' });
  assert.equal(lastBase(h), '@:: | ((trunk()).. & first_ancestors(@)) | heads(::@ & ::(trunk()))');
});

test('the base picker takes a typed revset, fills the input as ↑↓ move like an address bar, takes a click, and Escape', async () => {
  const h = panel('/r/main', BOOKMARKS);
  await shown(h);
  click(h, 'changes-base');
  await h.drain();
  h.inputs[1].emit('change', 'main-');
  pick(h, 'enter');
  await h.drain();
  assert.equal(lastBase(h), '@:: | ((main-).. & first_ancestors(@)) | heads(::@ & ::(main-))');
  // ↓ fills the input and keeps the list; past the end it puts back what was typed.
  click(h, 'changes-base');
  await h.drain();
  h.inputs[1].emit('change', 'ma');
  assert.ok(byId(h.render(), 'changes-base-main').calls.bg, 'typing highlights the first match');
  pick(h, 'down');
  assert.equal(h.inputs[1].value(), 'main', 'the first ↓ fills the highlighted match');
  pick(h, 'down');
  assert.equal(h.inputs[1].value(), 'main@origin');
  assert.ok(byId(h.render(), 'changes-base-main'), 'the fill leaves the list as typed');
  pick(h, 'down');
  assert.equal(h.inputs[1].value(), 'ma');
  pick(h, 'up');
  assert.equal(h.inputs[1].value(), 'main@origin');
  // Escape first puts back what was typed, leaving the picker open.
  pick(h, 'escape');
  assert.equal(h.inputs[1].value(), 'ma');
  assert.ok(byId(h.render(), 'changes-base-picker'));
  // A filled bookmark, edited, applies as typed.
  h.inputs[1].emit('change', 'fe');
  pick(h, 'up');
  assert.equal(h.inputs[1].value(), 'feat/x');
  h.inputs[1].emit('change', 'feat/x-');
  pick(h, 'enter');
  await h.drain();
  assert.equal(lastBase(h), '@:: | ((feat/x-).. & first_ancestors(@)) | heads(::@ & ::(feat/x-))');
  click(h, 'changes-base');
  await h.drain();
  click(h, 'changes-base-feat/x');
  await h.drain();
  assert.deepEqual(bases(h), { '/r/main': 'feat/x' });
  click(h, 'changes-base');
  await h.drain();
  pick(h, 'escape');
  assert.equal(byId(h.render(), 'changes-base-picker'), undefined);
  assert.deepEqual(bases(h), { '/r/main': 'feat/x' });
});

test('a base jj cannot resolve shows its error', async () => {
  const h = panel('/r/main', (cmd, args) => args.includes('@:: | ((nope).. & first_ancestors(@)) | heads(::@ & ::(nope))') ? fail('Error: Revision `nope` doesn\'t exist') : BOOKMARKS(cmd, args));
  await shown(h);
  click(h, 'changes-base');
  await h.drain();
  h.inputs[1].emit('change', 'nope');
  pick(h, 'enter');
  await h.drain();
  assert.ok(words(h.render()).includes('Error: Revision `nope` doesn\'t exist'));
});

test('Refresh snapshots and an operation rereads the stack without one', async () => {
  const h = panel();
  await shown(h);
  h.calls.length = 0;
  click(h, 'changes-refresh');
  await h.drain();
  assert.deepEqual(plain(h.calls.filter(c => c.cmd === 'jj').map(c => c.args[0] === 'util' ? 'snapshot' : c.args[1])), ['snapshot', 'log']);
  h.calls.length = 0;
  await h.fire('/r/main/.jj/repo/op_heads/heads');
  assert.equal(h.calls.some(isSnap), false);
  assert.equal(h.calls.filter(isStack).length, 1);
});

test('a hidden panel starts nothing and snapshots once when shown again', async () => {
  const h = panel('/r/main', () => undefined, { layout: panelLayout(false, 'files') });
  await shown(h);
  assert.equal(h.calls.some(c => isSnap(c) || isStack(c)), false);
  await h.fire('/r/main/.jj/repo/op_heads/heads');
  assert.equal(h.calls.some(c => isSnap(c) || isStack(c)), false);
  h.state.layout = panelLayout();
  await h.advance(1000);
  assert.equal(h.calls.filter(isSnap).length, 1);
  assert.equal(h.calls.filter(isStack).length, 1);
  h.state.layout = panelLayout(true);
  await h.advance(1000);
  h.state.layout = panelLayout();
  await h.advance(1000);
  assert.equal(h.calls.filter(isSnap).length, 2);
});

test('click selects one change and Shift-click adds a second for a FROM and TO pair', async () => {
  const h = panel();
  await shown(h);
  click(h, 'stack-c2');
  await h.drain();
  assert.deepEqual(plain(h.calls.filter(isLog).at(-1).args.slice(0, 5)), ['--ignore-working-copy', 'log', '--no-graph', '-r', 'c2']);
  assert.ok(words(h.render()).includes('b.txt'));
  click(h, 'stack-c3', true);
  await h.drain();
  const pair = h.calls.filter(c => c.cmd === 'jj' && c.args.includes('diff')).at(-1);
  assert.deepEqual(plain(pair.args.slice(0, 6)), ['--ignore-working-copy', 'diff', '--from', 'c3', '--to', 'c2']);
  assert.deepEqual(words(byId(h.render(), 'stack-c3')).slice(0, 1), ['FROM']);
  assert.deepEqual(words(byId(h.render(), 'stack-c2')).slice(0, 1), ['TO']);
  click(h, 'stack-c1');
  await h.drain();
  assert.equal(words(h.render()).includes('FROM'), false);
});

test('a refresh that finds a selected change rewritten says so and selects @', async () => {
  const h = panel();
  await shown(h);
  click(h, 'stack-c2');
  await h.drain();
  h.setStack([PANEL_STACK[0], { ...PANEL_STACK[1], commit: 'c2b' }, PANEL_STACK[2]]);
  await h.fire('/r/main/.jj/repo/op_heads/heads');
  const text = words(h.render());
  assert.ok(text.includes('Selected change was rewritten'));
  assert.ok(text.includes('a.js'));
  assert.equal(h.view.sel[0].commit, 'c1');
});

test('@ stays selected as snapshots rewrite it', async () => {
  const h = panel();
  await shown(h);
  h.setStack([{ ...PANEL_STACK[0], commit: 'c1b' }, ...PANEL_STACK.slice(1)]);
  click(h, 'changes-refresh');
  await h.drain();
  assert.equal(words(h.render()).includes('Selected change was rewritten'), false);
  assert.equal(h.view.sel[0].commit, 'c1b');
});

const hunk = (cmd) => cmd === 'hunk' ? ok('hunk 0.25.0\n') : undefined;
const SPLIT = ['env', 'RANDORI_DIFF=1', 'sh', '-c', 'cd "$0" && exec "$@"', '/r/main'];

test('clicking a file opens the whole change in Hunk, split right of the focused pane in the checkout', async () => {
  const h = panel('/r/main', hunk);
  await shown(h);
  click(h, 'change-src/a.js');
  await h.drain();
  assert.deepEqual(runs(h, 'pane.split'), [{ direction: 'right', argv: [...SPLIT, 'hunk', 'show', 'aaaaaa'] }]);
  assert.equal(h.calls.filter(c => c.cmd === 'jj').some(c => c.args.includes('--git')), false);
});

test('Open diff opens a FROM and TO pair whole, asking once whether Hunk runs', async () => {
  const h = panel('/r/main', hunk);
  await shown(h);
  click(h, 'stack-c2');
  await h.drain();
  click(h, 'stack-c3', true);
  await h.drain();
  click(h, 'changes-open');
  await h.drain();
  click(h, 'changes-open');
  await h.drain();
  assert.deepEqual(runs(h, 'pane.split').map(a => a.argv.slice(SPLIT.length)), [
    ['hunk', 'diff', 'cccccc', 'bbbbbb'], ['hunk', 'diff', 'cccccc', 'bbbbbb']]);
  assert.equal(h.calls.filter(c => c.cmd === 'hunk').length, 1);
});

test('without Hunk a diff opens in jj diff, paged by less that waits for q', async () => {
  const h = panel();
  await shown(h);
  click(h, 'change-src/a.js');
  await h.drain();
  click(h, 'stack-c2');
  await h.drain();
  click(h, 'stack-c3', true);
  await h.drain();
  click(h, 'changes-open');
  await h.drain();
  assert.deepEqual(runs(h, 'pane.split').map(a => a.argv.slice(SPLIT.length)), [
    ['jj', '--config', 'ui.pager=less -R', 'diff', '-r', 'aaaaaa', '--', 'root-file:"src/a.js"'],
    ['jj', '--config', 'ui.pager=less -R', 'diff', '--from', 'cccccc', '--to', 'bbbbbb']]);
});

// A panel in tab tb whose tab, or `diffTab`, has diff pane p2 running terminal t9 with pid 42.
function diffPanel(answers, diffTab = 'tb') {
  return panel('/r/main', answers, {
    panes: [{ pane: 'p1', tab: 'tb', terminal: 't1', cwd: '/r/main' }, { pane: 'p2', tab: diffTab, terminal: 't9', cwd: '/r/main' }],
    focused: { space: 's1', tab: 'tb', pane: 'p1' },
    terminals: [{ address: 't1', argv: ['zsh'] }, { address: 't9', argv: [...SPLIT, 'hunk', 'show', 'x'] }],
    hc: async (args) => args.join(' ') === 'get t9 --json' ? ok('{"address":"t9","pid":42}') : { code: 1, stdout: '', stderr: 'no' },
  });
}
const sessions = (pid) => (cmd, args) => cmd !== 'hunk' ? undefined
  : args[1] === 'list' ? ok(JSON.stringify({ sessions: [{ sessionId: 'S1', pid }] })) : ok('');

const hunkSessionCalls = h => plain(h.calls.filter(c => c.cmd === 'hunk' && c.args[0] === 'session').map(c => c.args.slice(1).join(' ')));

test('a later click reloads the tab’s live Hunk pane with the selection, moves to the file and focuses it', async () => {
  const h = diffPanel(sessions(42));
  await shown(h);
  click(h, 'change-src/a.js');
  await h.drain();
  assert.deepEqual(runs(h, 'pane.split'), []);
  assert.deepEqual(runs(h, 'pane.focus'), [{ terminal: 't9' }]);
  assert.deepEqual(hunkSessionCalls(h), ['list --json', 'reload S1 --source /r/main -- show aaaaaa', 'navigate S1 --file src/a.js --hunk 1']);
});

test('a click in the commits the pane shows only moves to the file, and a rewritten change reloads', async () => {
  const h = diffPanel(sessions(42));
  await shown(h);
  click(h, 'change-src/a.js');
  await h.drain();
  h.calls.length = 0;
  click(h, 'change-src/a.js');
  await h.drain();
  click(h, 'changes-open');
  await h.drain();
  assert.deepEqual(hunkSessionCalls(h), ['list --json', 'navigate S1 --file src/a.js --hunk 1', 'list --json']);
  h.setStack([{ ...PANEL_STACK[0], commit: 'c1b' }, ...PANEL_STACK.slice(1)]);
  click(h, 'changes-refresh');
  await h.drain();
  h.calls.length = 0;
  click(h, 'changes-open');
  await h.drain();
  assert.deepEqual(hunkSessionCalls(h), ['list --json', 'reload S1 --source /r/main -- show aaaaaa']);
});

test('a diff pane whose Hunk window is not found is replaced in place', async () => {
  const h = diffPanel(sessions(7));
  await shown(h);
  click(h, 'change-src/a.js');
  await h.drain();
  assert.equal(h.calls.some(c => c.cmd === 'hunk' && c.args[1] === 'reload'), false);
  assert.deepEqual(h.actions.filter(a => a.name !== 'pane.focus').map(a => [a.name, a.args.pane ?? a.args.terminal]), [['pane.split', 'p2'], ['terminal.kill', 't9']]);
});

test('without Hunk a later click replaces the diff pane, and a diff pane in another tab is left alone', async () => {
  let h = diffPanel(() => undefined);
  await shown(h);
  click(h, 'change-src/a.js');
  await h.drain();
  assert.deepEqual(h.actions.map(a => [a.name, a.args.pane ?? a.args.terminal]), [['pane.split', 'p2'], ['terminal.kill', 't9']]);
  h = diffPanel(sessions(42), 'other');
  await shown(h);
  click(h, 'change-src/a.js');
  await h.drain();
  assert.deepEqual(h.actions.map(a => [a.name, a.args.pane ?? a.args.terminal]), [['pane.split', undefined]]);
  assert.equal(h.calls.some(c => c.cmd === 'hunk' && c.args[0] === 'session'), false);
});

test('a failed read shows its error above the last good data', async () => {
  let failing = false;
  const h = panel('/r/main', (cmd, args) => failing && args.includes('snapshot') ? fail('Error: The working copy is stale') : undefined);
  await shown(h);
  failing = true;
  click(h, 'changes-refresh');
  await h.drain();
  const text = words(h.render());
  assert.ok(text.includes('Error: The working copy is stale'));
  assert.ok(text.includes('two'));
});

// The edits the panel runs, in the order they ran, without the reads.
const edits = h => h.calls.filter(c => c.cmd === 'jj' && ['new', 'squash', 'describe', 'edit', 'abandon'].includes(c.args[0])).map(c => c.args);
const parentLog = (desc) => (cmd, args) => args.includes('log') && args.some(a => /^c\d-$/.test(a)) ? ok(`${JSON.stringify(desc)}\n`) : undefined;

test('+ runs jj new, and a row\u2019s hidden + and \u2193 insert a change after it and squash it, then the stack rereads', async () => {
  const h = panel('/r/main', parentLog('one\n'));
  await shown(h);
  const reads = h.calls.filter(isStack).length;
  click(h, 'changes-new'); await h.drain();
  click(h, 'stack-c2-new'); await h.drain();
  click(h, 'stack-c2-squash'); await h.drain();
  assert.deepEqual(plain(edits(h)), [['new'], ['new', '--insert-after', 'c2'], ['squash', '-r', 'c2', '-m', 'one\n\ntwo']]);
  assert.ok(h.calls.filter(isStack).length > reads, 'the stack rereads');
  assert.ok(byId(h.render(), 'stack-c2-squash'), 'c2 can squash into c3');
  assert.equal(byId(h.render(), 'stack-c3-squash'), undefined, 'c3 would squash into the base');
  assert.equal(byId(h.render(), 'stack-c4-new'), undefined, 'the base row has no buttons');
  assert.ok(byId(h.render(), 'stack-c2-new')?.calls.invisible || nodes(h.render()).some(n => n.calls.invisible), 'row buttons hide until hovered');
  byId(h.render(), 'stack-c2').handlers.on_hover(true, h.cx);
  const shownButtons = nodes(byId(h.render(), 'stack-c2')).filter(n => n.calls.invisible);
  assert.equal(shownButtons.length, 0, 'hovering a row shows its buttons');
});

test('squash passes no message when one of the two descriptions is empty, and a failed edit shows jj\u2019s error', async () => {
  const h = panel('/r/main', (cmd, args) => parentLog('')(cmd, args) ?? (args[0] === 'abandon' ? fail('Error: Commit c3 is immutable') : undefined));
  await shown(h);
  click(h, 'stack-c2-squash'); await h.drain();
  assert.deepEqual(plain(edits(h)), [['squash', '-r', 'c2']]);
  byId(h.render(), 'stack-menu-c3').handlers.on_open_change(true, h.cx);
  const abandon = nodes(h.render()).find(n => /^stack-menu-c3-\d+$/.test(n.calls.id?.[0] ?? '') && words(n).includes('Abandon'));
  abandon.handlers.on_click({}, h.cx); await h.drain();
  assert.ok(words(h.render()).includes('Error: Commit c3 is immutable'));
});

test('double-clicking a description edits all of it in place: Enter saves, Shift+Enter does not, Escape cancels', async () => {
  const h = panel('/r/main');
  await shown(h);
  const area = h.inputs.find(i => i.set_auto_grow);
  const dbl = id => nodes(byId(h.render(), id)).find(n => words(n).length === 1 && n.handlers['on_mouse_down:left'])?.handlers['on_mouse_down:left']({ click_count: 2 }, h.cx);
  dbl('stack-c4');
  assert.equal(h.view.describing, null, 'the base is not described');
  dbl('stack-c2');
  assert.equal(area.value(), 'two');
  assert.ok(area.focused);
  area.emit('submit', 'two\nmore', { shift: true });
  assert.deepEqual(plain(edits(h)), []);
  area.emit('submit', 'two\n\nbody');
  await h.drain();
  assert.deepEqual(plain(edits(h)), [['describe', '-r', 'c2', '-m', 'two\n\nbody']]);
  dbl('stack-c3');
  nodes(byId(h.render(), 'stack-c3')).find(n => n.handlers.on_key_down).handlers.on_key_down({ key: 'escape' }, h.cx);
  assert.equal(h.view.describing, null);
  assert.equal(edits(h).length, 1);
});

test('right-click opens a row\u2019s menu: @ has no Edit, the base only copies its ID', async () => {
  const h = panel('/r/main');
  await shown(h);
  const menu = c => { byId(h.render(), `stack-menu-${c}`).handlers.on_open_change(true, h.cx); return nodes(h.render()).filter(n => n.calls.id?.[0]?.match(new RegExp(`^stack-menu-${c}-\\d+$`))); };
  const labels = c => menu(c).map(n => words(n)[0]);
  assert.deepEqual(labels('c1'), ['Describe', 'New change after', 'Squash into parent', 'Abandon', 'Copy change ID']);
  assert.deepEqual(labels('c3'), ['Describe', 'New change after', 'Edit', 'Abandon', 'Copy change ID']);
  assert.deepEqual(labels('c4'), ['Copy change ID']);
  menu('c2').find(n => words(n)[0] === 'Copy change ID').handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.clipboard), ['bbbbbb']);
  assert.equal(h.view.menuFor, null);
  menu('c2').find(n => words(n)[0] === 'Edit').handlers.on_click({}, h.cx); await h.drain();
  assert.deepEqual(plain(edits(h)), [['edit', 'c2']]);
});
