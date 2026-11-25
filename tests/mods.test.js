import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
async function settle(h) { h.render(); await h.drain(); h.render(); await h.drain(); }
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
  h.render();
  await h.drain();
  h.state.panes[1].status = 'idle';
  h.render();
  await h.drain();
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
  h.render();
  await h.drain();
  h.state.panes[0].status = 'idle';
  h.render();
  await h.drain();
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

test('a space you are not on ends with a filled mark when its agents need you and a hollow one while they work', async () => {
  for (const layout of [sidebar(), sidebar({ size: { px: 100 } })]) {
    const h = spacesWith([['s1', '/g'], ['s2', '/g'], ['s3', '/g'], ['s4', '/g'], ['s5', '/g']], world(), { layout });
    const status = { s1: 'working', s2: 'blocked', s3: 'done', s4: 'working', s5: 'idle' };
    h.state.spaces = h.state.spaces.map(s => ({ ...s, status: status[s.id], active: s.id === 's4' }));
    await settle(h);
    const marks = id => row(h, id).filter(w => w === '\u25cf' || w === '\u25cb');
    assert.deepEqual(marks('s1'), ['\u25cb']);
    assert.deepEqual(marks('s2'), ['\u25cf']);
    assert.deepEqual(marks('s3'), ['\u25cf']);
    assert.deepEqual(marks('s4'), [], 'the shown space has no mark');
    assert.deepEqual(marks('s5'), []);
  }
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

function dialog(action, over = () => undefined, data = {}) {
  const w = world((cmd, args, opts) => {
    const answer = over(cmd, args, opts);
    if (answer !== undefined) return answer;
    if (cmd === 'jj' && args.includes('workspace') && args.includes('list')) {
      const main = opts.cwd === '/o' ? '/o' : '/r/main';
      return ok(JSON.stringify({ name: 'default', root: main }) + '\n');
    }
    if (cmd === 'jj' && args.includes('bookmark') && args.includes('list')) return ok('');
  });
  const modName = action === 'finish' ? 'jj-finish' : 'jj-workspace';
  const h = load(modName, { spaces: [space('s1', '/r/main'), space('s2', '/r/w1')], panes: [pane('s1', '/r/main'), pane('s2', '/r/w1')],
    props: action === 'finish' ? { space: 's1', overlay: 'o1' } : { space: 's1', folder: '/r/main', overlay: 'o1' }, exec: w.exec, readTextFile: w.readTextFile, ...data });
  h.calls = w.calls;
  return h;
}
const line = c => [c.cmd, ...c.args].join(' ');
const runs = (h, name) => plain(h.actions.filter(a => a.name === name).map(a => a.args));

// ---- Overlay manifest & harness fidelity ----

test('jj-workspace and jj-finish mod.json declare valid overlay specs', () => {
  const ws = JSON.parse(readFileSync(new URL('../mods/jj-workspace/mod.json', import.meta.url), 'utf8'));
  const fin = JSON.parse(readFileSync(new URL('../mods/jj-finish/mod.json', import.meta.url), 'utf8'));
  assert.deepEqual(ws.overlay, { kind: 'dialog', width: 560, height: 480 });
  assert.deepEqual(fin.overlay, { kind: 'window', width: 520, height: 360 });
});

// ---- jj-workspace (Flat Search + Repo Chip) ----

test('Workspace creates a new workspace on matching bookmark, runs one link/mise sh script, and opens a space', async () => {
  const h = dialog('new', (cmd, args) => {
    if (cmd === 'jj' && args.includes('bookmark')) return ok('feat/x\nmain\n');
    if (cmd === 'jj' && args.includes('add')) return ok('');
    if (cmd === 'mkdir') return ok('');
    if (cmd === 'sh' && args[0] === '-c' && args[2] === 'sh' && args[3] === '/home/u/wt/main/feat-x') return ok('');
  }, { layout: sidebar({}, { directory: '~/wt/{repo}/{name}', links: ['.env', 'mise.toml', 'missing'] }) });
  await h.drain();
  // On open, bookmark list has NOT run yet (lazy create-time check).
  assert.equal(h.calls.some(c => c.cmd === 'jj' && c.args.includes('bookmark')), false);

  h.inputs[0].emit('change', 'feat/x');
  const tree = h.render();
  assert.ok(words(tree).some(w => w.includes('Create "feat/x"')));
  assert.ok(words(tree).some(w => w.includes('~/wt/main/feat-x')));

  h.inputs[0].emit('submit');
  await h.drain();

  const lines = h.calls.map(line);
  assert.ok(lines.includes('mkdir -p /home/u/wt/main'));
  assert.ok(lines.includes('jj workspace add --name=feat/x -r feat/x -- /home/u/wt/main/feat-x'));
  // Single sh -c invocation carries dest, miseTrust flag, and all link tuples.
  const linkCall = h.calls.find(c => c.cmd === 'sh' && c.args[3] === '/home/u/wt/main/feat-x');
  assert.ok(linkCall);
  assert.equal(linkCall.args[4], '1');
  assert.ok(linkCall.args.includes('/r/main/.env'));
  assert.ok(linkCall.args.includes('/r/main/mise.toml'));
  assert.equal(h.notifications.length, 0);
  assert.deepEqual(plain(h.actions.at(-1)), { name: 'space.new', args: { name: 'feat/x', folder: '/home/u/wt/main/feat-x' } });
  assert.deepEqual(plain(h.overlays.at(-1)), { close: 'o1' });
});

test('Workspace fails inline when create-time bookmark lookup errors instead of starting from the wrong revision', async () => {
  const h = dialog('new', (cmd, args) => {
    if (cmd === 'jj' && args.includes('bookmark')) return fail('jj bookmark broken');
    if (cmd === 'jj' && args.includes('add')) throw new Error('must not add when bookmark read fails');
  });
  await h.drain();
  h.inputs[0].emit('change', 'topic');
  h.render();
  h.inputs[0].emit('submit');
  await h.drain();
  assert.equal(h.actions.length, 0);
  assert.ok(words(h.render()).some(w => w.includes('jj bookmark broken')));
});

test('Workspace notifies warning when link/mise script fails, and runs from main even when opened in a linked checkout', async () => {
  const h = dialog('new', (cmd, args) => {
    if (cmd === 'jj' && args.includes('bookmark')) return ok('');
    if (cmd === 'jj' && args.includes('add')) return ok('');
    if (cmd === 'mkdir') return ok('');
    if (cmd === 'sh' && args[3] === '/home/u/.herdr/worktrees/main/topic') return fail('ln: permission denied');
  }, {
    spaces: [space('s2', '/r/w1')],
    panes: [pane('s2', '/r/w1')],
    props: { space: 's2', folder: '/r/w1', overlay: 'o1' },
    layout: sidebar({}, { links: ['.env'], miseTrust: false }),
  });
  await h.drain();
  h.inputs[0].emit('change', 'topic');
  h.render();
  h.inputs[0].emit('submit');
  await h.drain();
  const addCall = h.calls.find(c => c.cmd === 'jj' && c.args.includes('add'));
  assert.equal(addCall.cwd, '/r/main');
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].level, 'warning');
  assert.match(h.notifications[0].body, /permission denied/);
});

