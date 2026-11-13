// Points JJ_CONFIG at the user's jj config followed by tests/jj-test.toml, for
// every jj process this Node process starts, including the mods' own.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'jj');
const user = process.env.JJ_CONFIG ?? [path.join(dir, 'config.toml'), path.join(dir, 'conf.d')].filter(existsSync).join(':');
process.env.JJ_CONFIG = [user, fileURLToPath(new URL('jj-test.toml', import.meta.url))].filter(Boolean).join(':');
