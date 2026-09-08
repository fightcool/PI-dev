import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadConfig, ROOT, runtimeEnv } from './lib.mjs';

const config = loadConfig();
Object.assign(process.env, runtimeEnv(config));
process.chdir(ROOT);
await import(pathToFileURL(join(ROOT, 'node_modules/pi-web-ui/dist/server/index.js')).href);