test('Workspace switches to an already-open workspace (selecting its tab) and opens closed workspaces in a new space', async () => {
  const h = dialog('open', (cmd, args) => {
    if (cmd === 'jj' && args.includes('workspace') && args.includes('list')) {
      return ok(
        JSON.stringify({ name: 'default', root: '/r/main' }) + '\n' +
        JSON.stringify({ name: 'w1', root: '/r/w1' }) + '\n' +
        JSON.stringify({ name: 'closed', root: '/r/closed' }) + '\n',
      );
    }
  }, {
    spaces: [
      space('s1', '/r/main'),
      { id: 's2', name: 'w1', folder: '/r/w1', machine: null, active: false, tabs: [{ id: 'tab-a', active: true }, { id: 'tab-b', active: false }] },
    ],
    panes: [
      pane('s1', '/r/main'),
      { pane: 'p-a', tab: 'tab-a', terminal: 't-a', cwd: '/other' },
      { pane: 'p-b', tab: 'tab-b', terminal: 't-b', cwd: '/r/w1' },
    ],
  });
  await h.drain();
  h.inputs[0].emit('change', 'w1');
  h.render();
  h.inputs[0].emit('submit');
  assert.deepEqual(plain(h.actions), [
    { name: 'space.select', args: { id: 's2' } },
    { name: 'tab.select', args: { id: 'tab-b' } },
  ]);

  // Closed workspace opens in a new space (with argv forwarding).
  const h2 = dialog('open', (cmd, args) => {
    if (cmd === 'jj' && args.includes('workspace') && args.includes('list')) {
      return ok(
        JSON.stringify({ name: 'default', root: '/r/main' }) + '\n' +
        JSON.stringify({ name: 'closed', root: '/r/closed' }) + '\n',
      );
    }
  }, { props: { space: 's1', folder: '/r/main', overlay: 'o2', argv: ['pi'] } });
  await h2.drain();
  h2.inputs[0].emit('change', 'closed');
  h2.render();
  h2.inputs[0].emit('submit');
  assert.deepEqual(plain(h2.actions), [
    { name: 'space.new', args: { name: 'closed', folder: '/r/closed', argv: ['pi'] } },
  ]);
});

