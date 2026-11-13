// Times the jj reads the mods run, against disposable repositories in the
// system temp folder. Writes the results to .tmp/bench.json.
import '../tests/jj-config.js';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { readStatus } from '../mods/jj-spaces/jj.js';
import { snapshot, readStack, readDiff, STACK_LIMIT } from '../mods/jj-changes/jj.js';

let processes = 0;
const exec = (cmd, args, { cwd } = {}) => new Promise((resolve, reject) => {
  processes++;
  execFile(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 8 << 20 },
    (error, stdout, stderr) => typeof error?.code === 'string' ? reject(error) : resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
});
const io = { exec };
const jj = (cwd, ...args) => execFileSync('jj', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function measure(name, body, n = 9) {
  console.error(`measuring ${name}`);
  const samples = [];
  processes = 0;
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    const r = await body();
    if (r?.error) throw new Error(r.message);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return { samples: n, median_ms: +samples[n >> 1].toFixed(1), max_ms: +samples.at(-1).toFixed(1), jj_processes: processes };
}

// A repository with `files` tracked files in one commit and three edited in @.
async function repo(temp, files) {
  console.error(`building ${files} files`);
  const main = path.join(temp, `files-${files}`);
  jj(temp, 'git', 'init', '--quiet', main);
  const dirs = Math.ceil(files / 1000);
  for (let d = 0; d < dirs; d++) await fs.mkdir(path.join(main, `d${d}`));
  for (let i = 0; i < files; i += 5000) {
    await Promise.all(Array.from({ length: Math.min(5000, files - i) }, (_, j) => fs.writeFile(path.join(main, `d${(i + j) % dirs}`, `f${i + j}`), `line ${i + j}\n`)));
  }
  jj(main, 'commit', '--quiet', '-m', 'files');
  jj(main, 'bookmark', 'create', '--quiet', 'master', '-r', '@-');
  for (let i = 0; i < 3; i++) await fs.writeFile(path.join(main, `d${i % dirs}`, `f${i}`), `changed ${i}\n`);
  jj(main, 'util', 'snapshot');
  return main;
}

const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-jj-bench-')));
try {
  const status = {};
  for (const files of [3, 10_000, 100_000]) {
    const main = await repo(temp, files);
    status[files] = {
      read: await measure(`status read, ${files} files`, () => readStatus(main, null, false, io)),
      unchanged_snapshot: await measure(`status read with snapshot, ${files} files`, () => readStatus(main, null, true, io)),
      // What showing the changes panel runs.
      panel_snapshot_and_stack: await measure(`panel snapshot and stack, ${files} files`, async () => { await snapshot(main, null, io); await readStack(main, null, io); }),
    };
  }
  // One op_heads batch rereads every space of the repository, one at a time.
  const main = path.join(temp, 'files-3');
  const roots = [main];
  for (let i = 1; i < 20; i++) {
    const root = path.join(temp, `w${i}`);
    jj(main, 'workspace', 'add', '--quiet', '--name', `w${i}`, root);
    roots.push(root);
  }
  const refresh = await measure('20-workspace refresh', async () => { for (const root of roots) await readStatus(root, null, false, io); }, 5);
  // A stack of STACK_LIMIT changes above trunk(), each editing one file,
  // and a change adding a 5,000-line file.
  const deep = path.join(temp, 'deep');
  jj(temp, 'git', 'init', '--quiet', deep);
  jj(deep, 'bookmark', 'create', '--quiet', 'master', '-r', '@');
  for (let i = 0; i < STACK_LIMIT; i++) {
    await fs.writeFile(path.join(deep, 'f'), `change ${i}\n`);
    jj(deep, '--config', 'fsmonitor.backend=none', 'commit', '--quiet', '-m', `change ${i}`);
  }
  await fs.writeFile(path.join(deep, 'big'), Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n') + '\n');
  jj(deep, 'util', 'snapshot');
  const stack = await measure('100-change stack', () => readStack(deep, null, io));
  const diff = await measure('5,000-line diff', () => readDiff(deep, null, ['-r', '@'], 'big', io));
  const result = {
    jj: execFileSync('jj', ['--version'], { encoding: 'utf8' }).trim(),
    note: 'Medians over local temporary repositories with three edited files in @, using the user jj config and tests/jj-test.toml.',
    status_line: status,
    op_heads_refresh_20_workspaces: refresh,
    stack_read_100_changes: stack,
    file_diff_5000_lines: diff,
  };
  await fs.mkdir('.tmp', { recursive: true });
  await fs.writeFile('.tmp/bench.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
