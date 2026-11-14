// Native trial of CUJs 1 to 6 in an owned temporary app home, core session
// and repository. Every app and core command uses that HOME, XDG folders and
// HC_SESSION. Never point this at an existing app home.
//
//   node scripts/app-trial.js prepare     make /tmp/hjj-*, install the mods and layout
//   node scripts/app-trial.js run         run the app (blocks; start it with hc run --bg)
//   node scripts/app-trial.js resources   switch layout, make the repository and its space
//   node scripts/app-trial.js new         New workspace "topic" through jj-workspace
//   node scripts/app-trial.js edit        edit a file in topic and run jj status there
//   node scripts/app-trial.js open        show the Open workspace dialog
//   node scripts/app-trial.js panel       add two changes in project and show the changes panel
//   node scripts/app-trial.js pair        select the oldest two changes as a FROM and TO pair
//   node scripts/app-trial.js verify-panel  check what the panel read
//   node scripts/app-trial.js diff [file]  open the pair's diff of a file ("third (x).txt") from the panel
//   node scripts/app-trial.js verify-diff [file]  check the diff pane's command and screen, and that a second file reused it
//   node scripts/app-trial.js quit-diff   press q in Hunk and check that its pane closes
//   node scripts/app-trial.js finish-setup  edit topic, add workspaces review, nesting and locked with their spaces
//   node scripts/app-trial.js finish <space> [names]  Finish workspace from that space, checking only names if given
//   node scripts/app-trial.js lock | unlock  hold or release jj's working-copy lock on locked
//   node scripts/app-trial.js again       press Enter again in the open Finish dialog
//   node scripts/app-trial.js verify-finish <space>  record what Finish did
//   node scripts/app-trial.js shot <png>  save the window's last frame
//   node scripts/app-trial.js verify      check spaces, nesting and workspaces
//   node scripts/app-trial.js quit | stop-core | status
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const record = path.resolve('.tmp/app-trial.json');
const command = process.argv[2];
const run = (program, args, env, cwd) => execFileSync(program, args, { env, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

if (command === 'prepare') {
  await fs.mkdir(path.dirname(record), { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp('/tmp/hjj-'));
  const app = path.join(root, 'a');
  for (const dir of ['a/mods', 'a/layouts', 'h', 'c/herdr-core', 'k', 'd', 'r']) await fs.mkdir(path.join(root, dir), { recursive: true, mode: 0o700 });
  const core = await fs.realpath(run('which', ['hc'], process.env).trim());
  const binary = await fs.realpath(run('which', ['herdr-app'], process.env).trim());
  await fs.writeFile(path.join(root, 'owned-by-herdr-jj-trial'), process.cwd());
  await fs.writeFile(record, JSON.stringify({ root, core, binary }));
  await fs.writeFile(path.join(root, 'c/herdr-core/config.toml'), 'shell = ["/bin/sh"]\n');
  // The first-run welcome would cover the screenshots.
  await fs.writeFile(path.join(app, 'shared.json'), JSON.stringify({ 'frame.welcomed': 'skipped' }));
  await fs.writeFile(path.join(app, 'settings.json'), JSON.stringify({ core, telemetry: false, sounds: { enabled: false } }));
  for (const name of await fs.readdir('mods')) await fs.cp(path.join('mods', name), path.join(app, 'mods', name), { recursive: true });
  // The panel block mounts trial-changes, jj-changes with the trial's selection.
  const layout = await fs.readFile('layouts/jj-tui.json', 'utf8');
  assert.ok(layout.includes('"mod": "jj-changes"'));
  await fs.writeFile(path.join(app, 'layouts/jj-tui.json'), layout.replace('"mod": "jj-changes"', '"mod": "trial-changes"'));
  await fs.copyFile('layouts/jj-tui.svg', path.join(app, 'layouts/jj-tui.svg'));
  // trial-launcher opens the dialog request.json names. trial-new is
  // jj-workspace with the name typed in and Enter pressed, so no key
  // automation touches the display.
  const fixtures = {
    'trial-launcher': `import { View, div } from 'gpui-kit';
import { openOverlay, closeOverlay, props, appHome, readTextFile } from 'herdr';
export default class TrialLauncher extends View {
  init(_p, cx) {
    const own = props()?.overlay;
    if (!own) return;
    cx.spawn(async () => {
      const r = JSON.parse(await readTextFile(appHome() + '/request.json'));
      const size = r.action === 'open' ? { width: 560, height: 480 } : r.action === 'finish' ? { width: 520, height: 360 } : { width: 460, height: 280 };
      const mod = r.action === 'new' ? 'trial-new' : r.action === 'finish' ? 'trial-finish' : 'jj-workspace';
      openOverlay({ mod, kind: r.action === 'finish' ? 'window' : 'dialog', ...size, props: { space: r.space, folder: r.folder, action: r.action } });
      closeOverlay(own);
    });
  }
  render() { return div(); }
}`,
    'trial-new': `import Workspace from './workspace.js';
import { appHome, readTextFile, writeTextFile } from 'herdr';
export default class TrialNew extends Workspace {
  init(p, cx) {
    super.init(p, cx);
    cx.spawn(async (cx) => {
      const r = JSON.parse(await readTextFile(appHome() + '/request.json'));
      while (this.repo === undefined) await new Promise((done) => cx.timer.after(100, done));
      this.text = r.name;
      await writeTextFile(appHome() + '/new-plan.json', JSON.stringify(this.repo ? this.planned() : { error: this.error }), null);
      await this.work(cx);
      if (this.error) await writeTextFile(appHome() + '/new-error.txt', this.error, null);
    });
  }
}`,
    // jj-workspace's Finish with the requested names checked and Enter
    // pressed. It records spaces, panes and terminals every 100 ms while it
    // works, and presses Enter again when finish-again.json counts higher.
    'trial-finish': `import Workspace from './workspace.js';
import { appHome, readTextFile, writeTextFile, spaces, panes, terminals } from 'herdr';
export default class TrialFinish extends Workspace {
  init(p, cx) {
    super.init(p, cx);
    this.timeline = [];
    this.runs = 0;
    cx.spawn(async (cx) => {
      while (this.repo === undefined) await new Promise((done) => cx.timer.after(100, done));
      const r = JSON.parse(await readTextFile(appHome() + '/request.json'));
      if (r.check) for (const w of this.rows) w.checked = r.check.includes(w.name);
      cx.notify();
      await this.save('opened');
      cx.timer.every(100, () => { if (this.busy) this.mark(); });
      cx.timer.every(500, (cx) => this.poll(cx));
      await this.attempt(cx);
    });
  }
  mark() {
    const now = { spaces: spaces().map((s) => s.name + ' ' + s.tabs.length), panes: panes().map((p) => p.pane + ' ' + p.terminal + ' ' + p.cwd), terminals: terminals().map((t) => t.address + ' ' + t.cwd) };
    const text = JSON.stringify(now);
    if (text !== this.last) this.timeline.push({ at: Date.now(), ...now });
    this.last = text;
  }
  async attempt(cx) {
    this.runs++;
    this.mark();
    await this.finish(cx);
    this.mark();
    await this.save('run ' + this.runs);
  }
  poll(cx) {
    if (this.busy || this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const again = Number((await readTextFile(appHome() + '/finish-again.json').catch(() => null)) ?? 0);
        if (again >= this.runs) await this.attempt(cx);
      } finally { this.polling = false; }
    });
  }
  save(label) {
    const state = { label, error: this.error ?? '', runs: this.runs, rows: this.rows.map((w) => ({ name: w.name, root: w.root, checked: w.checked, removed: w.removed, error: w.error })), timeline: this.timeline };
    const text = JSON.stringify(state);
    this.chain = (this.chain ?? Promise.resolve()).then(async () => { await writeTextFile(appHome() + '/finish-state.json', text, this.written ?? null); this.written = text; });
    return this.chain;
  }
  close() {
    this.save('closed').finally(() => super.close());
  }
}`,
    // jj-changes that selects a pair, then opens one file's diff, when
    // changes-request.json asks, and writes what it shows to
    // changes-state.json every half second.
    'trial-changes': `import Changes from './changes.js';
import { visible } from './jj.js';
import { appHome, readTextFile, writeTextFile, layout } from 'herdr';
export default class TrialChanges extends Changes {
  init(p, cx) {
    super.init(p, cx);
    cx.timer.every(500, (cx) => this.trial(cx));
  }
  // jj-changes looks for its own name in the layout.
  checkShown(cx) {
    const shown = visible(layout(), 'trial-changes');
    if (shown && !this.shown && this.mode === 'jj') { this.shown = true; this.request(3, cx); } // 3 is SNAPSHOT
    this.shown = shown;
  }
  trial(cx) {
    if (this.trialBusy) return;
    this.trialBusy = true;
    cx.spawn(async (cx) => {
      try {
        const r = JSON.parse((await readTextFile(appHome() + '/changes-request.json').catch(() => null)) ?? '{}');
        if (r.pair && !this.paired && this.stack.length >= 3 && !this.running) {
          this.paired = true;
          this.select(this.stack[2], false, cx);
          this.select(this.stack[1], true, cx);
        }
        if (r.open && this.paired && this.opened !== r.open && this.files.length) { this.opened = r.open; this.openDiff(r.open, cx); }
        const state = { mode: this.mode, shown: this.shown, root: this.ck?.root ?? null, updated: this.updated ?? null, error: this.error ?? null,
          stack: this.stack.map((c) => ({ description: c.description, at: c.at, added: c.added, removed: c.removed })),
          selected: this.sel.map((c) => c.description), files: this.files, running: Boolean(this.running) };
        const text = JSON.stringify(state);
        await writeTextFile(appHome() + '/changes-state.json', text, this.written ?? null);
        this.written = text;
      } finally { this.trialBusy = false; }
    });
  }
}`,
  };
  for (const [name, source] of Object.entries(fixtures)) {
    await fs.mkdir(path.join(app, 'mods', name));
    await fs.writeFile(path.join(app, 'mods', name, 'main.js'), source);
    await fs.writeFile(path.join(app, 'mods', name, 'mod.json'), '{"place":"none"}');
  }
  await fs.copyFile('mods/jj-workspace/main.js', path.join(app, 'mods/trial-new/workspace.js'));
  await fs.copyFile('mods/jj-workspace/jj.js', path.join(app, 'mods/trial-new/jj.js'));
  await fs.copyFile('mods/jj-workspace/main.js', path.join(app, 'mods/trial-finish/workspace.js'));
  await fs.copyFile('mods/jj-workspace/jj.js', path.join(app, 'mods/trial-finish/jj.js'));
  await fs.copyFile('mods/jj-changes/main.js', path.join(app, 'mods/trial-changes/changes.js'));
  await fs.copyFile('mods/jj-changes/jj.js', path.join(app, 'mods/trial-changes/jj.js'));
  console.log(JSON.stringify({ root, app, record }));
  process.exit(0);
}

const config = JSON.parse(await fs.readFile(record, 'utf8'));
const root = await fs.realpath(config.root);
assert.ok(root.startsWith('/private/tmp/hjj-') || root.startsWith('/tmp/hjj-'));
assert.equal(await fs.readFile(path.join(root, 'owned-by-herdr-jj-trial'), 'utf8'), process.cwd());
const app = path.join(root, 'a');
const home = path.join(root, 'h');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('HC_') || ['ZDOTDIR', 'ENV', 'BASH_ENV', 'HISTFILE'].includes(key)) delete env[key];
Object.assign(env, { HOME: home, HERDR_APP_HOME: app, HC_SESSION: 'trial',
  XDG_CONFIG_HOME: path.join(root, 'c'), XDG_CACHE_HOME: path.join(root, 'k'), XDG_DATA_HOME: path.join(root, 'd'), XDG_RUNTIME_DIR: path.join(root, 'r'),
  SHELL: '/bin/sh', HERDR_TELEMETRY: '0' });
const execute = (program, args, cwd = root) => run(program, args, env, cwd);
const appCommand = (name, args) => JSON.parse(execute(config.binary, ['do', name, JSON.stringify(args ?? {})]));
const main = path.join(root, 'project');
const topic = path.join(home, '.herdr/worktrees/project/topic');
const workspace = (name) => path.join(home, '.herdr/worktrees/project', name);
const spaceOn = (folder) => JSON.parse(execute(config.binary, ['ls'])).spaces.find((s) => s.folder === folder).id;
const resources = () => fs.readFile(path.join(root, 'resources.json'), 'utf8').then(JSON.parse);
async function request(value) {
  if (value.action === 'new') for (const name of ['new-plan.json', 'new-error.txt']) await fs.rm(path.join(app, name), { force: true });
  if (value.action === 'finish') for (const name of ['finish-state.json', 'finish-again.json']) await fs.rm(path.join(app, name), { force: true });
  await fs.writeFile(path.join(app, 'request.json'), JSON.stringify(value));
  console.log(appCommand('mod.open', { name: 'trial-launcher' }));
}

if (command === 'run') {
  // Blocking here is intentional: hc owns this process and its native app child.
  execFileSync(config.binary, [], { env, cwd: root, stdio: 'inherit' });
} else if (command === 'status') {
  console.log(execute(config.binary, ['status']));
} else if (command === 'resources') {
  appCommand('layout.switch', { name: 'jj-tui' });
  execute('jj', ['git', 'init', '--quiet', main]);
  for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['signing.behavior', 'drop']]) execute('jj', ['config', 'set', '--repo', key, value], main);
  await fs.writeFile(path.join(main, 'file'), 'one\ntwo\n');
  execute('jj', ['commit', '--quiet', '-m', 'first'], main);
  execute('jj', ['bookmark', 'create', '--quiet', 'master', '-r', '@-'], main);
  const space = appCommand('space.new', { name: 'project', folder: main, argv: ['python3', '-c', 'import signal; signal.pause()'] });
  await fs.writeFile(path.join(root, 'resources.json'), JSON.stringify({ space }));
  console.log(JSON.stringify({ main, space }));
} else if (command === 'new') {
  const { space } = await resources();
  await request({ action: 'new', name: 'topic', space: space.space, folder: main });
} else if (command === 'open') {
  const { space } = await resources();
  await request({ action: 'open', space: space.space, folder: main });
} else if (command === 'edit') {
  await fs.writeFile(path.join(topic, 'file'), 'one\n2\nthree\n');
  await fs.writeFile(path.join(topic, 'added'), 'new\n');
  // jj status snapshots and records an operation, which the op_heads watch sees.
  console.log(execute('jj', ['status'], topic));
} else if (command === 'shot') {
  console.log(execute(config.binary, ['shot', path.resolve(process.argv[3] ?? '.tmp/stage1-trial.png')]));
} else if (command === 'verify') {
  const { space } = await resources();
  const plan = JSON.parse(await fs.readFile(path.join(app, 'new-plan.json'), 'utf8'));
  assert.equal(plan.path, topic);
  const spaces = JSON.parse(execute(config.binary, ['ls'])).spaces;
  const at = spaces.findIndex((s) => s.id === space.space);
  const made = spaces.findIndex((s) => s.folder === topic);
  assert.ok(made >= 0, `a space on ${topic}`);
  assert.equal(made, at + 1, 'the new workspace space sits right after its main checkout');
  const list = execute('jj', ['--ignore-working-copy', 'workspace', 'list', '-T', 'name ++ " " ++ root ++ "\\n"'], main);
  assert.match(list, new RegExp(`^topic ${topic}$`, 'm'));
  const status = JSON.parse(execute(config.binary, ['status']));
  const evidence = { spaces: spaces.map((s) => ({ name: s.name, folder: s.folder })), workspaces: list.trim().split('\n'), plan, status,
    limitation: 'Status text and the Open list are read from screenshots. Remote machines and Linux are not covered.' };
  await fs.writeFile(path.resolve('.tmp/stage1-trial.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} else if (command === 'panel') {
  const { space } = await resources();
  execute('jj', ['config', 'set', '--repo', 'revset-aliases."trunk()"', 'master'], main);
  await fs.writeFile(path.join(main, 'second'), 'a\nb\n');
  execute('jj', ['commit', '--quiet', '-m', 'second'], main);
  await fs.writeFile(path.join(main, 'second'), 'a\nB\nc\n');
  await fs.writeFile(path.join(main, 'third (x).txt'), 't\n');
  execute('jj', ['commit', '--quiet', '-m', 'third'], main);
  // Unsnapshotted edits in @, which showing the panel snapshots.
  await fs.writeFile(path.join(main, 'file'), 'one\ntwo\nthree\n');
  await fs.rm(path.join(app, 'changes-request.json'), { force: true });
  appCommand('space.select', { id: space.space });
  appCommand('layout.select', { stack: 'panel-body', child: 'changes' });
  console.log(appCommand('layout.show', { id: 'panel' }));
} else if (command === 'pair') {
  await fs.writeFile(path.join(app, 'changes-request.json'), JSON.stringify({ pair: true }));
} else if (command === 'verify-panel') {
  const state = JSON.parse(await fs.readFile(path.join(app, 'changes-state.json'), 'utf8'));
  assert.equal(state.mode, 'jj');
  assert.equal(state.root, main);
  assert.equal(state.error, null);
  assert.deepEqual(state.stack.map((c) => c.description), ['', 'third', 'second']);
  assert.deepEqual(state.stack.map((c) => [c.added, c.removed]), [[1, 0], [3, 1], [2, 0]], 'the snapshot saw the edit in @');
  assert.deepEqual(state.selected, ['second', 'third'], 'FROM second, TO third');
  assert.deepEqual(state.files.map((f) => f.path).sort(), ['second', 'third (x).txt']);
  await fs.writeFile(path.resolve('.tmp/stage2-panel-trial.json'), JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state, null, 2));
} else if (command === 'diff') {
  await fs.writeFile(path.join(app, 'changes-request.json'), JSON.stringify({ pair: true, open: process.argv[3] ?? 'third (x).txt' }));
} else if (command === 'verify-diff') {
  // The project tab's diff pane shows the file; a second file reloads the same terminal.
  const file = process.argv[3] ?? 'third (x).txt';
  const { space } = await resources();
  const tab = JSON.parse(execute(config.binary, ['ls'])).spaces.find((s) => s.id === space.space).tabs.find((t) => t.active);
  // hc ls leaves out argv; hc get has it.
  const panes = tab.terminals.map((p) => JSON.parse(execute('hc', ['get', p.terminal])));
  const diffs = panes.filter((t) => t?.argv?.[1] === 'RANDORI_DIFF=1');
  assert.equal(diffs.length, 1, JSON.stringify(panes));
  // A reload can take seconds to draw. A narrow pane truncates the name.
  let screen = '';
  for (let i = 0; i < 20 && !screen.includes(file.slice(0, 9)); i++) {
    if (i) await new Promise((done) => setTimeout(done, 500));
    screen = execute('hc', ['read', diffs[0].address]);
  }
  assert.ok(screen.includes(file.slice(0, 9)), screen);
  const { address, argv, pid } = diffs[0];
  const evidence = { file, tab: tab.name, panes: tab.terminals.length, terminal: { address, argv, pid }, screen: screen.split('\n').filter((l) => l.trim()).slice(0, 12) };
  const trail = path.resolve('.tmp/diff-pane-trial.json');
  const earlier = file === 'third (x).txt' ? [] : JSON.parse(await fs.readFile(trail, 'utf8'));
  if (earlier.length) assert.equal(diffs[0].address, earlier[0].terminal.address, 'the second file reloads the same pane');
  await fs.writeFile(trail, JSON.stringify([...earlier, evidence], null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} else if (command === 'quit-diff') {
  // q in Hunk closes its pane: no shell takes over.
  const { space } = await resources();
  const tabOf = () => JSON.parse(execute(config.binary, ['ls'])).spaces.find((s) => s.id === space.space).tabs.find((t) => t.active);
  const address = JSON.parse(await fs.readFile(path.resolve('.tmp/diff-pane-trial.json'), 'utf8'))[0].terminal.address;
  execute('hc', ['keys', address, 'q']);
  await new Promise((done) => setTimeout(done, 2000));
  const left = tabOf().terminals.map((p) => p.terminal);
  assert.ok(!left.includes(address), JSON.stringify(left));
  console.log(JSON.stringify({ closed: address, left }));
} else if (command === 'finish-setup') {
  // CUJ 4: an edit jj tracks and an ignored file in topic, whose space gets a second terminal.
  await fs.writeFile(path.join(topic, '.gitignore'), 'build.log\n');
  await fs.writeFile(path.join(topic, 'kept'), 'kept\n');
  await fs.writeFile(path.join(topic, 'build.log'), 'gone\n');
  const ids = { topic: spaceOn(topic) };
  appCommand('tab.new', { space: ids.topic, folder: topic });
  // CUJ 5: space review has a tab in review and one in nesting, and space
  // nesting a terminal in nesting. CUJ 6: space locked.
  for (const name of ['review', 'nesting', 'locked']) {
    execute('jj', ['workspace', 'add', '--quiet', '--name', name, workspace(name)], main);
    ids[name] = appCommand('space.new', { folder: workspace(name) }).space;
  }
  appCommand('tab.new', { space: ids.review, folder: workspace('nesting') });
  await fs.writeFile(path.join(root, 'finish.json'), JSON.stringify(ids));
  console.log(JSON.stringify(ids));
} else if (command === 'finish') {
  const [name, ...check] = process.argv.slice(3);
  const ids = JSON.parse(await fs.readFile(path.join(root, 'finish.json'), 'utf8'));
  await request({ action: 'finish', space: ids[name], folder: name === 'topic' ? topic : workspace(name), ...(check.length ? { check } : {}) });
} else if (command === 'again') {
  const state = JSON.parse(await fs.readFile(path.join(app, 'finish-state.json'), 'utf8'));
  await fs.writeFile(path.join(app, 'finish-again.json'), String(state.runs));
} else if (command === 'lock') {
  // jj waits on this lock without limit; Finish's jj status gives up after 10 seconds.
  const child = spawn('python3', ['-c', 'import fcntl,sys,time\nf=open(sys.argv[1],"a+")\nfcntl.flock(f,fcntl.LOCK_EX)\ntime.sleep(600)',
    path.join(workspace('locked'), '.jj/working_copy/working_copy.lock')], { detached: true, stdio: 'ignore' });
  child.unref();
  await fs.writeFile(path.join(root, 'lock.pid'), String(child.pid));
} else if (command === 'unlock') {
  process.kill(Number(await fs.readFile(path.join(root, 'lock.pid'), 'utf8')));
  await fs.rm(path.join(root, 'lock.pid'));
} else if (command === 'verify-finish') {
  const name = process.argv[3];
  const state = JSON.parse(await fs.readFile(path.join(app, 'finish-state.json'), 'utf8'));
  const list = execute('jj', ['--ignore-working-copy', 'workspace', 'list', '-T', 'name ++ "\\n"'], main).trim().split('\n');
  const folders = Object.fromEntries(['topic', 'review', 'nesting', 'locked'].map((n) => [n, existsSync(n === 'topic' ? topic : workspace(n))]));
  const kept = execute('jj', ['--ignore-working-copy', 'log', '--no-graph', '-r', 'files("kept")', '-T', 'commit_id.short() ++ " " ++ description'], main).trim();
  const spaces = JSON.parse(execute(config.binary, ['ls'])).spaces.map((s) => ({ name: s.name, folder: s.folder, tabs: s.tabs.map((t) => t.terminals.map((x) => x.terminal)) }));
  const evidence = { name, state, workspaces: list, folders, kept, spaces };
  await fs.writeFile(path.resolve(`.tmp/stage2-finish-${name}.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, state: { ...state, timeline: state.timeline.length } }, null, 2));
} else if (command === 'quit') {
  console.log(appCommand('app.quit'));
} else if (command === 'stop-core') {
  // Only this fresh HOME and session is addressed; no default-session command runs.
  console.log(execute(config.core, ['server', 'stop', '--json']));
} else {
  throw new Error('Use prepare, run, status, resources, new, edit, open, panel, pair, verify-panel, diff, verify-diff, finish-setup, finish, lock, unlock, again, verify-finish, shot, verify, quit or stop-core');
}