test('Workspace supports Flat Search cross-repo lookup, Option 1 disk folding, Repo Chip entry/lazy-load, and Backspace pop', async () => {
  const loadedDisk = [];
  const h = dialog('open', (cmd, args, opts) => {
    if (cmd === 'jj' && args.includes('root')) {
      if (opts.cwd === '/r/main') return ok('/r/main\n');
      if (opts.cwd === '/other/streams') return ok('/other/streams\n');
      return fail('There is no jj repo');
    }
    if (cmd === 'jj' && args.includes('workspace') && args.includes('list')) {
      if (opts.cwd === '/r/main') {
        return ok(JSON.stringify({ name: 'default', root: '/r/main' }) + '\n');
      }
      if (opts.cwd === '/other/streams') {
        return ok(
          JSON.stringify({ name: 'default', root: '/other/streams' }) + '\n' +
          JSON.stringify({ name: 'cli-by-entity', root: '/wt/streams/cli-by-entity' }) + '\n',
        );
      }
      if (opts.cwd === '/home/u/.dotfiles') {
        loadedDisk.push(opts.cwd);
        return ok(
          JSON.stringify({ name: 'default', root: '/home/u/.dotfiles' }) + '\n' +
          JSON.stringify({ name: 'macos', root: '/wt/dotfiles/macos' }) + '\n',
        );
      }
    }
    if (cmd === 'sh' && args[0] === '-c' && args[1].includes('mtime_of')) {
      return ok('/home/u/.dotfiles\t\t500\n');
    }
  }, {
    spaces: [
      { ...space('s1', '/r/main'), active: true, index: 0 },
      { ...space('s2', '/other/streams'), active: false, index: 1 },
    ],
    panes: [pane('s1', '/r/main'), pane('s2', '/other/streams')],
    readTextFile: async (p) => (p.endsWith('/.jj/repo/store/type') ? 'local' : null),
    shared: { 'space.colors': { s1: 'ansi3', s2: 'ansi6' } },
    layout: sidebar({}, { repos: ['~/.dotfiles'] }),
  });
  await h.drain();

  // Disk repo was NOT queried for workspaces upfront, is folded on empty query, and uses jj's `default` name.
  assert.deepEqual(loadedDisk, []);
  const emptyWords = words(h.render());
  assert.ok(emptyWords.some(w => w.includes('Type to search 1 other repository')));
  assert.ok(emptyWords.includes('default'));
  assert.ok(emptyWords.includes('main'));

  // Cross-repo workspace search finds streams/cli-by-entity directly.
  h.inputs[0].emit('change', 'cli-by');
  const crossTree = h.render();
  assert.ok(words(crossTree).includes('cli-by-entity'));
  assert.ok(words(crossTree).some(w => w.includes('streams /')));

  // Searching "dot" lazily loads .dotfiles workspaces AND puts `+ New workspace in .dotfiles…` FIRST (selected on Enter!).
  h.inputs[0].emit('change', 'dot');
  await h.drain();
  assert.deepEqual(loadedDisk, ['/home/u/.dotfiles']);
  const dotTree = h.render();
  assert.ok(words(dotTree).includes('macos'));
  assert.ok(words(dotTree).some(w => w.includes('New workspace in .dotfiles')));

  // Pressing Enter on the default-selected `+ New workspace in .dotfiles…` locks the Repo Chip!
  h.inputs[0].emit('submit');
  const scopedTree = h.render();
  assert.ok(byId(scopedTree, 'wt-repo-chip'));
  assert.ok(words(scopedTree).includes('macos'));

  // Typing "a" and deleting it to "" does NOT pop the Repo Chip (vm.query was "a").
  h.inputs[0].emit('change', 'a');
  const aTree = h.render();
  h.inputs[0].emit('change', '');
  h.keyDown(aTree, 'backspace');
  assert.ok(byId(h.render(), 'wt-repo-chip'));

  // Now vm.query IS "" — pressing Backspace pops the Repo Chip back to Flat Search!
  const emptyScopedTree = h.render();
  h.keyDown(emptyScopedTree, 'backspace');
  assert.equal(byId(h.render(), 'wt-repo-chip'), undefined);

  // Typing bare `/` on empty input unconditionally locks the highlighted repo (`main`) into a chip!
  h.render();
  h.inputs[0].emit('change', '/');
  const bareSlashTree = h.render();
  assert.ok(byId(bareSlashTree, 'wt-repo-chip'));
  assert.ok(words(byId(bareSlashTree, 'wt-repo-chip')).includes('main'));
  assert.equal(h.inputs[0].value(), '');
  // Inside a Repo Chip, `/` is completely literal (`feat/auth` creates `"feat/auth"` in `main`).
  h.inputs[0].emit('change', 'feat/auth');
  const literalInChip = h.render();
  assert.ok(byId(literalInChip, 'wt-repo-chip'));
  assert.ok(words(literalInChip).some(w => w.includes('Create "feat/auth"')));
  h.inputs[0].emit('change', '');
  h.keyDown(h.render(), 'backspace');
  assert.equal(byId(h.render(), 'wt-repo-chip'), undefined);

  // Typing partial substring `strea` selects `+ New workspace in streams…` FIRST, and typing `/` locks `[streams ×]`!
  h.inputs[0].emit('change', 'strea');
  const streaTree = h.render();
  assert.equal(h.view.vm.current.kind, 'create');
  assert.equal(h.view.vm.current.name, '');
  assert.equal(h.view.vm.current.repo.name, 'streams');
  h.inputs[0].emit('change', 'strea/');
  const slashScoped = h.render();
  assert.ok(byId(slashScoped, 'wt-repo-chip'));
  assert.ok(words(byId(slashScoped, 'wt-repo-chip')).includes('streams'));
  assert.equal(h.inputs[0].value(), '');
  h.keyDown(slashScoped, 'backspace');
});

