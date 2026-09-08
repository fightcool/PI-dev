import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { CONFIG_DIR, ROOT, SERVICE, loadConfig, systemdQuote } from './lib.mjs';

function run(args) {
  const result = spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`systemctl failed: ${args.join(' ')}`);
}

async function assertPortFree(config) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const action = process.argv[2];
if (action === 'install') {
  const config = loadConfig();
  const active = spawnSync('systemctl', ['--user', 'is-active', '--quiet', SERVICE]);
  if (active.status === 0) throw new Error('Service is active; stop it explicitly before reinstalling.');
  await assertPortFree(config);
  const replacements = {
    ROOT: ROOT, NODE: config.node, START: join(ROOT, 'scripts/start.mjs'),
    CONFIG_ENV: `PI_DEV_CONFIG_DIR=${CONFIG_DIR}`,
  };
  const template = readFileSync(join(ROOT, 'deploy/pi-web-ui-dev.service.in'), 'utf8');
  const rendered = template.replace(/@(ROOT|NODE|START|CONFIG_ENV)@/g, (_, key) => {
    if (key === 'ROOT') return ROOT.replaceAll('%', '%%');
    return systemdQuote(replacements[key], key !== 'CONFIG_ENV');
  });
  const dir = join(homedir(), '.config/systemd/user');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unitPath = join(dir, SERVICE);
  if (existsSync(unitPath)) copyFileSync(unitPath, join(CONFIG_DIR, `${SERVICE}.${Date.now()}.bak`));
  writeFileSync(unitPath, rendered, { mode: 0o600 });
  const verification = spawnSync('systemd-analyze', ['--user', 'verify', unitPath], { stdio: 'inherit' });
  if (verification.error || verification.status !== 0) throw new Error('Generated unit failed verification.');
  run(['daemon-reload']);
  run(['enable', '--now', SERVICE]);
  console.log(`Installed ${unitPath}. No legacy unit or reverse proxy was modified.`);
} else if (['status', 'stop', 'start', 'restart'].includes(action)) {
  run([action, SERVICE]);
} else if (action === 'disable') {
  run(['disable', '--now', SERVICE]);
  console.log('Disabled the new instance; all private data and legacy services remain untouched.');
} else {
  throw new Error('Usage: node scripts/service.mjs install|status|start|stop|restart|disable');
}
