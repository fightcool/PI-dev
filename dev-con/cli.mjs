#!/usr/bin/env node
/* 🍞 AI Breadcrumb: @COUPLED=linked files; @WHY=design reason.
 * @COUPLED dev-con/auth.mjs, dev-con/server.mjs, dev-con/overview.mjs, tests/dev-con-cli.test.mjs
 * 📖 docs/DEV-CON-IMPLEMENTATION.md
 */
import { emitKeypressEvents } from 'node:readline';
import { constants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hashPassword, validatePasswordHash } from './auth.mjs';
import { createControlServer, validateOrigin } from './server.mjs';

const DEFAULT_DIR = fileURLToPath(new URL('../.dev/dev-con', import.meta.url));
const CONFIG_FILE = 'config.json';
const HELP = `DEV-CON read-only control console
Usage:
  node dev-con/cli.mjs init [--config-dir /absolute/directory]
  node dev-con/cli.mjs serve [--config-dir /absolute/directory] [--port=8791] [--origin=http://127.0.0.1:8791]

Default configuration: this checkout's .dev/dev-con/config.json
init reads a 12–1024 UTF-8 byte password using hidden TTY input (30s deadline)
or redirected stdin (5s deadline). Password arguments and environment variables
are not supported. Use init directly in a terminal; input is never echoed.
Only a salted password hash is stored. Existing configuration is never overwritten.
serve listens only on 127.0.0.1. HTTPS origins require your own TLS proxy.
`;

function parse(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const [command, ...rest] = args;
  if (!['init', 'serve'].includes(command)) throw new Error('Invalid command');
  const options = { command, configDir: DEFAULT_DIR, port: 8791 };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const match = /^(--config-dir|--port|--origin)(?:=(.*))?$/.exec(rest[i]);
    if (!match || seen.has(match[1])) throw new Error('Invalid arguments');
    seen.add(match[1]);
    const value = match[2] ?? rest[++i];
    if (!value || value.startsWith('--')) throw new Error('Invalid arguments');
    if (match[1] === '--config-dir') options.configDir = value;
    else if (command !== 'serve') throw new Error('Invalid arguments');
    else if (match[1] === '--origin') options.origin = validateOrigin(value).origin;
    else {
      if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('Invalid port');
      options.port = Number(value);
    }
  }
  if (!isAbsolute(options.configDir) || options.configDir.split('/').includes('..')) throw new Error('Absolute directory required');
  return options;
}

function privateStat(stat, directory = false) {
  return (directory ? stat.isDirectory() : stat.isFile()) && stat.uid === process.getuid()
    && (stat.mode & 0o7777) === (directory ? 0o700 : 0o600) && (directory || stat.nlink === 1);
}

async function configDirectory(path, create) {
  // @WHY Directory descriptors + nofollow prevent symlink swaps at every path component (Linux).
  let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const parts = resolve(path).split('/').filter(Boolean);
    if (!parts.length) throw new Error('Invalid configuration directory');
    for (const part of parts) {
      const child = `/proc/self/fd/${handle.fd}/${part}`;
      if (create) {
        try { await mkdir(child, { mode: 0o700 }); } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
      const next = await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close();
      handle = next;
    }
    if (!privateStat(await handle.stat(), true)) throw new Error('Unsafe configuration directory');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readConfig(configDir) {
  if (!isAbsolute(configDir)) throw new Error('Absolute directory required');
  const dir = await configDirectory(configDir, false);
  let file;
  try {
    file = await open(`/proc/self/fd/${dir.fd}/${CONFIG_FILE}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!privateStat(stat) || stat.size > 4096) throw new Error('Unsafe configuration');
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error('Invalid configuration');
    const config = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (!config || Object.keys(config).sort().join(',') !== 'passwordHash,version' || config.version !== 1) throw new Error('Invalid configuration');
    return { version: 1, passwordHash: validatePasswordHash(config.passwordHash) };
  } finally {
    await file?.close();
    await dir.close();
  }
}

export async function initializeConfig(configDir, password) {
  if (!isAbsolute(configDir)) throw new Error('Absolute directory required');
  const passwordHash = await hashPassword(password);
  const dir = await configDirectory(configDir, true);
  let file;
  try {
    file = await open(`/proc/self/fd/${dir.fd}/${CONFIG_FILE}`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.chmod(0o600);
    await file.writeFile(`${JSON.stringify({ version: 1, passwordHash })}\n`);
    await file.sync();
    await dir.sync();
  } finally {
    await file?.close();
    await dir.close();
  }
}

function ttyPassword() {
  return new Promise((resolveInput, reject) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    let text = '';
    const timer = setTimeout(() => finish(true), 30000);
    function finish(failed) {
      clearTimeout(timer);
      input.off('keypress', onKey).off('error', onError).off('end', onError);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write('\n');
      if (failed) reject(new Error('Password input unavailable'));
      else resolveInput(text);
      text = '';
    }
    function onError() { finish(true); }
    function onKey(value, key = {}) {
      if (key.ctrl && ['c', 'd'].includes(key.name)) return finish(true);
      if (key.name === 'return' || key.name === 'enter') return finish(text.length === 0);
      if (key.name === 'backspace') text = Array.from(text).slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && value && !/[\x00-\x1f\x7f]/.test(value)) text += value;
      if (Buffer.byteLength(text) > 1024) finish(true);
    }
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on('keypress', onKey).on('error', onError).on('end', onError).resume();
    process.stderr.write('DEV-CON password (hidden): ');
  });
}

function stdinPassword() {
  if (process.stdin.isTTY) return ttyPassword();
  return new Promise((resolveInput, reject) => {
    let text = '';
    const timer = setTimeout(() => finish(true), 5000);
    function finish(failed) {
      clearTimeout(timer);
      process.stdin.off('data', onData).off('end', onEnd).off('error', onError);
      process.stdin.pause();
      if (failed) reject(new Error('Password stdin required'));
      else resolveInput(text.replace(/\r?\n$/, ''));
      text = '';
    }
    function onData(chunk) {
      text += chunk;
      if (Buffer.byteLength(text) > 1026) finish(true);
    }
    function onEnd() { finish(text.length === 0); }
    function onError() { finish(true); }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData).on('end', onEnd).on('error', onError).resume();
  });
}

export async function main(args = process.argv.slice(2)) {
  try {
    if (typeof process.getuid !== 'function' || process.getuid() === 0) throw new Error('Non-root user required');
    const options = parse(args);
    if (options.help) { process.stdout.write(HELP); return; }
    if (options.command === 'init') {
      await initializeConfig(options.configDir, await stdinPassword());
      process.stdout.write('DEV-CON configuration initialized.\n');
      return;
    }
    const { passwordHash } = await readConfig(options.configDir);
    const { collectOverview } = await import('./overview.mjs');
    const server = createControlServer({ passwordHash, collectOverview, origin: options.origin });
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
    });
    process.stdout.write(`DEV-CON listening on 127.0.0.1:${options.port}\n`);
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      server.close();
      server.closeAllConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.on('error', () => { process.stderr.write('DEV-CON server failed.\n'); process.exitCode = 1; stop(); });
  } catch {
    process.stderr.write('DEV-CON failed. Check arguments, private configuration permissions, and password input for init; use --help.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