test('Workspace openIn: tab + cross-machine Shift+Enter refusal + Escape blocked while creating + host close() safety', async () => {
  let finishAdd;
  const h = dialog('open', (cmd, args, opts) => {
    if (cmd === 'jj' && args.includes('root')) {
      if (opts.cwd === '/r/main') return ok('/r/main\n');
      if (opts.cwd === '/rem/app' && opts.on === 'retriever') return ok('/rem/app\n');
      return fail('There is no jj repo');
    }
    if (cmd === 'jj' && args.includes('workspace') && args.includes('list')) {
      if (opts.cwd === '/r/main') return ok(JSON.stringify({ name: 'default', root: '/r/main' }) + '\n');
      if (opts.cwd === '/rem/app') return ok(JSON.stringify({ name: 'default', root: '/rem/app' }) + '\n' + JSON.stringify({ name: 'feat', root: '/rem/wt/feat' }) + '\n');
    }
    if (cmd === 'jj' && args.includes('bookmark')) return ok('');
    if (cmd === 'mkdir') return ok('');
    if (cmd === 'jj' && args.includes('add')) return new Promise(r => { finishAdd = () => r(ok('')); });
    if (cmd === 'sh' && args[1]?.includes('$HOME')) return ok('/home/rem\n');
    if (cmd === 'sh' && args[1]?.includes('mtime_of')) return ok('');
    if (cmd === 'sh') return ok('');
  }, {
    spaces: [
      { ...space('s1', '/r/main'), active: true, machine: null, index: 0 },
      { ...space('s2', '/rem/app'), active: false, machine: 'retriever', index: 1 },
    ],
    panes: [pane('s1', '/r/main'), pane('s2', '/rem/app')],
    readTextFile: async (p) => (p.endsWith('/.jj/repo/store/type') ? 'local' : null),
    layout: sidebar({}, { openIn: 'tab' }),
  });
  await h.drain();

  // Remote other-space repo gets remote $HOME cached and shows its host badge.
  assert.equal(h.view.model.homes.get('retriever'), '/home/rem');
  h.inputs[0].emit('change', 'feat');
  const remTree = h.render();
  assert.ok(words(remTree).includes('feat'));
  assert.ok(words(remTree).includes('retriever'));
  // Shift+Enter on cross-machine workspace refuses tab placement even under openIn: "tab"!
  h.inputs[0].emit('submit', undefined, { modifiers: { shift: true } });
  assert.equal(h.actions.length, 0);
  assert.ok(words(h.render()).some(w => w.includes('Cannot open a tab')));

  // Start creating in local repo; while busy, Escape stops propagation and does NOT close dialog!
  h.inputs[0].emit('change', 'new-local');
  const createTree = h.render();
  h.inputs[0].emit('submit');
  await h.drain();
  assert.equal(h.view.busy, true);
  const stopped = h.keyDown(createTree, 'escape');
  assert.equal(stopped, true);
  assert.equal(h.closed, false);

  // If host forcibly closes the overlay mid-add, completing add does NOT call space.new or throw stale cx.notify()!
  h.closeHost();
  finishAdd();
  await h.drain();
  assert.equal(h.actions.length, 0);
});

