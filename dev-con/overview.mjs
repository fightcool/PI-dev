/* 🍞 AI Breadcrumb Navigation — @COUPLED=consumers; @WHY=design intent.
 * @COUPLED dev-con/server.mjs, dev-con/agents.mjs, tests/dev-con-overview.test.mjs
 * @WHY Query fixed systemd properties only: no PM2 daemon creation or process environment reads.
 * 📖 docs/DEV-CON-IMPLEMENTATION.md
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem, loadavg, uptime, platform, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { agentInventory } from './agents.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const definitions = Object.freeze([
  { id: 'pi-production', name: 'Pi 正式服务管理器', manager: 'PM2 / systemd --user', unit: 'pi-dev-pm2.service' },
  { id: 'pi-legacy', name: 'Pi 旧服务管理器', manager: 'systemd --user', unit: 'pi-web-ui-dev.service' },
  { id: 'dev-con', name: 'DEV-CON 用户服务', manager: 'systemd --user', unit: 'dev-con.service' },
]);
const states = new Set(['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading', 'refreshing']);

async function serviceStatus(definition, run) {
  try {
    const { stdout } = await run('systemctl', ['--user', 'show',
      '--property=LoadState,ActiveState', '--', definition.unit],
    { encoding: 'utf8', timeout: 2500, maxBuffer: 4096, windowsHide: true });
    const fields = Object.fromEntries(stdout.trim().split('\n').map(line => line.split('=')));
    if (fields.LoadState === 'not-found')
      return { ...definition, status: 'not-found', detail: '未找到该用户服务单元；不能据此判断应用是否在其他方式下运行。' };
    if (!['loaded', 'masked'].includes(fields.LoadState) || !states.has(fields.ActiveState))
      return { ...definition, status: 'unknown', detail: '返回状态无法识别。' };
    return { ...definition, status: ['reloading', 'refreshing'].includes(fields.ActiveState) ? 'activating' : fields.ActiveState,
      detail: fields.LoadState === 'masked' ? '服务单元已屏蔽。' : '仅表示管理单元状态；应用、WebSocket 和模型可用性尚未验证。' };
  } catch {
    // @CONTRACT Command stderr and exceptions may contain private environment details.
    return { ...definition, status: 'unavailable', detail: '无法查询用户服务；可能未安装 systemd、用户总线不可用或查询超时。' };
  }
}

const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value) ? value : null;

async function projectInfo(projectRoot, read) {
  const results = await Promise.allSettled([
    read(join(projectRoot, 'package.json'), 'utf8'),
    read(join(projectRoot, 'vendor/pi-web-ui/package.json'), 'utf8'),
  ]);
  const parse = result => {
    try { return result.status === 'fulfilled' ? JSON.parse(result.value) : {}; } catch { return {}; }
  };
  const project = parse(results[0]), ui = parse(results[1]);
  return { name: 'PI-dev', version: version(project?.version), node: process.version,
    uiVersion: version(ui?.version), sdkVersion: version(ui?.dependencies?.['@earendil-works/pi-coding-agent']) };
}

export function createOverviewCollector({ projectRoot = root, run = execute, read = readFile,
  now = Date.now, system = { cpus, freemem, totalmem, loadavg, uptime, platform, arch } } = {}) {
  let pending, cached, completedAt = 0;
  return async function collect() {
    // @MAGIC 2000ms coalesces refresh bursts across clients; generatedAt exposes sample age.
    if (cached && now() - completedAt < 2000) return cached;
    if (pending) return pending;
    pending = (async () => {
      const [project, services] = await Promise.all([
        projectInfo(projectRoot, read), Promise.all(definitions.map(definition => serviceStatus(definition, run))),
      ]);
      if (services[0].status === 'active' && services[1].status === 'active') {
        services[0].detail = services[1].detail = '检测到新旧管理器同时 active，请核查是否重复托管同一实例。';
      }
      cached = { generatedAt: new Date(now()).toISOString(), project,
        host: { platform: system.platform(), arch: system.arch(), cpuCount: system.cpus().length,
          loadAverage: system.loadavg(), memoryTotalBytes: system.totalmem(), memoryFreeBytes: system.freemem(),
          uptimeSeconds: system.uptime() }, services, agents: agentInventory(project.sdkVersion) };
      completedAt = now();
      return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}

export const collectOverview = createOverviewCollector();
