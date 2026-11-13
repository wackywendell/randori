import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Herdr mods import only from their own folder, so each jj mod keeps a copy
// of the shared section of mods/jj-spaces/jj.js. Copies must not drift.
const shared = text => text.match(/\/\/ shared:start\n[\s\S]*\/\/ shared:end\n/)?.[0];
const source = shared(await fs.readFile('mods/jj-spaces/jj.js', 'utf8'));
for (const name of await fs.readdir('mods')) {
  const file = path.join('mods', name, 'jj.js');
  const copy = await fs.readFile(file, 'utf8').catch(() => null);
  if (copy !== null && shared(copy) !== source) throw new Error(`${file}: the shared section differs from mods/jj-spaces/jj.js`);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-jj-check-'));
try {
  for (const name of await fs.readdir('mods')) {
    const dest = path.join(temp, 'mods', name);
    await fs.cp(path.resolve('mods', name), dest, { recursive: true });
    const r = spawnSync('herdr-app', ['check', dest], {
      env: { ...process.env, HERDR_APP_HOME: temp }, encoding: 'utf8', timeout: 30_000,
    });
    if (r.error || r.status !== 0) throw new Error(`${name}: ${r.error?.message || r.stderr || r.stdout}`);
    console.log(`${name}: ${r.stdout.trim() || 'OK'}`);
  }
} finally {
  await fs.rm(temp, { recursive: true });
}
