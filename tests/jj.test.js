// jj.js against real jj in disposable repositories under the system temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync as readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { identity, joinPath, readStatus, visible, errorWord } from '../mods/jj-spaces/jj.js';

// Herdr's exec: resolves { code, stdout, stderr }, rejects when the program cannot start.
export const exec = (cmd, args, { cwd } = {}) => new Promise((resolve, reject) => execFile(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 8 << 20 },
  (error, stdout, stderr) => typeof error?.code === 'string' ? reject(error) : resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
const io = { exec, readTextFile: path => readFile(path, 'utf8') };
// Fixture commands skip signing; the reads under test run with the user's jj config.
const jj = (cwd, ...args) => execFileSync('jj', ['--config', 'signing.behavior=drop', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

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
  for (const name of ['jj-workspace', 'jj-menu', 'jj-new-menu']) assert.equal(shared(name), shared('jj-spaces'), name);
});
