import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR, CONFIG_FILE, ROOT, PROFILES, validateConfig, readJson } from './lib.mjs';

const profileArg = process.argv.find((arg) => arg.startsWith('--profile='));
const existing = existsSync(CONFIG_FILE) ? readJson(CONFIG_FILE) : null;
const stateDir = join(homedir(), '.local/share/pi-dev');
const config = validateConfig(existing || {
  root: ROOT, node: process.execPath, host: '127.0.0.1', port: 8788,
  dataDir: join(stateDir, 'web'), agentDir: join(stateDir, 'agent'),
  tokenFile: join(CONFIG_DIR, 'token'), profile: 'lean',
});
if (profileArg) {
  config.profile = profileArg.slice('--profile='.length);
  validateConfig(config);
}
for (const dir of [CONFIG_DIR, config.dataDir, config.agentDir]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
if (!existsSync(config.tokenFile)) writeFileSync(config.tokenFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
chmodSync(CONFIG_FILE, 0o600);
const settingsPath = join(config.agentDir, 'settings.json');
if (!existsSync(settingsPath) || profileArg) {
  const settings = existsSync(settingsPath) ? readJson(settingsPath) : {
    defaultProjectTrust: 'ask', enableInstallTelemetry: false,
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  };
  settings.packages = PROFILES[config.profile].map((name) => join(ROOT, 'node_modules', name));
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}
console.log(`Configured ${CONFIG_FILE}; profile=${config.profile}; cwd=${ROOT}`);
console.log('Provider credentials are intentionally not imported. Configure them in the new instance.');
