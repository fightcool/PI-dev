import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadConfig, ROOT, runtimeEnv } from './lib.mjs';

const config = loadConfig();
Object.assign(process.env, runtimeEnv(config));
process.chdir(ROOT);
const localBuild = join(ROOT, 'vendor/pi-web-ui/dist/server/index.js');
const packagedBuild = join(ROOT, 'node_modules/pi-web-ui/dist/server/index.js');
const entry = process.env.PI_DEV_WEB_UI_ENTRY || (existsSync(localBuild) ? localBuild : packagedBuild);
await import(pathToFileURL(entry).href);
