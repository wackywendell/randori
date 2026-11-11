import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-jj-bench-')));
const helper = path.resolve('target/debug/herdr-jj');
const realJJ = execFileSync('which', ['jj'], { encoding: 'utf8' }).trim();
const count = path.join(temp, 'queries');
const bin = path.join(temp, 'bin');
await fs.mkdir(bin);
await fs.writeFile(path.join(bin, 'jj'), '#!/bin/sh\nprintf "jj\\n" >> "$JJ_COUNT"\nexec "$JJ_REAL" "$@"\n', { mode: 0o755 });
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, JJ_REAL: realJJ, JJ_COUNT: count };
const main = path.join(temp, 'project');
const exec = (program, args, cwd = temp) => execFileSync(program, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function measure(command, n = 9) {
  await fs.writeFile(count, '');
  const samples = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    exec(helper, [...command, '--cwd', main]);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const queries = (await fs.readFile(count, 'utf8')).split('\n').filter(Boolean).length;
  return { samples: n, median_ms: +samples[Math.floor(n / 2)].toFixed(2), max_ms: +samples.at(-1).toFixed(2), jj_processes: queries };
}
try {
  exec(realJJ, ['git', 'init', '--colocate', main]);
  exec(realJJ, ['config', 'set', '--repo', 'signing.behavior', 'drop'], main);
  exec(realJJ, ['config', 'set', '--repo', 'snapshot.auto-track', 'all()'], main);
  for (let dir = 0; dir < 10; dir++) await fs.mkdir(path.join(main, `d${dir}`));
  await Promise.all(Array.from({ length: 1000 }, (_, i) => fs.writeFile(path.join(main, `d${i % 10}`, `file${i}`), `content ${i}\n`)));
  exec(helper, ['inspect', '--snapshot', '--cwd', main]);
  const probe = await measure(['probe']);
  const metadata = await measure(['inspect']);
  const unchanged_snapshot = await measure(['inspect', '--snapshot']);
  await Promise.all(Array.from({ length: 1000 }, (_, i) => fs.writeFile(path.join(main, `d${i % 10}`, `file${i}`), `changed ${i}\n`)));
  const changed_snapshot = await measure(['inspect', '--snapshot'], 1);

  assert.equal(probe.jj_processes, 0);
  assert.equal(metadata.jj_processes, 9);
  console.log(JSON.stringify({ fixture: '1000 tracked files in 10 directories, local temporary repository', build: 'debug',
    note: 'Real timings include helper startup and an exec-only jj counting wrapper. Organizational space rows perform no VCS work; automatic repository refresh is deferred.',
    probe, metadata, unchanged_snapshot, changed_snapshot,
  }, null, 2));
} finally {
  await fs.rm(temp, { recursive: true });
}
