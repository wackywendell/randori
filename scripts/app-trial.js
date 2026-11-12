// Manual native lifecycle trial. Every app/core command uses an owned temporary
// HOME, XDG directories and HC_SESSION. Never point this at an existing app home.
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
  for (const dir of ['a', 'h', 'c/herdr-core', 'k', 'd', 'r']) await fs.mkdir(path.join(root, dir), { recursive: true, mode: 0o700 });
  const core = await fs.realpath(run('which', ['hc'], process.env).trim());
  const binary = await fs.realpath(run('which', ['herdr-app'], process.env).trim());
  await fs.writeFile(path.join(root, 'owned-by-herdr-jj-trial'), process.cwd());
  await fs.writeFile(record, JSON.stringify({ root, core, binary }));
  await fs.writeFile(path.join(root, 'c/herdr-core/config.toml'), 'shell = ["/bin/sh"]\n');
  await fs.writeFile(path.join(app, 'settings.json'), JSON.stringify({ core, telemetry: false, sounds: { enabled: false } }));
  await fs.mkdir(path.join(app, 'mods'), { recursive: true });
  await fs.mkdir(path.join(app, 'layouts'));
  for (const name of await fs.readdir('mods')) await fs.cp(path.join('mods', name), path.join(app, 'mods', name), { recursive: true });
  const layout = JSON.parse(await fs.readFile('layouts/jj-tui.json', 'utf8'));
  layout.toast = 'trial-toast';
  await fs.writeFile(path.join(app, 'layouts/trial.json'), JSON.stringify(layout));
  const fixtureMods = {
    'trial-launcher': `import { View, div } from 'gpui-kit';
import { openOverlay, closeOverlay, props } from 'herdr';
export default class TrialLauncher extends View {
 init(){const own=props()?.overlay; if(!own)return; openOverlay({mod:'trial-workspace',kind:'dialog',modal:true,width:720,height:680}); closeOverlay(own);}
 render(){return div();}
}`,
    'trial-workspace': `import Workspace from './workspace.js';
import { appHome, readTextFile, writeTextFile } from 'herdr';
export default class TrialWorkspace extends Workspace {
 init(p,cx) {
  super.init(p,cx);
  cx.spawn(async cx=>{
   const request=JSON.parse(await readTextFile(appHome()+'/request.json'));
   this.action=request.action;
   try {
    this.repo=await this.ask(['probe'],request.root);
     this.workspace={name:request.name,root:request.root};
     this.scope={kind:'tab',id:request.tab,label:request.label,detail:'Only the disposable writer tab; its other thematic tab stays open'};
     this.plan=await this.ask(['remove-plan','--tab',request.tab],request.root);
     this.step='confirm'; cx.notify();
     await writeTextFile(appHome()+'/confirmation.json',JSON.stringify(this.plan),null);
     if(request.confirm)this.go(cx);
   } catch(error) { await writeTextFile(appHome()+'/trial-error.txt',String(error),null); }
  });
 }
 async close(cx) { super.close(); await writeTextFile(appHome()+'/view-closed.json',JSON.stringify({at:Date.now(),removing:this.busy&&this.step==='confirm'}),null); }
}`,
    'trial-toast': `import { View, div } from 'gpui-kit';
import { props, appHome, writeTextFile } from 'herdr';
export default class TrialToast extends View {
 init(_p,cx){const value=props()??{}; cx.spawn(async()=>{if(value.title?.startsWith('Workspace '))await writeTextFile(appHome()+'/result.json',JSON.stringify(value),null);});}
 render(){const value=props()??{}; return div().bg('#183028').text_color('#ffffff').p(12).child(value.title??'').child(value.body??'');}
}`,
  };
  for (const [name, source] of Object.entries(fixtureMods)) {
    await fs.mkdir(path.join(app, 'mods', name));
    await fs.writeFile(path.join(app, 'mods', name, 'main.js'), source);
    if (name === 'trial-workspace') await fs.copyFile('mods/jj-workspace/main.js', path.join(app, 'mods', name, 'workspace.js'));
    await fs.writeFile(path.join(app, 'mods', name, 'mod.json'), '{"place":"none"}');
  }
  console.log(JSON.stringify({ root, app, record }));
  process.exit(0);
}
const config = JSON.parse(await fs.readFile(record, 'utf8'));
const root = await fs.realpath(config.root);
assert.ok(root.startsWith('/private/tmp/hjj-') || root.startsWith('/tmp/hjj-'));
assert.equal(await fs.readFile(path.join(root, 'owned-by-herdr-jj-trial'), 'utf8'), process.cwd());
const app = path.join(root, 'a');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('HC_') || ['ZDOTDIR', 'ENV', 'BASH_ENV', 'HISTFILE'].includes(key)) delete env[key];
Object.assign(env, { HOME: path.join(root, 'h'), HERDR_APP_HOME: app, HC_SESSION: 'trial',
  XDG_CONFIG_HOME: path.join(root, 'c'), XDG_CACHE_HOME: path.join(root, 'k'), XDG_DATA_HOME: path.join(root, 'd'), XDG_RUNTIME_DIR: path.join(root, 'r'),
  SHELL: '/bin/sh', HERDR_TELEMETRY: '0', PATH: `${path.resolve('target/debug')}:${process.env.PATH}` });
