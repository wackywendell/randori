// Native trial of CUJs 1 and 2 in an owned temporary app home, core session
// and repository. Every app and core command uses that HOME, XDG folders and
// HC_SESSION. Never point this at an existing app home.
//
//   node scripts/app-trial.js prepare     make /tmp/hjj-*, install the mods and layout
//   node scripts/app-trial.js run         run the app (blocks; start it with hc run --bg)
//   node scripts/app-trial.js resources   switch layout, make the repository and its space
//   node scripts/app-trial.js new         New workspace "topic" through jj-workspace
//   node scripts/app-trial.js edit        edit a file in topic and run jj status there
//   node scripts/app-trial.js open        show the Open workspace dialog
//   node scripts/app-trial.js shot <png>  save the window's last frame
//   node scripts/app-trial.js verify      check spaces, nesting and workspaces
//   node scripts/app-trial.js quit | stop-core | status
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  await fs.writeFile(path.join(app, 'settings.json'), JSON.stringify({ core, telemetry: false, sounds: { enabled: false } }));
  for (const name of await fs.readdir('mods')) await fs.cp(path.join('mods', name), path.join(app, 'mods', name), { recursive: true });
  await fs.copyFile('layouts/jj-tui.json', path.join(app, 'layouts/jj-tui.json'));
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
      const size = r.action === 'open' ? { width: 560, height: 480 } : { width: 460, height: 280 };
      openOverlay({ mod: r.action === 'new' ? 'trial-new' : 'jj-workspace', kind: 'dialog', ...size, props: { space: r.space, folder: r.folder, action: r.action } });
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
  };
  for (const [name, source] of Object.entries(fixtures)) {
    await fs.mkdir(path.join(app, 'mods', name));
    await fs.writeFile(path.join(app, 'mods', name, 'main.js'), source);
    await fs.writeFile(path.join(app, 'mods', name, 'mod.json'), '{"place":"none"}');
  }
  await fs.copyFile('mods/jj-workspace/main.js', path.join(app, 'mods/trial-new/workspace.js'));
  await fs.copyFile('mods/jj-workspace/jj.js', path.join(app, 'mods/trial-new/jj.js'));
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
const resources = () => fs.readFile(path.join(root, 'resources.json'), 'utf8').then(JSON.parse);
async function request(value) {
  if (value.action === 'new') for (const name of ['new-plan.json', 'new-error.txt']) await fs.rm(path.join(app, name), { force: true });
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
} else if (command === 'quit') {
  console.log(appCommand('app.quit'));
} else if (command === 'stop-core') {
  // Only this fresh HOME and session is addressed; no default-session command runs.
  console.log(execute(config.core, ['server', 'stop', '--json']));
} else {
  throw new Error('Use prepare, run, status, resources, new, edit, open, shot, verify, quit or stop-core');
}
