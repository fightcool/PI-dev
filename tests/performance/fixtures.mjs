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
      ...channelStateMsg,
    ];
    case 'list_channels': return channelStateMsg;
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
    case 'list_sessions': return [{ type: 'sessions', sessions: [] }];
    case 'list_projects': return [{ type: 'projects', projects: [] }];
    case 'list_conversations': return [{ type: 'conversations', conversations: [], activeId: 'assessment' }];
    case 'ping': return [{ type: 'pong' }];
    default: return [];
  }
}