test('Workspace spawns nothing during checking()', async () => {
  const h = dialog('open', () => { throw new Error('must not exec during checking()'); }, { checking: true });
  assert.equal(h.tasks.length, 0);
  h.render();
});

// ---- jj-finish (Choose-One, Machine-Scoped, Honest Child Handling) ----

function finishFixture(extra = {}, handler = null) {
  const w = world((cmd, args, opts) => {
    const custom = handler?.(cmd, args, opts);
    if (custom !== undefined) return custom;
    if (cmd === 'jj' && args.includes('workspace') && args.includes('list')) {
      return ok(
        JSON.stringify({ name: 'default', root: '/r/main' }) + '\n' +
        JSON.stringify({ name: 'w1', root: '/r/w1' }) + '\n' +
        JSON.stringify({ name: 'w2', root: '/r/w2' }) + '\n',
      );
    }
    if (cmd === 'jj' && args[0] === 'status') return ok('');
    if (cmd === 'jj' && args[0] === 'workspace' && args[1] === 'remove') return ok('');
  });
  const spaces = extra.spaces ?? [
    { id: 's1', name: 'w1', machine: null, folder: '/r/w1', active: true, tabs: [{ id: 'tab1', name: 'w1', active: true }] },
  ];
  const panes = extra.panes ?? [
    { pane: 'p1', tab: 'tab1', terminal: 't1', cwd: '/r/w1' },
  ];
  const terminals = extra.terminals ?? [
    { address: 't1', state: 'live', cwd: '/r/w1', name: 'zsh' },
  ];
  const h = load('jj-finish', {
    spaces,
    panes,
    terminals,
    props: { space: 's1', overlay: 'fin1', ...(extra.props ?? {}) },
    exec: w.exec,
    readTextFile: extra.readTextFile ?? w.readTextFile,
    reactive: extra.reactive ?? true,
    checking: extra.checking,
  });
  h.calls = w.calls;
  return h;
}

test('Finish single linked workspace confirms without checkboxes, passes `--` to remove, waits via poll, and closes space', async () => {
  const h = finishFixture();
  await h.drain();
  const tree = h.render();
  assert.equal(byId(tree, 'finish-row-0'), undefined);
  assert.ok(words(tree).some(w => w.includes('Ends 1 terminal')));
  assert.ok(words(tree).some(w => w.includes('t1')));

  h.keyDown(tree, 'enter');
  await h.drain();
  assert.deepEqual(plain(h.actions), [{ name: 'terminal.kill', args: { terminal: 't1' } }]);

  // Escape is blocked while running!
  assert.equal(h.view.busy, true);
  assert.equal(h.keyDown(h.render(), 'escape'), true);
  assert.equal(h.closed, false);

  // Terminal exits -> bounded poll detects exit, removes with `--`, closes space, and dismisses.
  h.state.terminals = [];
  await h.advance(100);
  const rm = h.calls.find(c => c.cmd === 'jj' && c.args[0] === 'workspace' && c.args[1] === 'remove');
  assert.deepEqual(plain(rm.args), ['workspace', 'remove', '--', 'w1']);
  assert.ok(h.actions.some(a => a.name === 'space.close' && a.args.id === 's1' && a.args.confirmed === true));
  assert.equal(h.closed, true);
});

test('Finish choose-one with multiple linked workspaces lets ↑↓ pick one and finishes ONLY that checkout', async () => {
  const h = finishFixture({
    spaces: [{ id: 's1', name: 'work', machine: null, folder: '/r/w1', active: true, tabs: [{ id: 'tab1', name: 'w1', active: true }, { id: 'tab2', name: 'w2', active: false }] }],
    panes: [
      { pane: 'p1', tab: 'tab1', terminal: 't1', cwd: '/r/w1' },
      { pane: 'p2', tab: 'tab2', terminal: 't2', cwd: '/r/w2' },
    ],
    terminals: [
      { address: 't1', state: 'live', cwd: '/r/w1', name: 'zsh' },
      { address: 't2', state: 'live', cwd: '/r/w2', name: 'zsh' },
    ],
  });
  await h.drain();
  const tree1 = h.render();
  assert.ok(byId(tree1, 'finish-row-0'));
  assert.ok(byId(tree1, 'finish-row-1'));
  // Active tab (w1) is selected by default; press down to pick w2!
  h.keyDown(tree1, 'down');
  const tree2 = h.render();
  assert.ok(words(tree2).some(w => w.includes('t2')));
  assert.equal(words(tree2).some(w => w.includes('t1')), false);

  h.keyDown(tree2, 'enter');
  await h.drain();
  assert.deepEqual(plain(h.actions), [{ name: 'terminal.kill', args: { terminal: 't2' } }]);
  h.state.terminals = [{ address: 't1', state: 'live', cwd: '/r/w1', name: 'zsh' }];
  await h.advance(100);
  const rm = h.calls.find(c => c.cmd === 'jj' && c.args[1] === 'remove');
  assert.deepEqual(plain(rm.args), ['workspace', 'remove', '--', 'w2']);
  // Only p2 is closed (space stays open because p1 is still in w1).
  assert.ok(h.actions.some(a => a.name === 'pane.close' && a.args.pane === 'p2'));
  assert.equal(h.actions.some(a => a.name === 'space.close'), false);
});

