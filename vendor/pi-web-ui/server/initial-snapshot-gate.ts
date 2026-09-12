/**
 * @COUPLED index.ts hello/get_state/send; web/src/use-chat.ts ready handling.
 * @GOTCHA Gate only the new socket: existing tabs must keep receiving revisions.
 * @WHY 新 socket 的第一条快照必须是全量——attach 注册 sink 与 hello 处理之间，
 *      别的标签页的活动可能已经推了增量；增量没有基线可挂，客户端只能丢弃后重取。
 *      因此这里只做「基线之前不发快照」这一件事，不参与插件顺序：插件目录到达
 *      晚于快照是安全的（web/src/plugin-fence.ts 在清单一到时重试未命中的围栏）。
 * @PERF 插件激活曾把首份快照挡在后面（最长 5s 兜底），是本页白屏的主因；
 *      现在 hello 里同步开闸，插件激活只影响围栏渲染器，不再影响对话内容。
 * See ../docs/architecture-core.md for snapshot resync and plugin ordering.
 */
export class InitialSnapshotGate {
	private initialized = false;

	/** Coalesce startup get_state requests into the promised initial full state. */
	get canSendSnapshot(): boolean {
		return this.initialized;
	}

	/** Open before flushing so the initial full snapshot reaches this socket. */
	complete(flushFull: () => void): void {
		if (this.initialized) return;
		this.initialized = true;
		flushFull();
	}
}
