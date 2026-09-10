/* 🍞 AI Breadcrumb Navigation — @COUPLED=linked files; @WHY=design intent; @MAGIC=constant; 📖=design reference.
 * @COUPLED dev-con/web/index.html, dev-con/web/style.css, tests/dev-con-browser.mjs
 * 📖 docs/DEV-CON-IMPLEMENTATION.md (maintained by the coordinating agent)
 * @WHY Session generations reject late responses even if cancellation races with completion.
 * @BUGFIX 2026-09-10 Refresh CSRF from the current cookie session before logout after another tab logs in.
 * @MAGIC 10000 = request deadline in milliseconds, including reading the response body.
 */
'use strict';
const $ = id => document.getElementById(id);
const pending = new Set();
let generation = 0, authenticated = false, csrfToken = '', refreshing = false, formBusy = true;
let generatedAt = '';
const states = {
  active: '活动', inactive: '未活动', failed: '失败', activating: '启动中',
  deactivating: '停止中', unavailable: '无法获取', unknown: '未知', 'not-found': '未找到单元',
};
const capabilities = { available: '可用', planned: '规划中', unsupported: '不支持' };
const lookup = (map, key) => Object.hasOwn(map, key) ? map[key] : '未知';
function message(text, kind = 'info') {
  $('feedback').textContent = text;
  $('feedback').dataset.kind = kind;
}
function formState(busy) {
  formBusy = busy;
  $('login-form').setAttribute('aria-busy', String(busy));
  $('password').disabled = busy;
  $('login-submit').disabled = busy;
  $('login-submit').textContent = busy ? '请稍候…' : '登录';
}
function clearSession(text, busy = false) {
  generation++;
  for (const controller of pending) controller.abort();
  pending.clear();
  authenticated = false;
  csrfToken = '';
  refreshing = false;
  generatedAt = '';
  $('password').value = '';
  $('password').removeAttribute('aria-invalid');
  $('login-error').textContent = '';
  for (const id of ['service-rows', 'agent-rows', 'host-details', 'project-details']) $(id).replaceChildren();
  $('snapshot').textContent = '尚未取得环境快照。';
  $('snapshot').dataset.stale = 'false';
  $('data').setAttribute('aria-busy', 'false');
  $('refresh').disabled = false;
  $('refresh').textContent = '刷新总览';
  $('workspace').hidden = true;
  $('logout').hidden = true;
  $('login-panel').hidden = false;
  formState(busy);
  message(text);
  if (!busy) $('password').focus();
}
async function request(path, options = {}) {
  const controller = new AbortController();
  pending.add(controller);
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`/api/v1/${path}`, {
      ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(response.status === 401 ? '登录已失效，请重新登录。' : '请求失败，请重试。');
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时，请重试。');
    if (error instanceof TypeError) throw new Error('无法连接控制台，请检查网络后重试。');
    throw error;
  } finally {
    clearTimeout(timer);
    pending.delete(controller);
  }
}
function openWorkspace(session) {
  if (session.authenticated !== true) throw new Error('会话未建立，请重新登录。');
  authenticated = true;
  csrfToken = session.csrfToken ?? '';
  $('password').value = '';
  $('login-panel').hidden = true;
  $('workspace').hidden = false;
  $('logout').hidden = false;
  $('logout').disabled = false;
  $('logout').textContent = '注销';
  $('refresh').focus();
  void refresh();
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text ?? '未提供');
  if (className) node.className = className;
  return node;
}
function identity(name, detail) {
  const node = element('div');
  node.append(element('span', name, 'cell-title'), element('span', detail, 'cell-sub'));
  return node;
}
function row(values, labels) {
  const node = element('tr');
  values.forEach((value, index) => {
    const cell = element('td');
    cell.dataset.label = labels[index];
    cell.append(value instanceof Node ? value : element('span', value));
    node.append(cell);
  });
  return node;
}
function details(entries) {
  const fragment = document.createDocumentFragment();
  for (const [label, value] of entries) {
    const pair = element('div');
    pair.append(element('dt', label), element('dd', value));
    fragment.append(pair);
  }
  return fragment;
}
const number = value => Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '未提供';
const bytes = value => Number.isFinite(value) ? `${number(value / 1073741824)} GiB` : '未提供';
function render(data) {
  if (!data?.project || !data.host || !Array.isArray(data.services) || !Array.isArray(data.agents)
    || typeof data.generatedAt !== 'string' || !Number.isFinite(Date.parse(data.generatedAt))) {
    throw new Error('总览数据格式无效，请重试。');
  }
  // @WHY Build all replacements before touching the displayed snapshot so failures retain it intact.
  const services = document.createDocumentFragment(), agents = document.createDocumentFragment();
  for (const service of data.services) {
    const badge = element('span', lookup(states, service.status), 'badge');
    badge.dataset.state = Object.hasOwn(states, service.status) ? service.status : 'unknown';
    services.append(row([service.name, identity(service.manager, service.unit), badge, service.detail],
      ['服务', '管理器 / 单元', '单元状态', '详情']));
  }
  for (const agent of data.agents) {
    const c = agent.capabilities;
    agents.append(row([identity(agent.name, agent.version == null ? '版本未核实' : `版本 ${agent.version}`),
      agent.availability === 'bundled' ? '仓库包含' : '未核实', lookup(capabilities, c.inventory),
      lookup(capabilities, c.channelSwitch), lookup(capabilities, c.skills), lookup(capabilities, c.mcp), agent.notes],
    ['Agent / 版本', '核实情况', '清单', '渠道切换', '技能', 'MCP', '说明']));
  }
  if (!data.services.length) services.append(row(['暂无服务记录'], ['服务']));
  if (!data.agents.length) agents.append(row(['暂无 Agent 记录'], ['Agent']));
  const h = data.host, p = data.project;
  const host = details([
    ['平台 / 架构', `${h.platform} / ${h.arch}`], ['逻辑 CPU', number(h.cpuCount)],
    ['负载（1 / 5 / 15 分钟）', h.loadAverage.length ? h.loadAverage.map(number).join(' / ') : '未提供'],
    ['内存总量', bytes(h.memoryTotalBytes)], ['空闲内存', bytes(h.memoryFreeBytes)],
    ['主机运行时长', Number.isFinite(h.uptimeSeconds) ? `${number(h.uptimeSeconds / 3600)} 小时` : '未提供'],
  ]);
  const project = details([['项目', p.name], ['项目版本', p.version], ['Node.js', p.node],
    ['UI 版本', p.uiVersion], ['SDK 版本', p.sdkVersion]]);
  $('service-rows').replaceChildren(services);
  $('agent-rows').replaceChildren(agents);
  $('host-details').replaceChildren(host);
  $('project-details').replaceChildren(project);
  generatedAt = data.generatedAt;
  $('snapshot').textContent = `数据生成时间：${generatedAt}（按需采样）`;
  $('snapshot').dataset.stale = 'false';
}
async function refresh() {
  if (!authenticated || refreshing) return;
  const current = generation;
  refreshing = true;
  $('refresh').disabled = true;
  $('refresh').textContent = '正在刷新…';
  $('data').setAttribute('aria-busy', 'true');
  message('正在读取环境总览…');
  try {
    const data = await request('overview');
    if (current !== generation) return;
    render(data);
    message('总览已更新。服务状态与 Agent 能力的解释见各分区说明。');
  } catch (error) {
    if (current !== generation) return;
    if (error.status === 401) { clearSession('登录已失效，请重新登录。'); return; }
    message(`${error.message}${generatedAt ? ' 当前保留上次成功读取的旧数据。' : ' 尚无可显示的数据，请刷新重试。'}`, 'error');
    if (generatedAt) {
      $('snapshot').textContent = `旧数据 · 数据生成时间：${generatedAt}；本次刷新失败。`;
      $('snapshot').dataset.stale = 'true';
    }
  } finally {
    if (current === generation) {
      refreshing = false;
      $('refresh').disabled = false;
      $('refresh').textContent = '刷新总览';
      $('data').setAttribute('aria-busy', 'false');
    }
  }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (formBusy) return;
  const current = generation;
  const body = JSON.stringify({ password: $('password').value });
  $('password').value = '';
  $('password').removeAttribute('aria-invalid');
  $('login-error').textContent = '';
  formState(true);
  message('正在登录…');
  try {
    const session = await request('auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (current === generation) openWorkspace(session);
  } catch (error) {
    if (current !== generation) return;
    $('login-error').textContent = error.status === 401 ? '密码不正确或登录未获授权，请重新输入。' : error.message;
    $('password').setAttribute('aria-invalid', 'true');
    message('登录未完成，请查看表单提示。', 'error');
  } finally {
    if (current === generation) {
      formState(false);
      if (!authenticated) $('password').focus();
    }
  }
});
$('refresh').addEventListener('click', refresh);
$('logout').addEventListener('click', async () => {
  let token = csrfToken;
  clearSession('正在注销，已清除本页环境信息…', true);
  const current = generation;
  try {
    const session = await request('auth/session');
    if (!session.authenticated) { clearSession('会话已失效，已清除本页环境信息。'); return; }
    token = session.csrfToken;
    if (!token) throw new Error('无法取得注销凭据，请重试注销。');
    await request('auth/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': token }, body: '{}',
    });
    if (current === generation) clearSession('已注销。');
  } catch (error) {
    if (current !== generation) return;
    if (error.status === 401) { clearSession('会话已失效，已清除本页环境信息。'); return; }
    csrfToken = token;
    formState(false);
    $('logout').hidden = false;
    $('logout').textContent = '重试注销';
    message(`${error.message} 本页内容已清除，但服务器注销尚未确认，请重试注销。`, 'error');
    $('logout').focus();
  }
});
async function start() {
  const current = generation;
  try {
    const session = await request('auth/session');
    if (current !== generation) return;
    if (session.authenticated) openWorkspace(session);
    else clearSession('请登录后查看环境总览。');
  } catch (error) {
    if (current === generation) clearSession(error.message);
  } finally {
    if (current === generation) formState(false);
  }
}
void start();
