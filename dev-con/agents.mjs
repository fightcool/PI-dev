/* 🍞 AI Breadcrumb Navigation — @COUPLED=consumers; @CONTRACT=boundary.
 * @COUPLED dev-con/overview.mjs, dev-con/web/app.js, tests/dev-con-overview.test.mjs
 * @CONTRACT Registration describes support, never installation or live configuration.
 * 📖 docs/DEV-CON-IMPLEMENTATION.md
 */
const planned = Object.freeze({ inventory: 'planned', channelSwitch: 'planned', skills: 'planned', mcp: 'planned' });

// @WHY Keep explicit capability states until real, fixture-tested adapters exist.
export function agentInventory(sdkVersion) {
  return [
    { id: 'pi', name: 'Pi Agent', availability: 'bundled', version: sdkVersion,
      capabilities: { ...planned, inventory: 'available' },
      notes: '版本来自仓库依赖声明；运行实例、渠道与模型尚未核实。' },
    { id: 'claude', name: 'Claude Code / happy', availability: 'unverified', version: null,
      capabilities: { ...planned }, notes: '已预留适配器；happy 跟随 Claude 配置，安装及运行情况尚未核实。' },
    { id: 'codex', name: 'Codex CLI', availability: 'unverified', version: null,
      capabilities: { ...planned }, notes: '已预留适配器；尚未读取本机配置或检测安装。' },
    { id: 'gemini', name: 'Gemini CLI', availability: 'unverified', version: null,
      capabilities: { ...planned }, notes: '已预留适配器；尚未读取本机配置或检测安装。' },
  ];
}