test('Finish never kills or previews remote terminals on another machine with the same path, and never stalls on spared children', async () => {
  const h = finishFixture({
    spaces: [
      { id: 's1', name: 'w1', machine: null, folder: '/r/w1', active: true, tabs: [{ id: 'tab1', active: true }, { id: 'tab-kept', active: false }] },
      { id: 's-rem', name: 'w1', machine: 'retriever', folder: '/r/w1', active: false, tabs: [{ id: 'tab-rem', active: true }] },
    ],
    panes: [
      { pane: 'p1', tab: 'tab1', terminal: 't1', cwd: '/r/w1' },
      { pane: 'p-kept', tab: 'tab-kept', terminal: 't-kept', cwd: '/outside' },
      { pane: 'p-rem', tab: 'tab-rem', terminal: 'retriever/t1', cwd: '/r/w1' },
    ],
    terminals: [
      { address: 't1', state: 'live', cwd: '/r/w1', name: 'pi' },
      { address: 't-kept', state: 'live', cwd: '/outside', parent: 't1', name: 'kept-sub' },
      { address: 't-outlive', state: 'live', cwd: '/outside', parent: 't1', name: 'bg-outlive' },
      { address: 'retriever/t1', state: 'live', cwd: '/r/w1', name: 'remote-shell' },
    ],
  });
  await h.drain();
  const tree = h.render();
  // Remote terminal is NEVER shown or killed.
  assert.equal(words(tree).some(w => w.includes('retriever/t1')), false);
  // Dependent hidden child outside /r/w1 is disclosed transparently.
  assert.ok(words(tree).some(w => w.includes('t-outlive')));

  h.keyDown(tree, 'enter');
  await h.drain();
  assert.deepEqual(plain(h.actions), [{ name: 'terminal.kill', args: { terminal: 't1' } }]);

  // Only t1 exits; t-kept and t-outlive stay alive -> Finish completes without stalling!
  h.state.terminals = h.state.terminals.filter(t => t.address !== 't1');
  await h.advance(100);
  assert.ok(h.calls.some(c => c.cmd === 'jj' && c.args[1] === 'remove' && c.args[3] === 'w1'));
  assert.equal(h.closed, true);
});

test('Finish non-drift error (jj status lock) NEVER absorbs newly spawned terminals into acknowledged', async () => {
  let failStatus = true;
  const h = finishFixture({}, (cmd, args) => {
    if (cmd === 'jj' && args[0] === 'status' && failStatus) {
      // Simulate a new terminal appearing while jj status fails on lock!
      h.state.terminals.push({ address: 't-new', state: 'live', cwd: '/r/w1', name: 'intruder' });
      return fail('working copy locked');
    }
  });
  await h.drain();
  h.keyDown(h.render(), 'enter');
  await h.drain();
  assert.match(h.view.error, /working copy locked/);
  assert.equal(h.actions.length, 0);

  // Retrying MUST refuse on drift for t-new (it was NOT absorbed by catch)!
  failStatus = false;
  h.keyDown(h.render(), 'enter');
  await h.drain();
  assert.match(h.view.error, /t-new/);
  assert.equal(h.actions.length, 0);

  // Pressing Enter a second time after seeing t-new proceeds to kill BOTH t1 and t-new.
  h.keyDown(h.render(), 'enter');
  await h.drain();
  assert.deepEqual(
    h.actions.filter(a => a.name === 'terminal.kill').map(a => a.args.terminal).sort(),
    ['t-new', 't1'],
  );
});

