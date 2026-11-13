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
  const layout = JSON.parse(readFileSync(new URL('../layouts/jj-tui.json', import.meta.url)));
  const blocks = [];
  const walk = node => { if (node.content?.mod) blocks.push(node.content); (node.children ?? []).forEach(walk); };
  walk(layout);
  const mods = blocks.map(b => b.mod);
  for (const m of ['jj-spaces', 'agents', 'jj-tabs', 'jj-changes']) assert.ok(mods.includes(m), m);
  assert.equal(mods.includes('changes'), false);
  assert.deepEqual(blocks.find(b => b.mod === 'jj-spaces').props, { directory: '~/.herdr/worktrees/{repo}/{name}', links: [], miseTrust: true });
});

test('jj-tabs offers the Files and Changes panels', () => {
  assert.match(readFileSync(new URL('../mods/jj-tabs/main.js', import.meta.url), 'utf8'), /const enabled = shared\("workspace.panels"\) \?\? \["files", "changes"\];/);
});

// The changes panel, shown in the panel stack beside Files.
const panelLayout = (hidden = false, active = 'changes') => ({ type: 'row', children: [{ id: 'panel', type: 'column', hidden, children: [
  { id: 'panel-body', type: 'stack', active, children: [{ id: 'files', type: 'block', content: { mod: 'files' } }, { id: 'changes', type: 'block', content: { mod: 'jj-changes' } }] }] }] });
const PANEL_STACK = [
  { commit: 'c1', change: 'aaaaaaaaaaaa', description: '', empty: false, conflict: false, at: true, added: 2, removed: 1,
    files: [{ path: 'src/a.js', status: 'M', added: 2, removed: 1 }] },
  { commit: 'c2', change: 'bbbbbbbbbbbb', description: 'two', empty: false, conflict: false, at: false, added: 1, removed: 0 },
  { commit: 'c3', change: 'cccccccccccc', description: 'one', empty: false, conflict: true, at: false, added: 4, removed: 0 },
];
const isSnap = c => c.cmd === 'jj' && c.args.join(' ') === 'util snapshot';
const isStack = c => isLog(c) && c.args.includes('@ | (trunk().. & first_ancestors(@))');
const isDiff = c => c.cmd === 'jj' && c.args.includes('--git');

// A panel focused on `cwd`. `answers(cmd, args)` answers first.
function panel(cwd = '/r/main', answers = () => undefined, data = {}) {
  let stack = PANEL_STACK;
  const w = world((cmd, args, opts) => {
    const answer = answers(cmd, args, opts);
    if (answer) return answer;
    if (cmd !== 'jj') return undefined;
    if (args.join(' ') === 'util snapshot') return ok('');
    if (args.includes('@ | (trunk().. & first_ancestors(@))')) return ok(stack.map(c => JSON.stringify({ ...c, files: c.files?.map(f => JSON.stringify(f)) })).join('\n') + '\n');
    if (args.includes('log')) return ok(JSON.stringify({ ...PANEL_STACK[1], files: [JSON.stringify({ path: 'b.txt', status: 'A', added: 1, removed: 0 })] }) + '\n');
    if (args.includes('--git')) return ok('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n+new\n');
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

test('showing the panel snapshots, reads the stack and opens the first file of @', async () => {
  const h = panel();
  await shown(h);
  const jjCalls = h.calls.filter(c => c.cmd === 'jj').map(c => c.args.slice(0, 2).join(' '));
  assert.deepEqual(plain(jjCalls), ['--ignore-working-copy workspace', 'util snapshot', '--ignore-working-copy log', '--ignore-working-copy diff']);
  assert.deepEqual(plain(h.calls.find(isDiff).args), ['--ignore-working-copy', 'diff', '--git', '-r', 'c1', '--', 'root-file:"src/a.js"']);
  assert.equal(h.calls.some(c => c.cmd === 'git'), false);
  assert.equal(h.timers.some(t => t.every === 10000), false);
  const text = words(h.render());
  for (const w of ['main', '@ aaaaaaaa', 'two', 'conflict', 'a.js', 'new', 'Refresh']) assert.ok(text.includes(w), `${w} in ${text}`);
  assert.ok(text.some(w => w.startsWith('updated ')));
});

test('Refresh snapshots and an operation rereads the stack without one', async () => {
  const h = panel();
  await shown(h);
  h.calls.length = 0;
  click(h, 'changes-refresh');
  await h.drain();
  assert.deepEqual(plain(h.calls.filter(c => c.cmd === 'jj').map(c => c.args[0] === 'util' ? 'snapshot' : c.args[1])), ['snapshot', 'log', 'diff']);
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
  const pair = h.calls.filter(c => c.cmd === 'jj' && c.args.includes('diff') && !c.args.includes('--git')).at(-1);
  assert.deepEqual(plain(pair.args.slice(0, 6)), ['--ignore-working-copy', 'diff', '--from', 'c3', '--to', 'c2']);
  assert.deepEqual(plain(h.calls.filter(isDiff).at(-1).args.slice(3, 7)), ['--from', 'c3', '--to', 'c2']);
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
  assert.equal(h.calls.filter(isDiff).at(-1).args[4], 'c1');
});

test('@ stays selected as snapshots rewrite it', async () => {
  const h = panel();
  await shown(h);
  h.setStack([{ ...PANEL_STACK[0], commit: 'c1b' }, ...PANEL_STACK.slice(1)]);
  click(h, 'changes-refresh');
  await h.drain();
  assert.equal(words(h.render()).includes('Selected change was rewritten'), false);
  assert.equal(h.calls.filter(isDiff).at(-1).args[4], 'c1b');
});

test('a long diff is cut short at 5,000 lines', async () => {
  const long = '@@ -0,0 +1,6000 @@\n' + Array.from({ length: 6000 }, (_, i) => `+${i}`).join('\n') + '\n';
  const h = panel('/r/main', (cmd, args) => args.includes('--git') ? ok(long) : undefined);
  await shown(h);
  assert.equal(h.view.rows.length, 5000);
  assert.ok(words(h.render()).includes('Diff cut short at 5,000 lines or 1 MiB'));
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
