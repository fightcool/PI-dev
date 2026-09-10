/* 🍞 AI Breadcrumb Navigation — @COUPLED=fixture runner; @WHY=benchmark contract.
 * @COUPLED ../message-list-window-test.mjs
 * @WHY Ordinary text matches /tmp/pi-dev-assessment-RVKs1k/synthetic.cjs;
 * the assessment is read-only and is not a runtime dependency of this test.
 */
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../../web/src/i18n";
import { MessageList } from "../../web/src/components/MessageList";
import type { PromptAttachment, UiMessage, UiState } from "../../web/src/types";

const paragraph = "Synthetic performance assessment paragraph with ordinary text and **bold** emphasis.\n\n".repeat(12);
const message = (i: number): UiMessage => ({
	id: `assessment-${i}`,
	role: i % 2 ? "assistant" : "user",
	content: [{ type: "text", text: `Message ${i}\n\n${paragraph}` }],
	timestamp: 1700000000000 + i,
});
const snapshot = (count: number): UiState => ({
	clientId: "fixture",
	cwd: "/synthetic",
	sessionId: "fixture",
	conversationId: "fixture",
	rev: 1,
	messages: Array.from({ length: count }, (_, i) => message(i)),
	streamingMessage: null,
	isStreaming: false,
	model: null,
	thinkingLevel: "off",
	availableThinkingLevels: [],
	queue: { steering: [], followUp: [] },
	tools: [],
	version: 1,
	piConfigured: true,
	piAgentInstalled: true,
	stats: {
		totalMessages: count,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
		contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 },
	},
});
type Edit = { id: string; text: string; attachments?: PromptAttachment[] };
interface FixtureApi {
	reset(count?: number): void;
	append(): void;
	stream(chunks: number): void;
	finish(): void;
	edits: Edit[];
	ready: boolean;
	startedAt: number;
}
declare global {
	interface Window {
		messageListFixture: FixtureApi;
	}
}
const api: FixtureApi = (window.messageListFixture = {
	reset: () => {},
	append: () => {},
	stream: () => {},
	finish: () => {},
	edits: [],
	ready: false,
	startedAt: performance.now(),
});
const empty = new Map();
function Fixture() {
	const [state, setState] = useState(() => snapshot(1000));
	const [generation, setGeneration] = useState(0);
	useLayoutEffect(() => {
		api.ready = true;
		api.reset = (count = 1000) => {
			api.startedAt = performance.now();
			api.edits = [];
			setState(snapshot(count));
			setGeneration((n) => n + 1);
		};
		api.append = () => setState((old) => ({ ...old, messages: [...old.messages, message(old.messages.length)] }));
		api.stream = (chunks) =>
			setState((old) => ({
				...old,
				isStreaming: true,
				streamingMessage: {
					id: "fixture-stream",
					role: "assistant",
					timestamp: 1700001000000,
					content: [{ type: "text", text: `Stream chunk ${chunks}\n\n${paragraph.repeat(chunks)}` }],
				},
			}));
		api.finish = () =>
			setState((old) => ({
				...old,
				isStreaming: false,
				streamingMessage: null,
				messages: old.streamingMessage ? [...old.messages, old.streamingMessage] : old.messages,
			}));
	}, []);
	return (
		<MessageList
			key={generation}
			state={state}
			liveOutputs={empty}
			toolStatuses={empty}
			onEdit={(id, text, attachments) => api.edits.push({ id, text, attachments })}
		/>
	);
}
createRoot(document.getElementById("root")!).render(
	<LanguageProvider>
		<Fixture />
	</LanguageProvider>,
);
