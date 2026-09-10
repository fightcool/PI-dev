import { useEffect, useRef, useState } from "react";
import { useT, useI18n } from "../i18n";
import { QUICK_PHRASE_DEFAULTS } from "../quick-phrases";
import { projectNameFromCwd, useProjectTitle } from "../title-settings";
import { loadSoundSettings, playSound, saveSoundSettings, type SoundSettings } from "../sounds";
import { notify } from "../notify";
import { useTheme } from "../theme";
import { useWallpaperEffect } from "../wallpaper";
import type { AppConnection } from "./types";

export function useAppEffects(chat: AppConnection["chat"], send: AppConnection["send"]) {
	const t = useT();
	const { locale } = useI18n();
	// 快捷短语 seeding：首次看到空列表 → 按界面语言填一批内置常用短语，之后即为用户
	// 数据（增删改/恢复默认/关闭都在设置里）。「已 seed」标记存服务端全局
	// （settings.quickPhrasesSeeded，非浏览器 localStorage）——clientId 在
	// sessionStorage、每次新会话都是新 id，若按浏览器记 seed，重启后删掉的默认
	// 短语又会被填回默认；存服务端则跨会话/跨浏览器一致。
	const quickSeedRef = useRef(false);
	useEffect(() => {
		if (!chat.ready || !chat.settings) return;
		if (quickSeedRef.current || chat.settings.quickPhrasesSeeded) return;
		quickSeedRef.current = true;
		if (chat.settings.quickPhrases.length === 0) {
			send({
				type: "set_settings",
				quickPhrases: QUICK_PHRASE_DEFAULTS[locale] ?? QUICK_PHRASE_DEFAULTS.en,
				quickPhrasesSeeded: true,
			});
		}
	}, [chat.ready, chat.settings, send, locale]);
	// 浏览器标题：开关开启时显示当前项目（工作目录文件夹名），否则固定应用名。
	const cwd = chat.state?.cwd ?? "";
	const projectTitle = useProjectTitle();
	useEffect(() => {
		const name = projectTitle ? projectNameFromCwd(cwd) : "";
		document.title = name ? `${name} — pi-web-ui` : t("docTitle");
	}, [cwd, projectTitle, t]);
	// -- sound notifications --------------------------------------------------
	const [sound, setSound] = useState<SoundSettings>(loadSoundSettings);
	// -- theme (whole stylesheet swap) ---------------------------------------
	const { themes, theme, switchTheme } = useTheme();
	// -- chat wallpaper (message-list background image, issue #100) -------------
	useWallpaperEffect();
	const prevStreaming = useRef<boolean | null>(null);
	const prevDialogId = useRef<number | null>(null);
	const lastErrorNotice = useRef(0);
	// Previous terminal list — drives the uninstall-finished watcher below.
	const prevTerminalsRef = useRef(chat.terminals);

	useEffect(() => {
		saveSoundSettings(sound);
	}, [sound]);

	// Maintenance watcher: when a `pi remove …` / `pi-web-ui install|uninstall …`
	// command tab transitions running → exited, re-discover extensions/skills
	// (extensions_reload) or re-scan the UI-plugin dir (plugins_reload).
	useEffect(() => {
		const prev = prevTerminalsRef.current;
		prevTerminalsRef.current = chat.terminals;
		for (const tm of chat.terminals) {
			const cmd = tm.command?.command ?? "";
			const before = prev.find((p) => p.id === tm.id);
			if (!before?.running || tm.running) continue;
			if (cmd.startsWith("pi remove ")) {
				send({ type: "extensions_reload" });
			} else if (cmd.startsWith("pi-web-ui install ") || cmd.startsWith("pi-web-ui uninstall ")) {
				send({ type: "plugins_reload" });
			} else if (cmd.startsWith("npm i -g ")) {
				// A component update ran in the visible terminal (per-row "更新"
				// or "全部更新" buttons): re-discover extensions + UI plugins and
				// re-check versions so the dropdown reflects the new state.
				send({ type: "extensions_reload" });
				send({ type: "plugins_reload" });
				send({ type: "check_updates_all", force: true });
			}
		}
	}, [chat.terminals, send]);

	// Run start / end cues (streaming edge transitions).
	useEffect(() => {
		const streaming = chat.state?.isStreaming ?? false;
		const prev = prevStreaming.current;
		prevStreaming.current = streaming;
		if (prev === null) return; // first observation — don't cue
		if (!prev && streaming) playSound("start", sound);
		else if (prev && !streaming) {
			playSound("done", sound);
			// OS/PWA notification for when the user stepped away (not focused).
			void notify(t("notifyDoneTitle"), t("notifyDoneBody"));
		}
	}, [chat.state?.isStreaming, sound]);

	// Questionnaire cue — each new dialog id.
	useEffect(() => {
		const id = chat.dialog?.id ?? null;
		if (id !== null && id !== prevDialogId.current) {
			playSound("question", sound);
			void notify(t("notifyQuestionTitle"), t("notifyQuestionBody"));
		}
		prevDialogId.current = id;
	}, [chat.dialog, sound]);

	// Error cue — new error notices only.
	useEffect(() => {
		const err = [...chat.notices].reverse().find((n) => n.level === "error");
		if (err && err.id !== lastErrorNotice.current) {
			lastErrorNotice.current = err.id;
			playSound("error", sound);
			void notify(t("notifyErrorTitle"), t("notifyErrorBody"));
		}
	}, [chat.notices, sound]);

	return { sound, setSound, themes, theme, switchTheme };
}
