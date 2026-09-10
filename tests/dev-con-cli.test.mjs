/* 🍞 AI Breadcrumb: @COUPLED=linked files.
 * @COUPLED dev-con/cli.mjs, dev-con/auth.mjs; 📖 docs/DEV-CON-IMPLEMENTATION.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, chmod, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeConfig, readConfig } from '../dev-con/cli.mjs';
import { verifyPassword } from '../dev-con/auth.mjs';

const cli = fileURLToPath(new URL('../dev-con/cli.mjs', import.meta.url));
const password = 'synthetic-cli-test-password';
async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'dev-con-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function run(command, args, { input = '', closeInput = true, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (expired) reject(new Error('CLI subprocess deadline'));
      else resolve({ code, stdout, stderr });
    });
    if (closeInput) child.stdin.end(input);
  });
}

test('init stdin stores only a salted hash with private modes and never overwrites', { timeout: 10000 }, async t => {
  const root = await temp(t);
  const dir = join(root, 'private');
  const result = await run(process.execPath, [cli, 'init', '--config-dir', dir], { input: `${password}\n` });
  assert.equal(result.code, 0);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const path = join(dir, 'config.json');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const original = await readFile(path, 'utf8');
  assert.equal(original.includes(password), false);
  assert.equal((result.stdout + result.stderr).includes(password), false);
  const config = await readConfig(dir);
  assert.equal(await verifyPassword(password, config.passwordHash), true);
  const repeated = await run(process.execPath, [cli, 'init', '--config-dir', dir], { input: password });
  assert.equal(repeated.code, 1);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('config rejects symlink directories/files, wrong modes, extra keys, huge files and malicious scrypt parameters', { timeout: 10000 }, async t => {
  const root = await temp(t);
  const dir = join(root, 'private');
  await initializeConfig(dir, password);
  const file = join(dir, 'config.json');
  const original = await readFile(file, 'utf8');
  const link = join(root, 'alias');
  await symlink(dir, link);
  await assert.rejects(readConfig(link));
  await assert.rejects(initializeConfig(join(link, 'nested'), password));
  await chmod(file, 0o644);
  await assert.rejects(readConfig(dir));
  await chmod(file, 0o600);
  await chmod(dir, 0o755);
  await assert.rejects(readConfig(dir));
  await chmod(dir, 0o700);
  const config = JSON.parse(original);
  for (const content of [JSON.stringify({ ...config, extra: 1 }), 'x'.repeat(5000),
    JSON.stringify({ ...config, passwordHash: { ...config.passwordHash, N: 2 ** 30 } })]) {
    await writeFile(file, content);
    await assert.rejects(readConfig(dir));
  }
  const target = join(root, 'target');
  await writeFile(target, original, { mode: 0o600 });
  await rm(file);
  await symlink(target, file);
  await assert.rejects(readConfig(dir));
  await assert.rejects(initializeConfig(dir, password));
  assert.equal(await readFile(target, 'utf8'), original);
  await rm(file);
  await mkdir(file, { mode: 0o600 });
  await assert.rejects(readConfig(dir));
});

test('CLI help is safe; missing, oversized, and stalled stdin fail; unsupported options and root are rejected', { timeout: 15000 }, async t => {
  const root = await temp(t);
  const dir = join(root, 'private');
  const help = await run(process.execPath, [cli, '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /hidden TTY input/);
  assert.match(help.stdout, /redirected stdin/);
  assert.match(help.stdout, /checkout/);
  for (const args of [['init', '--config-dir', 'relative'], ['serve', '--port=0'], ['serve', '--port=65536'],
    ['init', '--password=synthetic-value'], ['serve', '--origin=https://example.com/path'], ['serve', '--unknown']]) {
    const result = await run(process.execPath, [cli, ...args]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.includes('synthetic-value'), false);
  }
  for (const input of ['', 'short', 'x'.repeat(2000)]) {
    assert.equal((await run(process.execPath, [cli, 'init', '--config-dir', dir], { input })).code, 1);
  }
  assert.equal((await run(process.execPath, [cli, 'init', '--config-dir', dir], { closeInput: false })).code, 1);
  const rootCheck = await run(process.execPath, ['--input-type=module', '-e',
    `import { main } from ${JSON.stringify(new URL('../dev-con/cli.mjs', import.meta.url).href)}; process.getuid = () => 0; await main(['--help']);`]);
  assert.equal(rootCheck.code, 1);
});

test('serve starts on loopback using only its private config and shuts down cleanly', { timeout: 10000 }, async t => {
  const root = await temp(t);
  const dir = join(root, 'private');
  await initializeConfig(dir, password);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [cli, 'serve', '--config-dir', dir, `--port=${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await closed; } finally { clearTimeout(timer); }
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  let output = '';
  child.stderr.on('data', data => { output += data; });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', data => {
        output += data;
        if (output.includes(`127.0.0.1:${port}`)) resolve();
      });
      child.once('error', reject);
      child.once('close', () => reject(new Error('Server did not start')));
    });
  } finally { clearTimeout(timer); }
  assert.equal(output.includes(password), false);
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/session`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: false });
  child.kill('SIGTERM');
  assert.deepEqual(await closed, [0, null]);
});

test('hidden TTY initialization does not echo input and restores terminal mode', { timeout: 10000 }, async t => {
  const root = await temp(t);
  const dir = join(root, 'private');
  const script = `import os, pty, subprocess, select, time, secrets, termios, sys
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
proc = subprocess.Popen([sys.argv[1], sys.argv[2], 'init', '--config-dir', sys.argv[3]], stdin=slave, stdout=slave, stderr=slave)
output = b''
password = secrets.token_hex(16).encode()
try:
    deadline = time.monotonic() + 5
    while b'(hidden): ' not in output:
        assert time.monotonic() < deadline, 'TTY prompt deadline'
        if select.select([master], [], [], 0.1)[0]: output += os.read(master, 4096)
    os.write(master, password + b'\\r')
    assert proc.wait(timeout=5) == 0, 'TTY init failed'
    while select.select([master], [], [], 0.05)[0]: output += os.read(master, 4096)
    assert password not in output, 'TTY input echoed'
    assert termios.tcgetattr(slave) == original, 'TTY mode not restored'
finally:
    if proc.poll() is None: proc.kill(); proc.wait()
    os.close(master)
    os.close(slave)
`;
  const result = await run('python3', ['-c', script, process.execPath, cli, dir]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await readConfig(dir)).version, 1);
});
