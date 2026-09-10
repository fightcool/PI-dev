/*
 * 🍞 AI Breadcrumb: bounded streaming Markdown work before segmentation/parsing.
 * @COUPLED stream-markdown.ts, Message.tsx, Markdown.tsx
 * @WHY Token events update the latest text immediately, but expensive rendering
 * runs at most every 100ms with a trailing flush. Final messages use Markdown.
 */
import { memo, useEffect, useRef, useState } from "react";
import { segmentStream } from "../stream-markdown";
import { MarkdownBody } from "./Markdown";

const RENDER_INTERVAL_MS = 100;

const FrozenSegment = memo(function FrozenSegment({ text }: { text: string }) {
	return <MarkdownBody text={text} />;
});

// This boundary must sit BEFORE segmentStream, not only around the tail text.
// Unchanged sampled text skips both segmentation and MarkdownBody rendering.
const SampledMarkdown = memo(function SampledMarkdown({ text }: { text: string }) {
	const { frozen, active, inFence } = segmentStream(text);
	return (
		<div className="md">
			{frozen.map((segment, index) => (
				<FrozenSegment key={index} text={segment} />
			))}
			{active.length > 0 &&
				(inFence ? (
					<div className="codeblock">
						<pre>
							<code>{active}</code>
						</pre>
					</div>
				) : (
					<MarkdownBody text={active} />
				))}
		</div>
	);
});

export const StreamMarkdown = memo(function StreamMarkdown({ text }: { text: string }) {
	const [sample, setSample] = useState(text);
	const latest = useRef(text);
	const flushedAt = useRef(Date.now());
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		latest.current = text;
		if (timer.current !== null) return;
		const delay = Math.max(0, RENDER_INTERVAL_MS - (Date.now() - flushedAt.current));
		const flush = () => {
			timer.current = null;
			flushedAt.current = Date.now();
			setSample(latest.current);
		};
		if (delay === 0) flush();
		else timer.current = setTimeout(flush, delay);
	}, [text]);
	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
			timer.current = null;
		},
		[],
	);
	return <SampledMarkdown text={sample} />;
});