test('Finish fails closed on missing space/tab, refuses unrecorded pre-0.38 roots, and aborts cleanly on host close()', async () => {
  // Missing explicit spaceId fails closed.
  const hMissing = finishFixture({ props: { space: 's-gone', overlay: 'fin2' } });
  await hMissing.drain();
  assert.equal(hMissing.view.phase, 'error');
  assert.match(hMissing.view.error, /space is no longer open/i);

  // Pre-0.38 jj returning empty root for linked workspace is refused (never guesses path).
  const hLegacy = finishFixture({}, (cmd, args) => {
    if (cmd === 'jj' && args.includes('workspace') && args.includes('list')) {
      return ok(JSON.stringify({ name: 'default', root: '' }) + '\n' + JSON.stringify({ name: 'w1', root: '' }) + '\n');
    }
  });
  await hLegacy.drain();
  assert.equal(hLegacy.view.phase, 'error');
  assert.match(hLegacy.view.error, /recorded path/i);

  // Host closing the window mid-jj-status aborts before terminal.kill and never throws stale cx.notify().
  let releaseStatus;
  const hClose = finishFixture({}, (cmd, args) => {
    if (cmd === 'jj' && args[0] === 'status') return new Promise(r => { releaseStatus = () => r(ok('')); });
  });
  await hClose.drain();
  hClose.keyDown(hClose.render(), 'enter');
  await hClose.drain();
  hClose.closeHost();
  releaseStatus();
  await hClose.drain();
  assert.equal(hClose.actions.length, 0);
});

test('Finish runs pane cleanup even when all terminals already exited before removal', async () => {
  const h = finishFixture({ terminals: [] });
  await h.drain();
  h.keyDown(h.render(), 'enter');
  await h.drain();
  assert.equal(h.actions.some(a => a.name === 'terminal.kill'), false);
  assert.ok(h.actions.some(a => a.name === 'space.close' && a.args.id === 's1'));
});

// ---- jj-menu & jj-new-menu ----

test('jj-menu uses keyed selection across async splice, shows mod.open:jj-workspace shortcut, omits folder on space click, and keys jj-finish', async () => {
  let resolveId;
  const w = world((cmd, args) => {
    if (cmd === 'jj' && args.includes('root')) return new Promise(r => { resolveId = () => r(ok('/r/w1\n')); });
  });
  const h = load('jj-menu', {
    spaces: [space('s1', '/r/w1')],
    panes: [pane('s1', '/r/w1')],
    keys: [{ section: 'global', action: 'mod.open:jj-workspace', keys: 'cmd-shift-n' }],
    props: { tab: 'space', target: { id: 's1' }, overlay: 'm1' },
    exec: w.exec,
    readTextFile: w.readTextFile,
  });

  // Start the spawned probe (blocked on resolveId), then arrow down onto "Close".
  await h.drain();
  const initial = h.render();
  h.keyDown(initial, 'down');
  assert.equal(h.view.selectedKey, 'close');

  // Async jj probe finishes and splices "jj workspace…" and "Finish jj workspace" ABOVE "Close".
  resolveId();
  await h.drain();
  const after = h.render();
  // Highlight stays on "Close"!
  assert.equal(h.view.selectedKey, 'close');
  assert.ok(words(byId(after, 'mi-jj-workspace')).includes('cmd-shift-n'));

  // Clicking "jj workspace…" passes { space: 's1' } (without overriding folder with tab 1).
  byId(after, 'mi-jj-workspace').handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.overlays.at(-1)), { mod: 'jj-workspace', kind: 'dialog', width: 560, height: 480, props: { space: 's1' } });

  // Clicking "Finish jj workspace" opens a keyed singleton window.
  const h2 = load('jj-menu', {
    spaces: [space('s1', '/r/w1')],
    panes: [pane('s1', '/r/w1')],
    props: { tab: 'space', target: { id: 's1' }, overlay: 'm2' },
    exec: world().exec,
    readTextFile: world().readTextFile,
  });
  await h2.drain();
  byId(h2.render(), 'mi-jj-finish').handlers.on_click({}, h2.cx);
  assert.deepEqual(plain(h2.overlays.at(-1)), { mod: 'jj-finish', kind: 'window', key: 'jj-finish', width: 520, height: 360, props: { space: 's1' } });
});

