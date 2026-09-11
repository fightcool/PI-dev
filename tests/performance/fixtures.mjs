/* 🍞 AI Breadcrumb Navigation — @COUPLED=callers; @CONTRACT=fixture schema.
 * @COUPLED tests/performance/isolation.mjs, tests/performance/scenarios.mjs
 * @CONTRACT Only deterministic synthetic text; never load sessions or credentials.
 * 📖 tests/performance/README.md
 */
export const pluginId = 'performance-fixture';
export const searchTerm = 'PERF_OLD_NEEDLE';
export const messageId = index => `assessment-${index}`;
export const plugin = { id: pluginId, name: 'Performance Fixture', version: '1.0.0',
  description: 'Synthetic local view', hasClient: true, view: true, renderers: [] };
export const pluginModule = `export default { mount(container) {
  const node = document.createElement('div');
  node.dataset.performancePlugin = 'ready';
  node.textContent = 'Synthetic plugin ready';
  container.append(node);
  return () => node.remove();
} };`;

export function snapshot(count) {
  const paragraph = 'Synthetic performance paragraph with ordinary text and **bold** emphasis.\n\n'.repeat(12);
  return {
    clientId: 'assessment', cwd: '/synthetic', sessionId: 'assessment',
    conversationId: 'assessment', sessionFile: '/synthetic/session.jsonl', rev: 1,
    messages: Array.from({ length: count }, (_, index) => ({
      id: messageId(index), role: index % 2 ? 'assistant' : 'user',
      content: [{ type: 'text', text: `Message ${index}\n\n${paragraph}${index === 0 || index === 2 ? searchTerm : ''}` }],
      timestamp: 1700000000000 + index,
    })),
    streamingMessage: null, isStreaming: false, model: null, thinkingLevel: 'off',
    availableThinkingLevels: [], queue: { steering: [], followUp: [] }, tools: [],
    version: 1, piConfigured: true, piAgentInstalled: true,
    stats: { totalMessages: count, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0, contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 } },
  };
}

/**
 * Minimal but complete settings fixture (the settings modal returns null without
 * it). Only list/string fields the panel dereferences unconditionally are filled;
 * everything else is an empty/off default so the panel renders without errors.
 */
export function settingsFixture() {
  return {
    promptMode: 'append', customSystemPrompt: '', promptTemplate: '', promptOverrides: {},
    disabledSkills: [], disabledExtensions: [], disabledPlugins: [], disabledMarkers: [],
    terminalToolsEnabled: true, terminalBash: false, terminalBashIdleMs: 0,
    editSoftEnabled: false, questionnaireEnabled: true, goalModeEnabled: true,
    thinkingWrap: true, toolsWrap: true,
    visionBridgeEnabled: true, visionBridgeModel: null, visionBridgePromptMode: 'append', visionBridgePrompt: '',
    reviewPrompt: '', reviewDisabledSkills: [], reviewSkills: [],
    effectiveSystemPrompt: '', promptSourceDefaults: {}, promptTokens: [],
    skills: [], extensions: [], markers: [], markersEnabled: {}, toolsSchema: [],
    presets: [], quickPhrases: [], quickPhrasesEnabled: false, retryMaxAttempts: 3,
    subagentDefaultModel: null, subagentModels: [], subagentTemplates: [], subagentDefaultTemplates: {},
  };
}

