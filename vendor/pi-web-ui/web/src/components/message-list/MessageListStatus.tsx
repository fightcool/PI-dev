/*
 * 🍞 AI Breadcrumb Navigation — @COUPLED=caller.
 * @COUPLED ../MessageList.tsx
 * @WHY Keep queue and progress UI independent of persisted row windowing.
 */
import { useEffect, useState } from "react";
import type { UiState } from "../../types";
import { useT } from "../../i18n";

function CompactionBanner({ compaction }: { compaction: NonNullable<UiState["compaction"]> }) {
	const t = useT();
	const [, setTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, []);
	const elapsed = Math.max(0, Math.floor((Date.now() - compaction.startedAt) / 1000));
	const reason =
		compaction.reason === "manual"
			? t("compactingReasonManual")
			: compaction.reason === "overflow"
				? t("compactingReasonOverflow")
				: t("compactingReasonThreshold");
	return (
		<div className="compact-notice" role="status">
			<span className="compact-pulse" />
			<span className="compact-text">
				{t("compactingContext")} · {elapsed}s
			</span>
			<span className="compact-reason">{reason}</span>
		</div>
	);
}

export function MessageListStatus({
	state,
	onRemoveQueued,
}: {
	state: UiState;
	onRemoveQueued?: (kind: "steer" | "followUp", text: string) => void;
}) {
	const t = useT();
	return (
		<>
			{state.retry && state.isStreaming && (
				<div className="retry-notice" role="status" title={state.retry.errorMessage || undefined}>
					<span className="retry-pulse" />
					<span className="retry-text">
						{state.retry.maxAttempts > 0
							? t("retryingApi", {
									attempt: Math.max(1, state.retry.attempt),
									max: state.retry.maxAttempts,
									error: state.retry.errorMessage,
								})
							: t("retryingApiSoon", { error: state.retry.errorMessage })}
					</span>
				</div>
			)}
			{state.compaction && <CompactionBanner compaction={state.compaction} />}
			{state.isStreaming && !state.messages.length && !state.streamingMessage && (
				<div className="streaming-wait">{t("waitingResponse")}</div>
			)}
			{(["steer", "followUp"] as const).map((kind) =>
				(kind === "steer" ? state.queue.steering : state.queue.followUp).map((text, i) => (
					<div className="queued-msg" key={`${kind}-${i}`}>
						<div className="queued-bubble">
							<span className={`queued-tag ${kind === "steer" ? "steer" : "follow"}`}>
								{t(kind === "steer" ? "queueSteerTag" : "queueFollowTag")}
							</span>
							<div className="queued-text">{text}</div>
							{onRemoveQueued && (
								<button
									type="button"
									className="queued-remove"
									title={t("queueRemoveTip")}
									onClick={() => onRemoveQueued(kind, text)}
								>
									✕
								</button>
							)}
						</div>
					</div>
				)),
			)}
		</>
	);
}