test('a tab right-click menu offers Finish jj workspace only for linked tabs, and non-jj space keeps shipped menu', async () => {
  const w = world();
  const h = load('jj-menu', {
    spaces: [{ id: 's1', name: 'w1', machine: 'retriever', folder: '/r/w1', tabs: [{ id: 'k1' }, { id: 'k2' }] }],
    panes: [{ pane: 'p1', tab: 'k1', terminal: 'retriever/t1', cwd: '/r/w1' }, { pane: 'p2', tab: 'k2', terminal: 'retriever/t2', cwd: '/r/main' }],
    props: { tab: 'tab', target: { id: 'k1', space: 's1' }, overlay: 'm1' },
    exec: w.exec,
    readTextFile: w.readTextFile,
  });
  await h.drain();
  assert.ok(byId(h.render(), 'mi-jj-finish'));
  byId(h.render(), 'mi-jj-finish').handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.overlays.at(-1)), { mod: 'jj-finish', kind: 'window', key: 'jj-finish', width: 520, height: 360, props: { space: 's1', tab: 'k1' } });

  const hMain = load('jj-menu', {
    spaces: [space('s1', '/r/main')],
    panes: [pane('s1', '/r/main')],
    props: { tab: 'tab', target: { id: 's1-t', space: 's1' }, overlay: 'm2' },
    exec: w.exec,
    readTextFile: w.readTextFile,
  });
  await hMain.drain();
  assert.equal(byId(hMain.render(), 'mi-jj-finish'), undefined);

  const hGit = load('jj-menu', {
    spaces: [space('s1', '/g')],
    panes: [pane('s1', '/g')],
    props: { tab: 'space', target: { id: 's1' }, overlay: 'm3' },
    exec: w.exec,
    readTextFile: w.readTextFile,
  });
  await hGit.drain();
  assert.equal(byId(hGit.render(), 'mi-jj-workspace'), undefined);
});

test('the New menu opens jj-workspace at 560x480 with shortcut hint, uses space-scoped focus, and keeps Git worktree at 460x280', async () => {
  const w = world((cmd, args, opts) => (cmd === 'jj' && args.includes('root') && opts.cwd === '/bad' ? fail('Error: bad toml') : undefined));
  const h = load('jj-new-menu', {
    spaces: [{ ...space('s1', '/r/main'), active: true, tabs: [{ id: 'k1' }, { id: 'k2' }] }],
    panes: [{ pane: 'p1', tab: 'k1', terminal: 't1', cwd: '/bad', focused: true }, { pane: 'p2', tab: 'k2', terminal: 't2', cwd: '/r/main' }],
    focused: { space: 's1', tab: 'k1', pane: 'p1', cwd: '/bad' },
    keys: [{ section: 'global', action: 'mod.open:jj-workspace', keys: 'cmd-shift-n' }],
    props: { overlay: 'o1' },
    exec: w.exec,
    readTextFile: w.readTextFile,
  });
  await h.drain();
  assert.ok(words(h.render()).includes('jj workspace\u2026'));
  assert.equal(byId(h.render(), 'worktree-open'), undefined);
  assert.ok(words(byId(h.render(), 'worktree')).includes('\u21e7\u2318N'));
  byId(h.render(), 'worktree').handlers.on_click({}, h.cx);
  assert.deepEqual(plain(h.overlays.at(-1)), { mod: 'jj-workspace', kind: 'dialog', width: 560, height: 480, props: { space: 's1' } });

  // Non-jj space preserves Git worktree at 460x280.
  const h3 = load('jj-new-menu', {
    spaces: [{ ...space('s1', '/g'), active: true }],
    panes: [{ ...pane('s1', '/g'), focused: true }],
    focused: { space: 's1', tab: 's1-t', pane: 's1-p', cwd: '/g' },
    props: { overlay: 'o1' },
    exec: w.exec,
    readTextFile: w.readTextFile,
  });
  await h3.drain();
  assert.ok(words(h3.render()).includes('New worktree\u2026'));
  byId(h3.render(), 'worktree').handlers.on_click({}, h3.cx);
  assert.deepEqual(plain(h3.overlays.at(-1)), { mod: 'worktree', kind: 'dialog', width: 460, height: 280, props: { space: 's1', folder: '/g', action: 'new' } });
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

test('a hidden panel starts nothing and snapshots once when shown again (without a polling timer)', async () => {
  const h = panel('/r/main', () => undefined, { layout: panelLayout(false, 'files') });
  await shown(h);
  assert.equal(h.calls.some(c => isSnap(c) || isStack(c)), false);
  await h.fire('/r/main/.jj/repo/op_heads/heads');
  assert.equal(h.calls.some(c => isSnap(c) || isStack(c)), false);
  // Showing the panel triggers checkShown via render() immediately (no timer).
  h.state.layout = panelLayout();
  h.render();
  await h.drain();
  assert.equal(h.calls.filter(isSnap).length, 1);
  assert.equal(h.calls.filter(isStack).length, 1);
  // Even when Herdr skips render() while hidden, jj-tabs bumping jj-changes:opened
  // triggers a fresh snapshot on re-open.
  h.shared.set('jj-changes:opened', 1);
  h.render();
  await h.drain();
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