export function socketReply(message, state) {
  // DEV-CON channel fixtures are opt-in: only a state carrying channelState gets
  // channel replies, so the performance scenarios (which never set it) keep the
  // exact same traffic profile.
  const channels = state?.channelState;
  const channelStateMsg = channels ? [{ type: 'channel_state', ...channels }] : [];
  switch (message.type) {
    case 'hello': return [
      { type: 'ready', serverVersion: 'synthetic', managed: true, engine: 'pi' },
      { type: 'plugins', plugins: [plugin], epoch: 1 },
      { type: 'snapshot', state },
      { type: 'settings_state', settings: state?.settingsState ?? settingsFixture() },
      ...channelStateMsg,
    ];
    case 'list_channels': return channelStateMsg;
    case 'list_resources':
      return [{
        type: 'resources', reqId: message.reqId, ok: true,
        snapshot: {
          at: 1700000000000,
          host: { hostname: 'synthetic-host', platform: 'linux', uptimeSec: 90061, cpuCount: 4, loadAvg: [0.5, 0.4, 0.3], cpuPercent: 12.5,
            mem: { totalBytes: 8 * 1024 ** 3, usedBytes: 3 * 1024 ** 3, availableBytes: 5 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3, swapUsedBytes: 1024 ** 3 } },
          app: { pid: 4242, node: 'v22.19.0', uptimeSec: 3600, rssBytes: 120 * 1024 ** 2, heapUsedBytes: 60 * 1024 ** 2, heapTotalBytes: 80 * 1024 ** 2, externalBytes: 4 * 1024 ** 2,
            cgroup: { currentBytes: 400 * 1024 ** 2, maxBytes: 4 * 1024 ** 3, highBytes: 3 * 1024 ** 3 } },
          disks: [{ path: '/synthetic', label: 'workspace', totalBytes: 40 * 1024 ** 3, freeBytes: 8 * 1024 ** 3, usedBytes: 32 * 1024 ** 3, usedPercent: 80 }],
          sources: { cpu: 'proc-stat', mem: 'proc-meminfo', disk: 'statfs', cgroup: 'cgroup-v2' },
          warnings: [],
        },
      }];
    case 'usage_history_query':
      return [{
        type: 'usage_history', reqId: message.reqId, ok: true, groupBy: message.groupBy,
        from: message.from ?? null, to: message.to ?? null,
        rows: [
          { key: 'ch-a', requests: 2, input: 90, output: 38, cacheRead: 20, cacheWrite: 5, total: 153, cost: 0.03, unpricedRequests: 0, firstAt: 1700000000000, lastAt: 1700000005000 },
          { key: 'unattributed', requests: 1, input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12, cost: 0, unpricedRequests: 1, firstAt: 1700000006000, lastAt: 1700000006000 },
        ],
        totals: { requests: 3, input: 100, output: 40, cacheRead: 20, cacheWrite: 5, total: 165, cost: 0.03, unpricedRequests: 1 },
        scanned: 3, skipped: 0, truncated: false,
      }];
    case 'list_provider_keys': return channels ? [{ type: 'provider_keys', keys: state.providerKeys ?? {} }] : [];
    case 'channel_select':
    case 'channel_binding_clear':
    case 'channel_save':
    case 'channel_delete':
    case 'channel_set_default':
    case 'channel_query_account': {
      if (!channels) return [];
      const ok = !message.modelId || message.modelId.startsWith('main/');
      return [{ type: 'channel_command_result', commandId: message.commandId, ok, phase: ok ? 'applied' : 'rejected',
        conversationId: message.conversationId ?? state.conversationId,
        channelId: message.channelId, error: ok ? undefined : 'synthetic rejection',
        configRevision: channels.configRevision, bindingRevision: channels.bindingRevision }];
    }
    // Older baseline bundles explicitly ask after ready; resync remains supported.
    case 'get_state': return [{ type: 'snapshot', state }];
    case 'list_models': return [{ type: 'models', models: state?.models ?? [] }];
    case 'list_files': return [{ type: 'files', cwd: '/synthetic', files: [] }];
    case 'list_commands': return [{ type: 'slash_commands', commands: [] }];
    case 'get_commands': return [{ type: 'commands', commands: [], path: '/synthetic/commands.json' }];
    case 'get_settings': return [{ type: 'settings_state', settings: state?.settingsState ?? settingsFixture() }];
    case 'list_subagent_templates': return [];
    case 'list_sessions': return [{ type: 'sessions', sessions: [] }];
    case 'list_projects': return [{ type: 'projects', projects: [] }];
    case 'list_conversations': return [{ type: 'conversations', conversations: [], activeId: 'assessment' }];
    case 'ping': return [{ type: 'pong' }];
    default: return [];
  }
}
