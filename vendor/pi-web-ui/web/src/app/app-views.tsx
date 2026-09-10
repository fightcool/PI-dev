import { lazy, Suspense } from "react";
import { PluginView } from "../components/PluginView";
import type { AppConnection } from "./types";
import type { useAppViews } from "./use-app-views";

const TerminalPanel = lazy(() => import("../components/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
const ScmPanel = lazy(() => import("../components/SCMPanel").then((m) => ({ default: m.ScmPanel })));

/** @CONTRACT Never render a lazy component before access; retain it when hidden. */
export function AppViews({
	connection,
	views,
	terminalSend,
	onSwitchToTerminal,
}: {
	connection: AppConnection;
	views: ReturnType<typeof useAppViews>;
	terminalSend: AppConnection["send"];
	onSwitchToTerminal: () => void;
}) {
	const { chat, send, terminal } = connection;
	const { view, terminalVisited, gitVisited, pluginViews } = views;
	return (
		<>
			{terminalVisited && (
				<div className={`view-pane ${view === "terminal" ? "" : "hidden"}`}>
					<Suspense fallback={null}>
						<TerminalPanel chat={chat} send={terminalSend} terminal={terminal} />
					</Suspense>
				</div>
			)}
			{gitVisited && (
				<div className={`view-pane ${view === "git" ? "" : "hidden"}`}>
					<Suspense fallback={null}>
						<ScmPanel
							chat={chat}
							send={send}
							terminal={terminal}
							active={view === "git"}
							onSwitchToTerminal={onSwitchToTerminal}
						/>
					</Suspense>
				</div>
			)}
			{pluginViews.map((entry) => (
				<div key={entry.info.id} className={`view-pane ${view === `plugin:${entry.info.id}` ? "" : "hidden"}`}>
					<PluginView entry={entry} send={send} />
				</div>
			))}
		</>
	);
}
