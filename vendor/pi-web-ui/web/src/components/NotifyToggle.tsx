import { useState } from "react";
import { FiBell } from "react-icons/fi";
import { useT } from "../i18n";
import {
	loadNotifySettings,
	saveNotifySettings,
	notificationsSupported,
	notificationPermission,
	requestNotificationPermission,
	type NotifySettings,
} from "../notify";

/**
 * Desktop / OS (PWA) notification toggle. Rendered at the bottom of the sound
 * dropdown in the top bar. Self-contained: it owns its (persisted) enabled
 * state and requests the browser permission from the user-gesture change
 * handler. When permission is denied the switch flips back so the UI never
 * claims notifications are on.
 */
export function NotifyToggle() {
	const t = useT();
	const [settings, setSettings] = useState<NotifySettings>(loadNotifySettings);
	const [perm, setPerm] = useState<NotificationPermission>(() =>
		notificationsSupported() ? notificationPermission() : "denied",
	);

	const toggle = async (enabled: boolean) => {
		const next: NotifySettings = { ...settings, enabled };
		setSettings(next);
		saveNotifySettings(next);
		if (enabled) {
			const p = await requestNotificationPermission();
			setPerm(p);
			if (p !== "granted") {
				// Reflect reality: notifications can't be shown, keep the switch off.
				const off: NotifySettings = { ...next, enabled: false };
				setSettings(off);
				saveNotifySettings(off);
			}
		}
	};

	return (
		<div
			className="sound-menu"
			style={{ borderTop: "1px solid var(--border-color, rgba(255,255,255,.08))", marginTop: 6, paddingTop: 6 }}
		>
			<div className="dd-header">{t("notifyHeader")}</div>

			<label className="sound-row sound-master">
				<span className="sound-label">
					<FiBell className="sound-icon" />
					<span>{t("notifyEnable")}</span>
				</span>
				<input type="checkbox" checked={settings.enabled} onChange={(e) => toggle(e.target.checked)} />
			</label>

			<div className="sound-desc" style={{ padding: "2px 8px 4px", opacity: 0.7, fontSize: "0.82em" }}>
				{t("notifyEnableDesc")}
			</div>

			{!notificationsSupported() && (
				<div className="sound-desc" style={{ padding: "0 8px 4px", opacity: 0.7, fontSize: "0.82em" }}>
					{t("notifyUnsupported")}
				</div>
			)}
			{perm === "denied" && (
				<div className="sound-desc" style={{ padding: "0 8px 4px", opacity: 0.7, fontSize: "0.82em" }}>
					{t("notifyDenied")}
				</div>
			)}
		</div>
	);
}
