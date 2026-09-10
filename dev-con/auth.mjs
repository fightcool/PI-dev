/* 🍞 AI Breadcrumb: @COUPLED=linked files; @WHY=design reason; @MAGIC=limits.
 * @COUPLED dev-con/server.mjs, dev-con/cli.mjs, tests/dev-con-auth.test.mjs
 * 📖 docs/DEV-CON-IMPLEMENTATION.md
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const PARAMS = Object.freeze({ algorithm: 'scrypt', version: 1, N: 32768, r: 8, p: 1 });
export const SESSION_SECONDS = 43200;
const MAX_SESSIONS = 128;
const LOGIN_WINDOW_MS = 60000;
const MAX_ATTEMPTS = 10;
let activeDerivations = 0;

export function validatePasswordHash(hash) {
  if (!hash || typeof hash !== 'object' || Array.isArray(hash)
      || Object.keys(hash).sort().join(',') !== 'N,algorithm,key,p,r,salt,version'
      || Object.entries(PARAMS).some(([key, value]) => hash[key] !== value)
      || typeof hash.salt !== 'string' || !/^[a-f0-9]{32}$/.test(hash.salt)
      || typeof hash.key !== 'string' || !/^[a-f0-9]{128}$/.test(hash.key)) {
    throw new Error('Invalid password configuration');
  }
  return { ...hash };
}

function validPassword(password) {
  return typeof password === 'string' && Buffer.byteLength(password) >= 12
    && Buffer.byteLength(password) <= 1024;
}

async function passwordKey(password, salt) {
  // @WHY Fixed parameters and process-wide concurrency cap bound native memory use.
  if (activeDerivations >= 2) throw new Error('Authentication busy');
  activeDerivations++;
  try {
    return await derive(password, salt, 64, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: 64 * 1024 * 1024 });
  } finally {
    activeDerivations--;
  }
}

export async function hashPassword(password) {
  if (!validPassword(password)) throw new Error('Password must contain 12–1024 UTF-8 bytes');
  const salt = randomBytes(16).toString('hex');
  const key = await passwordKey(password, Buffer.from(salt, 'hex'));
  return { ...PARAMS, salt, key: key.toString('hex') };
}

export async function verifyPassword(password, passwordHash) {
  const hash = validatePasswordHash(passwordHash);
  if (!validPassword(password)) return false;
  const actual = await passwordKey(password, Buffer.from(hash.salt, 'hex'));
  return timingSafeEqual(actual, Buffer.from(hash.key, 'hex'));
}

export function equalToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createAuth(passwordHash, { now = Date.now } = {}) {
  const hash = validatePasswordHash(passwordHash);
  const sessions = new Map();
  let windowStart = now();
  let attempts = 0;
  function prune() {
    const current = now();
    for (const [id, session] of sessions) {
      if (session.expires <= current) sessions.delete(id);
    }
  }
  return {
    get(id) {
      prune();
      return sessions.get(id);
    },
    remove(id) { sessions.delete(id); },
    clear() { sessions.clear(); },
    async login(password, previousId) {
      prune();
      const current = now();
      if (current - windowStart >= LOGIN_WINDOW_MS) {
        windowStart = current;
        attempts = 0;
      }
      // @WHY Global window cannot grow with spoofed client addresses or forwarded headers.
      if (attempts >= MAX_ATTEMPTS || activeDerivations >= 2) return { status: 429 };
      attempts++;
      try {
        if (!await verifyPassword(password, hash)) return { status: 401 };
      } catch {
        return { status: 429 };
      }
      sessions.delete(previousId);
      prune();
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      const id = randomBytes(32).toString('hex');
      const session = { csrfToken: randomBytes(32).toString('hex'), expires: now() + SESSION_SECONDS * 1000 };
      sessions.set(id, session);
      return { status: 200, id, csrfToken: session.csrfToken };
    },
  };
}
