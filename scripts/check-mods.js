import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
