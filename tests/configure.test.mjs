import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, readJson } from '../scripts/lib.mjs';

test('configure preserves private token and custom settings on repeat installs', () => {
  const home = mkdtempSync(join(tmpdir(), 'pi-dev-home-'));
  const env = { ...process.env, HOME: home, PI_DEV_CONFIG_DIR: join(home, '.config/pi-dev') };
  function configure(args = []) {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts/configure.mjs'), ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  try {
    configure();
    const tokenPath = join(env.PI_DEV_CONFIG_DIR, 'token');
    const token = readFileSync(tokenPath, 'utf8');
    const config = readJson(join(env.PI_DEV_CONFIG_DIR, 'runtime.json'));
    assert.ok(config.agentDir.startsWith(home));
    const settingsPath = join(config.agentDir, 'settings.json');
    const settings = { ...readJson(settingsPath), defaultModel: 'user-selected-model' };
    writeFileSync(settingsPath, JSON.stringify(settings));
    configure();
    assert.equal(readFileSync(tokenPath, 'utf8'), token);
    assert.deepEqual(readJson(settingsPath), settings);
    configure(['--profile=full']);
    assert.equal(readJson(settingsPath).defaultModel, settings.defaultModel);
    assert.ok(readJson(settingsPath).packages.some((path) => path.endsWith('/pi-lens')));
    configure(['--profile=lean']);
    assert.equal(readJson(settingsPath).packages.length, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
