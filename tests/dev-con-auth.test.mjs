/* 🍞 AI Breadcrumb: @COUPLED=linked files.
 * @COUPLED dev-con/auth.mjs; 📖 docs/DEV-CON-IMPLEMENTATION.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, validatePasswordHash, createAuth, SESSION_SECONDS } from '../dev-con/auth.mjs';

const password = 'test-only-generated-secret';
const hash = await hashPassword(password);

test('scrypt salts differ, hashes round-trip, malformed parameters fail before deriving', { timeout: 5000 }, async () => {
  const second = await hashPassword(password);
  assert.notEqual(hash.salt, second.salt);
  assert.equal(await verifyPassword(password, JSON.parse(JSON.stringify(hash))), true);
  assert.equal(await verifyPassword('incorrect-test-password', hash), false);
  assert.equal(await verifyPassword(null, hash), false);
  for (const changed of [{ N: 2 ** 30 }, { r: 99999 }, { p: 0 }, { key: '00' }, { salt: 'zz' }, { extra: 1 }]) {
    assert.throws(() => validatePasswordHash({ ...hash, ...changed }));
  }
  await assert.rejects(hashPassword('short'));
  await assert.rejects(hashPassword('a'.repeat(1025)));
});

test('sessions expire, rotate, and are invalidated; fixed window limits attempts', { timeout: 10000 }, async () => {
  let clock = 100;
  const auth = createAuth(hash, { now: () => clock });
  const first = await auth.login(password);
  assert.equal(first.status, 200);
  assert.equal(auth.get(first.id).csrfToken, first.csrfToken);
  const second = await auth.login(password, first.id);
  assert.equal(auth.get(first.id), undefined);
  clock += SESSION_SECONDS * 1000;
  assert.equal(auth.get(second.id), undefined);
  for (let i = 0; i < 10; i++) assert.equal((await auth.login('incorrect-test-password')).status, 401);
  assert.equal((await auth.login(password)).status, 429);
  clock += 60000;
  const third = await auth.login(password);
  assert.equal(third.status, 200);
  auth.remove(third.id);
  assert.equal(auth.get(third.id), undefined);
});

test('parallel scrypt attempts have a process-wide bound', { timeout: 5000 }, async () => {
  const auth = createAuth(hash);
  const results = await Promise.all(Array.from({ length: 8 }, () => auth.login(password)));
  assert.equal(results.filter(result => result.status === 200).length, 2);
  assert.equal(results.filter(result => result.status === 429).length, 6);
  auth.clear();
  for (const result of results) assert.equal(auth.get(result.id), undefined);
});

test('session storage evicts oldest sessions at its bound', { timeout: 60000 }, async () => {
  let clock = 0;
  const auth = createAuth(hash, { now: () => clock });
  const first = await auth.login(password);
  let last;
  for (let i = 0; i < 128; i++) {
    clock += 60000;
    last = await auth.login(password);
    assert.equal(last.status, 200);
  }
  assert.equal(auth.get(first.id), undefined);
  assert.ok(auth.get(last.id));
});
