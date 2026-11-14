// jj.js against real jj in disposable repositories under the system temp folder.
import './jj-config.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync as readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { identity, joinPath, readStatus, visible, errorWord } from '../mods/jj-spaces/jj.js';
import { readStack, readChange, readPair, filePattern, snapshot, STACK_LIMIT } from '../mods/jj-changes/jj.js';

// Herdr's exec: resolves { code, stdout, stderr }, rejects when the program cannot start.
export const exec = (cmd, args, { cwd, timeout } = {}) => new Promise((resolve, reject) => execFile(cmd, args, { cwd, timeout, encoding: 'utf8', maxBuffer: 8 << 20 },
  (error, stdout, stderr) => typeof error?.code === 'string' ? reject(error) : resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
const io = { exec, readTextFile: path => readFile(path, 'utf8') };
// Fixture commands skip Watchman; the reads under test run with the user's jj config and tests/jj-test.toml.
const jj = (cwd, ...args) => execFileSync('jj', ['--config', 'fsmonitor.backend=none', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A repository at <temp>/main with a linked workspace at <temp>/w1.
function fixture(t) {
  const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'herdr-jj-test-')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const main = path.join(temp, 'main');
  jj(temp, 'git', 'init', '--quiet', main);
  writeFileSync(path.join(main, 'a'), 'one\ntwo\n');
  jj(main, 'commit', '--quiet', '-m', 'first');
  jj(main, 'bookmark', 'create', '--quiet', 'master', '-r', '@-');
  jj(main, 'workspace', 'add', '--quiet', '--name', 'w1', path.join(temp, 'w1'));
  return { temp, main, w1: path.join(temp, 'w1') };
}

test('identity finds the main checkout and a linked workspace of one repository', async t => {
  const { temp, main, w1 } = fixture(t);
  assert.deepEqual(await identity(main, null, io), { jj: true, root: main, repo: `${main}/.jj/repo`, main, linked: false });
  assert.deepEqual(await identity(w1, null, io), { jj: true, root: w1, repo: `${main}/.jj/repo`, main, linked: true });
  assert.deepEqual(await identity(temp, null, io), { jj: false, final: true });
  assert.deepEqual(await identity(path.join(temp, 'nowhere'), null, io), { jj: false });
});

test('readStatus reports the nearest bookmark, its distance and the changes in @', async t => {
  const { main } = fixture(t);
  assert.deepEqual(await readStatus(main, null, false, io), { bookmark: 'master', distance: 1, empty: true, files: 0, added: 0, removed: 0 });
  writeFileSync(path.join(main, 'a'), 'one\n2\nthree\n');
  writeFileSync(path.join(main, 'b'), 'new\n');
  // Without a snapshot the edits are not seen yet.
  assert.equal((await readStatus(main, null, false, io)).empty, true);
  assert.deepEqual(await readStatus(main, null, true, io), { bookmark: 'master', distance: 1, empty: false, files: 2, added: 3, removed: 1 });
  jj(main, 'new', '--quiet');
  jj(main, 'new', '--quiet');
  assert.equal((await readStatus(main, null, false, io)).distance, 3);
});

test('a read without a snapshot records no operation', async t => {
  const { main } = fixture(t);
  const ops = () => jj(main, '--ignore-working-copy', 'op', 'log', '--no-graph', '-T', 'id ++ "\\n"').split('\n').length;
  const before = ops();
  writeFileSync(path.join(main, 'dirty'), 'x\n');
  await readStatus(main, null, false, io);
  assert.equal(ops(), before);
});

test('readStatus reports no bookmark, and the nearer of two bookmarked heads of a merge', async t => {
  const { main } = fixture(t);
  jj(main, 'bookmark', 'delete', '--quiet', 'master');
  assert.deepEqual(await readStatus(main, null, false, io), { bookmark: '', distance: 0, empty: true, files: 0, added: 0, removed: 0 });
  jj(main, 'new', '--quiet', '-m', 'left', 'root()');
  jj(main, 'bookmark', 'create', '--quiet', 'left', '-r', '@');
  jj(main, 'new', '--quiet', '-m', 'right', 'root()');
  jj(main, 'bookmark', 'create', '--quiet', 'right', '-r', '@');
  jj(main, 'new', '--quiet', 'left', 'right');
  const s = await readStatus(main, null, false, io);
  assert.equal(s.distance, 1);
  assert.ok(['left', 'right'].includes(s.bookmark));
});

test('identity treats a jj that cannot start as no jj', async () => {
  const missing = { exec: async () => { throw new Error('No such file or directory'); }, readTextFile: async () => null };
  assert.deepEqual(await identity('/anywhere', null, missing), { jj: false });
});

test('errorWord names stale workspaces and divergent operations', () => {
  assert.equal(errorWord('Error: The "@" expression resolved to more than one operation'), 'divergent');
  assert.equal(errorWord('Error: The working copy is stale (not updated since operation 1234).'), 'stale');
  assert.equal(errorWord('Error: Something else'), 'error');
});

test('joinPath resolves relative pointers', () => {
  assert.equal(joinPath('/t/w1/.jj', '../../main/.jj/repo'), '/t/main/.jj/repo');
  assert.equal(joinPath('/t/w1/.jj', '/abs/repo/'), '/abs/repo');
});

test('visible follows hidden blocks and inactive stack children', () => {
  const block = { id: 'b', type: 'block', content: { mod: 'm' } };
  assert.equal(visible({ children: [block] }, 'm'), true);
  assert.equal(visible({ hidden: true, children: [block] }, 'm'), false);
  assert.equal(visible({ type: 'stack', active: 'x', children: [block] }, 'm'), false);
  assert.equal(visible({ type: 'stack', active: 'b', children: [block] }, 'm'), true);
  assert.equal(visible({ children: [] }, 'm'), true);
});

test('every jj mod keeps an identical copy of the shared section', () => {
  const shared = name => readSync(new URL(`../mods/${name}/jj.js`, import.meta.url), 'utf8').match(/\/\/ shared:start\n[\s\S]*\/\/ shared:end\n/)?.[0];
  for (const name of ['jj-workspace', 'jj-menu', 'jj-new-menu', 'jj-changes']) assert.equal(shared(name), shared('jj-spaces'), name);
});

test('readStack lists @ alone when it sits on trunk()', async t => {
  const { main } = fixture(t);
  const stack = await readStack(main, null, io);
  assert.equal(stack.length, 1);
  assert.deepEqual({ ...stack[0], commit: '', change: '' }, { commit: '', change: '', description: '', empty: true, conflict: false, at: true, added: 0, removed: 0, files: [] });
});

test('readStack lists a stack newest first, with files only for @', async t => {
  const { main } = fixture(t);
  for (const n of ['one', 'two', 'three']) { writeFileSync(path.join(main, n), `${n}\n`); jj(main, 'commit', '--quiet', '-m', n); }
  writeFileSync(path.join(main, 'a'), 'one\n');
  await snapshot(main, null, io);
  const stack = await readStack(main, null, io);
  assert.deepEqual(stack.map(c => c.description), ['', 'three', 'two', 'one']);
  assert.deepEqual(stack[0].files, [{ path: 'a', status: 'M', added: 0, removed: 1 }]);
  assert.equal(stack.slice(1).some(c => 'files' in c), false);
  assert.deepEqual(stack.slice(1).map(c => c.added), [1, 1, 1]);
});

test('readStack stops at the cap', async t => {
  const { main } = fixture(t);
  for (let i = 0; i <= STACK_LIMIT; i++) jj(main, 'new', '--quiet');
  assert.equal((await readStack(main, null, io)).length, STACK_LIMIT);
});

test('readChange, readPair and filePattern cover added, modified and deleted files', async t => {
  const { main } = fixture(t);
  const odd = 'dir/b (x) "q".txt';
  execFileSync('mkdir', ['-p', path.join(main, 'dir')]);
  writeFileSync(path.join(main, odd), 'b\n');
  writeFileSync(path.join(main, 'gone'), 'g\n');
  jj(main, 'commit', '--quiet', '-m', 'older');
  const older = jj(main, 'log', '--no-graph', '-r', '@-', '-T', 'commit_id').trim();
  writeFileSync(path.join(main, 'a'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(main, odd), 'b2\n');
  rmSync(path.join(main, 'gone'));
  writeFileSync(path.join(main, 'new'), 'n\n');
  jj(main, 'commit', '--quiet', '-m', 'newer');
  const newer = jj(main, 'log', '--no-graph', '-r', '@-', '-T', 'commit_id').trim();
  assert.deepEqual(await readChange(main, null, older, io), [
    { path: odd, status: 'A', added: 1, removed: 0 }, { path: 'gone', status: 'A', added: 1, removed: 0 }]);
  assert.deepEqual(await readChange(main, null, newer, io), [
    { path: 'a', status: 'M', added: 1, removed: 0 }, { path: odd, status: 'M', added: 1, removed: 1 },
    { path: 'gone', status: 'D', added: 0, removed: 1 }, { path: 'new', status: 'A', added: 1, removed: 0 }]);
  const base = jj(main, 'log', '--no-graph', '-r', 'master', '-T', 'commit_id').trim();
  assert.deepEqual(await readPair(main, null, base, newer, io), [
    { path: 'a', status: 'M' }, { path: odd, status: 'A' }, { path: 'new', status: 'A' }]);
  assert.equal(jj(main, 'diff', '--name-only', '-r', newer, '--', filePattern(odd)), `${odd}\n`);
  assert.equal(jj(main, 'diff', '--name-only', '--from', base, '--to', newer, '--', filePattern(odd)), `${odd}\n`);
});

// Holds jj's working-copy lock on a checkout until the returned function is called.
async function holdLock(root) {
  const child = spawn('python3', ['-c', 'import fcntl,sys,time\nf=open(sys.argv[1],"a+")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("locked",flush=True)\ntime.sleep(60)',
    path.join(root, '.jj/working_copy/working_copy.lock')], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  return () => child.kill();
}

test('jj workspace remove keeps tracked edits, deletes ignored files and stops on a held lock', async t => {
  const { temp, main, w1 } = fixture(t);
  const w2 = path.join(temp, 'w2');
  jj(main, 'workspace', 'add', '--quiet', '--name', 'w2', w2);
  writeFileSync(path.join(w1, '.gitignore'), 'build.log\n');
  writeFileSync(path.join(w1, 'edit'), 'kept\n');
  writeFileSync(path.join(w1, 'build.log'), 'gone\n');
  assert.equal((await exec('jj', ['status'], { cwd: w1, timeout: 10_000 })).code, 0);
  assert.equal((await exec('jj', ['workspace', 'remove', 'w1'], { cwd: main, timeout: 10_000 })).code, 0);
  assert.equal(existsSync(w1), false);
  assert.notEqual(jj(main, '--ignore-working-copy', 'log', '--no-graph', '-r', 'files("edit")', '-T', 'commit_id').trim(), '');
  const release = await holdLock(w2);
  t.after(release);
  // jj waits on the lock without limit, so only the timeout ends these.
  const status = await exec('jj', ['status'], { cwd: w2, timeout: 2_000 });
  assert.notEqual(status.code, 0);
  const remove = await exec('jj', ['workspace', 'remove', 'w2'], { cwd: main, timeout: 2_000 });
  assert.notEqual(remove.code, 0);
  assert.equal(existsSync(w2), true);
  release();
  assert.equal((await exec('jj', ['workspace', 'remove', 'w2'], { cwd: main, timeout: 10_000 })).code, 0);
  assert.equal(existsSync(w2), false);
});
