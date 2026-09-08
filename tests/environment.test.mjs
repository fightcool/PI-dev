import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, PROFILES, validateConfig, runtimeEnv, systemdQuote, readJson } from '../scripts/lib.mjs';

const config = () => ({ root: ROOT, node: process.execPath, host: '127.0.0.1', port: 8788,
  dataDir: '/tmp/pi-dev-web', agentDir: '/tmp/pi-dev-agent', tokenFile: '/tmp/pi-dev-token', profile: 'lean' });

test('defaults use a dedicated project, service port and lean profile', () => {
  assert.equal(validateConfig(config()).root, ROOT);
  assert.deepEqual(PROFILES.lean, ['pi-context-prune']);
  assert.ok(PROFILES.full.includes('pi-lens'));
});
for (const invalid of [{ port: 8787 }, { port: 80 }, { port: 65536 }, { port: '8788' },
  { host: '0.0.0.0' }, { root: '/root' }, { profile: 'typo' }, { node: '/usr/bin/node\nOops' },
  { agentDir: '/tmp/pi-dev-web' }]) {
  test(`reject unsafe config ${JSON.stringify(invalid)}`, () => assert.throws(() => validateConfig({ ...config(), ...invalid })));
}
test('runtime overrides inherited old-instance paths and activates the project venv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-dev-test-'));
  try {
    const tokenFile = join(dir, 'token');
    writeFileSync(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    const env = runtimeEnv({ ...config(), tokenFile }, { PI_WEB_CWD: '/root', PI_WEB_PORT: '8787' });
    assert.equal(env.PI_WEB_CWD, ROOT);
    assert.equal(env.PI_WEB_PORT, '8788');
    assert.equal(env.PI_CODING_AGENT_DIR, '/tmp/pi-dev-agent');
    assert.equal(env.VIRTUAL_ENV, join(ROOT, '.venv'));
    assert.ok(env.PATH.startsWith(join(ROOT, '.venv/bin')));
    assert.equal(env.PI_WEB_TOKEN.length, 64);
    writeFileSync(tokenFile, '');
    assert.throws(() => runtimeEnv({ ...config(), tokenFile }, {}));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('systemd paths preserve spaces, literal specifiers and dollars', () => {
  assert.equal(systemdQuote('/a b/"x"%$'), '"/a b/\\"x\\"%%$$"');
});
test('invalid JSON fails with a contextual error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-dev-json-'));
  try {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{');
    assert.throws(() => readJson(path), /Cannot read valid JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
