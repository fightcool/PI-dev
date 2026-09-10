import { useCallback, useRef, useState, type DragEvent } from "react";
import { useT } from "../i18n";
import { fileToProcessedImage, isRasterImage, type ProcessedImage } from "../image-paste";
import type { AppConnection } from "./types";

/** @COUPLED App.tsx reexports PendingAttachment for ChatInput and AttachmentChips. */
export interface PendingAttachment {
	path: string;
	name: string;
	mode: "inline" | "reference" | "lines";
	/** Folder path link (always reference mode). */
	isDir?: boolean;
	/** 1-based inclusive line range (mode "lines" only). */
	lines?: { start: number; end: number };
	/** Raw pasted/dropped/uploaded image (no workspace path — `path` is ""). */
	imageData?: string;
	mimeType?: string;
	/** Raw uploaded file bytes (no workspace path — `path` is ""). */
	fileData?: string;
	size?: number;
	/** Stable dedupe/removal key for pasted images. */
	key?: string;
}

export function useAttachments(chat: AppConnection["chat"], pushNotice: AppConnection["pushNotice"]) {
	const t = useT();
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const [appDragOver, setAppDragOver] = useState(false);
	const attach = (
		path: string,
		name: string,
		mode: "inline" | "reference" | "lines",
		isDir = false,
		lines?: { start: number; end: number },
	) => {
		// Dedupe on path + mode + line range so the same file can be attached
		// multiple ways (e.g. full content AND a line range) without doubling.
		const key = `${path}|${mode}|${lines ? `${lines.start}-${lines.end}` : ""}`;
		setAttachments((prev) =>
			prev.some((a) => `${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}` === key)
				? prev
				: [...prev, { path, name, mode, isDir, ...(lines ? { lines } : {}) }],
		);
	};
	const removeAttachment = (pathOrKey: string) =>
		setAttachments((prev) => prev.filter((a) => (a.key ? a.key !== pathOrKey : a.path !== pathOrKey)));

	// -- pasted / dropped / uploaded images (no workspace path) ---------------
	const pasteImageId = useRef(0);
	const lastVisionWarn = useRef(0);
	const attachImage = (img: ProcessedImage) => {
		// Warn when the current model can't see images — the image would still
		// be attached but silently ignored by the provider. Throttled so adding
		// several images at once produces one notice, not a stack.
		const now = Date.now();
		if (chat.state?.model && !chat.state.model.vision) {
			if (now - lastVisionWarn.current > 10000) {
				lastVisionWarn.current = now;
				pushNotice("warning", t("imageNotSupported"));
			}
		}
		const key = `paste-${++pasteImageId.current}`;
		setAttachments((prev) => [
			...prev,
			{
				path: "",
				key,
				name: img.name,
				mode: "inline",
				imageData: img.data,
				mimeType: img.mimeType,
			},
		]);
	};
	const addImageFiles = async (files: File[]) => {
		for (const f of files) {
			const img = await fileToProcessedImage(f);
			if (!img) {
				pushNotice("error", t("imageLoadFailed", { name: f.name }));
				continue;
			}
			attachImage(img);
		}
	};

	// -- dropped / uploaded files (any type, no workspace path) ---------------
	/** Keep in sync with MAX_UPLOAD_BYTES in agent-service.ts. */
	const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
	const uploadId = useRef(0);
	const attachLocalFile = async (f: File) => {
		if (f.size > MAX_UPLOAD_BYTES) {
			pushNotice("warning", t("fileTooLarge", { name: f.name, size: MAX_UPLOAD_BYTES / 1024 / 1024 }));
			return;
		}
		let base64: string;
		try {
			const dataUrl = await new Promise<string>((res, rej) => {
				const r = new FileReader();
				r.onload = () => res(r.result as string);
				r.onerror = () => rej(r.error ?? new Error("read failed"));
				r.readAsDataURL(f);
			});
			base64 = dataUrl.replace(/^data:[^;]*;base64,/, "");
		} catch {
			pushNotice("error", t("fileLoadFailed", { name: f.name }));
			return;
		}
		const key = `upload-${++uploadId.current}`;
		setAttachments((prev) => [
			...prev,
			{
				path: "",
				key,
				name: f.name,
				mode: "inline",
				fileData: base64,
				size: f.size,
				mimeType: f.type || undefined,
			},
		]);
	};
	const addLocalFiles = async (files: File[]) => {
		for (const f of files) {
			// Raster images go through the resize/encode pipeline (vision content);
			// everything else — including SVG — is uploaded raw and attached by path.
			if (isRasterImage(f.type)) {
				await addImageFiles([f]);
			} else {
				await attachLocalFile(f);
			}
		}
	};

	const clearAttachments = useCallback(() => setAttachments([]), []);
	const removeAttachmentCb = useCallback(removeAttachment, []);
	const dropHandlers = {
		onDragOver: (e: DragEvent<HTMLDivElement>) => {
			if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
			e.preventDefault();
			setAppDragOver(true);
		},
		onDragLeave: (e: DragEvent<HTMLDivElement>) => {
			if (!e.currentTarget.contains(e.relatedTarget as Node)) setAppDragOver(false);
		},
		onDrop: (e: DragEvent<HTMLDivElement>) => {
			setAppDragOver(false);
			if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
			e.preventDefault();
			const files = Array.from(e.dataTransfer?.files ?? []);
			if (files.length === 0) {
				pushNotice("warning", t("foldersNotSupported"));
				return;
			}
			// Same split as ChatInput.handleFiles: raster images go through
			// the vision pipeline, everything else uploads as a raw file.
			const images = files.filter((f) => isRasterImage(f.type));
			const others = files.filter((f) => !isRasterImage(f.type));
			if (images.length > 0) void addImageFiles(images);
			if (others.length > 0) void addLocalFiles(others);
		},
	};
	return {
		attachments,
		attach,
		clearAttachments,
		removeAttachment: removeAttachmentCb,
		addImageFiles,
		addLocalFiles,
		appDragOver,
		dropHandlers,
	};
}
