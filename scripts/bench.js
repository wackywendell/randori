// Times the jj reads the mods run, against disposable repositories in the
// system temp folder. Writes the results to .tmp/bench.json.
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { readStatus } from '../mods/jj-spaces/jj.js';

let processes = 0;
const exec = (cmd, args, { cwd } = {}) => new Promise((resolve, reject) => {
  processes++;
  execFile(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 8 << 20 },
    (error, stdout, stderr) => typeof error?.code === 'string' ? reject(error) : resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }));
});
const io = { exec };
const jj = (cwd, ...args) => execFileSync('jj', ['--config', 'signing.behavior=drop', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function measure(body, n = 9) {
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
      read: await measure(() => readStatus(main, null, false, io)),
      unchanged_snapshot: await measure(() => readStatus(main, null, true, io)),
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
  const refresh = await measure(async () => { for (const root of roots) await readStatus(root, null, false, io); }, 5);
  const result = {
    jj: execFileSync('jj', ['--version'], { encoding: 'utf8' }).trim(),
    note: 'Medians over local temporary repositories with three edited files in @, using the user jj config.',
    status_line: status,
    op_heads_refresh_20_workspaces: refresh,
  };
  await fs.mkdir('.tmp', { recursive: true });
  await fs.writeFile('.tmp/bench.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