const execute = (program, args, cwd = root) => run(program, args, env, cwd);
const appCommand = (name, args) => JSON.parse(execute(config.binary, ['do', name, JSON.stringify(args ?? {})]));
const helper = path.resolve('target/debug/herdr-jj');
if (command === 'run') {
  // Blocking here is intentional: hc owns this process and its native app child.
  execFileSync(config.binary, [], { env, cwd: root, stdio: 'inherit' });
} else if (command === 'status') {
  console.log(execute(config.binary, ['status']));
} else if (command === 'core-status') {
  console.log(execute(config.core, ['server', 'status', '--json']));
} else if (command === 'resources') {
  appCommand('layout.switch', { name: 'trial' });
  const main = path.join(root, 'project');
  execute('jj', ['git', 'init', '--colocate', main]);
  for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['signing.behavior', 'drop'], ['snapshot.auto-track', 'all()']]) execute('jj', ['config', 'set', '--repo', key, value], main);
  await fs.writeFile(path.join(main, 'file'), 'before\n');
  execute('jj', ['util', 'snapshot'], main);
  const writerSource = path.join(root, 'writer.py');
  await fs.writeFile(writerSource, `import signal, pathlib, sys\np=pathlib.Path(sys.argv[1])\ndef finish(*_):\n p.write_text('final edit before shutdown\\n')\n sys.exit(0)\nsignal.signal(signal.SIGHUP,finish)\nsignal.signal(signal.SIGTERM,finish)\np.write_text('writer running\\n')\nsignal.pause()\n`);
  const theme = appCommand('space.new', { name: 'Owned jj trial theme', folder: main, argv: ['python3', '-c', 'import signal; signal.pause()'] });
  const linked = JSON.parse(execute(helper, ['create', 'topic', '--revision', '@', '--cwd', main]));
  execute('jj', ['file', 'track', '--include-ignored', 'AGENTS.local.md', 'CLAUDE.local.md'], linked.root);
  execute('jj', ['util', 'snapshot'], linked.root);
  const writer = appCommand('tab.new', { name: 'Disposable writer', space: theme.space, folder: linked.root, argv: ['python3', writerSource, path.join(linked.root, 'file')] });
  const change = JSON.parse(execute(helper, ['inspect', '--cwd', linked.root])).change;
  await fs.writeFile(path.join(root, 'resources.json'), JSON.stringify({ main, linked: linked.root, theme, writer, change }));
  console.log(JSON.stringify({ main, linked: linked.root, theme, writer }));
} else if (command === 'request') {
  const resources = JSON.parse(await fs.readFile(path.join(root, 'resources.json'), 'utf8'));
  const request = { action: 'remove', root: resources.linked, name: 'topic',
    destination: resources.theme.space, tab: resources.writer.tab, label: 'Tab “Disposable writer” in “Owned jj trial theme”' };
  for (const name of ['confirmation.json', 'trial-error.txt', 'result.json', 'view-closed.json']) await fs.rm(path.join(app, name), { force: true });
  await fs.writeFile(path.join(app, 'request.json'), JSON.stringify(request));
  const status = JSON.parse(execute(config.binary, ['status']));
  assert.equal(status.overlays.includes('trial-workspace'), false, 'Close the existing trial dialog before starting another request');
  console.log(appCommand('mod.open', { name: 'trial-launcher' }));
} else if (command === 'confirm') {
  const request = JSON.parse(await fs.readFile(path.join(app, 'request.json'), 'utf8'));
  assert.equal(request.action, 'remove');
  request.confirm = true;
  for (const name of ['confirmation.json', 'trial-error.txt', 'result.json', 'view-closed.json']) await fs.rm(path.join(app, name), { force: true });
  await fs.writeFile(path.join(app, 'request.json'), JSON.stringify(request));
  // A fresh fixture view invokes the production handler without relying on
  // native shown-only command routing or pointer/key automation.
  await fs.appendFile(path.join(app, 'mods/trial-workspace/main.js'), `\n// Confirm owned fixture ${Date.now()}\n`);
  console.log({ confirmed: request.root });
} else if (command === 'shot') {
  console.log(execute(config.binary, ['shot', path.resolve(process.argv[3] ?? '.tmp/explicit-manager-trial.png')]));
} else if (command === 'verify') {
  const resources = JSON.parse(await fs.readFile(path.join(root, 'resources.json'), 'utf8'));
  const optional = async file => { try { return JSON.parse(await fs.readFile(path.join(app, file), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const toast = await optional('result.json');
  const closed = await optional('view-closed.json');
  assert.equal(toast?.title, 'Workspace removed', 'Removal completion notification must be recorded');
  assert.equal(closed?.removing, true, 'The removing dialog must finish its native close hook');
  await assert.rejects(fs.stat(resources.linked), { code: 'ENOENT' });
  const tabs = JSON.parse(execute(config.binary, ['ls'])).spaces.flatMap(s => s.tabs);
  assert.ok(tabs.some(t => t.id === resources.theme.tab));
  assert.equal(tabs.some(t => t.id === resources.writer.tab), false);
  const final = execute('jj', ['--ignore-working-copy', 'file', 'show', '-r', resources.change, 'file'], resources.main);
  assert.equal(final, 'final edit before shutdown\n');
  const status = JSON.parse(execute(config.binary, ['status']));
  assert.equal(status.overlays.includes('trial-workspace'), false);
  const evidence = { helperWorkflow: 'passed', initiatingOverlayRemovedFromModel: true, otherTabStillOpen: true, linkedDeleted: true, final,
    notificationRecorded: Boolean(toast), viewCloseHookRecorded: Boolean(closed),
    limitation: 'This verifies the removal lifecycle and notification delivery, not visual appearance. Capture and inspect the visible confirmation and result separately; interactive Create/Open and remote behavior remain unverified.' };
  await fs.writeFile(path.resolve('.tmp/native-trial-result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} else if (command === 'quit') {
  console.log(appCommand('app.quit'));
} else if (command === 'stop-core') {
  // Only this fresh HOME/session is addressed; no default-session command runs.
  console.log(execute(config.core, ['server', 'stop', '--json']));
} else {
  throw new Error('Use prepare, run, status, core-status, resources, request, confirm, shot, verify, quit or stop-core');
}
