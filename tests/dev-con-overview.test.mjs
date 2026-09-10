/* 🍞 AI Breadcrumb Navigation — @COUPLED=implementation; @CONTRACT=test scope.
 * @COUPLED dev-con/overview.mjs, dev-con/agents.mjs
 * @CONTRACT Fake command runner and metadata only; no live services or private configuration.
 * 📖 docs/DEV-CON-IMPLEMENTATION.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverviewCollector } from '../dev-con/overview.mjs';

const privateSentinel = 'private-fixture-must-not-appear';
const system = { cpus: () => [0, 0], freemem: () => 0, totalmem: () => 8192, loadavg: () => [0, 0, 0],
  uptime: () => 0, platform: () => 'linux', arch: () => 'x64' };
const read = async path => JSON.stringify(path.endsWith('vendor/pi-web-ui/package.json')
  ? { version: '0.72.0', dependencies: { '@earendil-works/pi-coding-agent': '0.85.1' }, secret: privateSentinel }
  : { name: privateSentinel, version: '1.0.0', secret: privateSentinel });

test('overview reads only repository manifests and allowlisted service properties', async () => {
  const paths = [], commands = [];
  const collect = createOverviewCollector({ projectRoot: '/fixture', system,
    read: async path => { paths.push(path); return read(path); },
    run: async (cmd, args, options) => {
      commands.push({ cmd, args, options });
      return { stdout: `LoadState=loaded\nActiveState=active\nEnvironment=${privateSentinel}` };
    } });
  const value = await collect();
  assert.deepEqual(paths.sort(), ['/fixture/package.json', '/fixture/vendor/pi-web-ui/package.json']);
  assert.equal(commands.length, 3);
  for (const command of commands) {
    assert.equal(command.cmd, 'systemctl');
    assert.deepEqual(command.args.slice(0, 4), ['--user', 'show', '--property=LoadState,ActiveState', '--']);
    assert.ok(command.options.timeout <= 3000);
    assert.equal(command.options.maxBuffer, 4096);
  }
  assert.equal(value.project.sdkVersion, '0.85.1');
  assert.equal(value.host.memoryFreeBytes, 0);
  assert.equal(value.host.uptimeSeconds, 0);
  assert.match(value.services[0].detail, /同时 active/);
  assert.equal(value.agents.find(agent => agent.id === 'pi').availability, 'bundled');
  assert.ok(value.agents.filter(agent => agent.id !== 'pi').every(agent => agent.availability === 'unverified'));
  assert.ok(value.agents.every(agent => agent.capabilities.channelSwitch === 'planned'));
  assert.ok(!JSON.stringify(value).includes(privateSentinel));
});

test('partial failure remains explicit and never exposes command errors or malformed metadata', async () => {
  const collect = createOverviewCollector({ system, read: async () => '{broken',
    run: async (_cmd, args) => {
      const unit = args.at(-1);
      if (unit === 'pi-dev-pm2.service') throw new Error(privateSentinel);
      return { stdout: unit === 'dev-con.service' ? 'LoadState=not-found\nActiveState=inactive'
        : `LoadState=loaded\nActiveState=${privateSentinel}` };
    } });
  const value = await collect();
  assert.deepEqual(value.services.map(service => service.status), ['unavailable', 'unknown', 'not-found']);
  assert.equal(value.project.version, null);
  assert.equal(value.project.sdkVersion, null);
  assert.ok(!JSON.stringify(value).includes(privateSentinel));
});

test('refresh bursts share one collection and expire with the displayed timestamp', async () => {
  let calls = 0, now = 1000;
  const collect = createOverviewCollector({ system, read, now: () => now,
    run: async () => { calls++; return { stdout: 'LoadState=loaded\nActiveState=inactive' }; } });
  const [first, second] = await Promise.all([collect(), collect()]);
  assert.equal(first, second);
  assert.equal(calls, 3);
  now = 2999;
  assert.equal(await collect(), first);
  now = 3000;
  const next = await collect();
  assert.equal(calls, 6);
  assert.notEqual(first.generatedAt, next.generatedAt);
});

test('transient collector failure does not poison subsequent refreshes', async () => {
  let fail = true;
  const collect = createOverviewCollector({ read, system: { ...system, cpus: () => {
    if (fail) throw new Error('fixture failure');
    return [];
  } }, run: async () => ({ stdout: 'LoadState=loaded\nActiveState=inactive' }) });
  await assert.rejects(collect());
  fail = false;
  assert.equal((await collect()).host.cpuCount, 0);
});
