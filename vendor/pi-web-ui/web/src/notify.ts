/**
 * Desktop / OS (PWA) notifications for pi-web-ui.
 *
 * Lightweight, frontend-only notifications via the browser Notification API.
 * They are routed through the registered service worker (reg.showNotification)
 * so they still appear when the installed PWA is running in the background /
 * minimised — exactly the "a session finished / needs your input while I'm in
 * another app" case from issue #13. No server-side web push (that would need a
 * subscription + VAPID + push endpoint; out of scope).
 *
 * Notifications only fire while the page is NOT focused (document.hasFocus()
 * is false) so they never spam the user who is actively watching the chat —
 * that case is covered by the in-app sound cues.
 */

import { appUrl } from "./base-url";

export interface NotifySettings {
	/** Master switch — kills every OS notification. */
	enabled: boolean;
}

const STORAGE_KEY = "pi-web-notify";

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { enabled: false };

/** Read persisted settings, falling back to defaults on any failure. */
export function loadNotifySettings(): NotifySettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_NOTIFY_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<NotifySettings>;
		return { enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_NOTIFY_SETTINGS.enabled };
	} catch {
		return { ...DEFAULT_NOTIFY_SETTINGS };
	}
}

export function saveNotifySettings(settings: NotifySettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// storage unavailable (private mode etc.) — notifications just won't persist
	}
}

export function notificationsSupported(): boolean {
	return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission {
	if (!notificationsSupported()) return "denied";
	return Notification.permission;
}

/** Request the notification permission. MUST be called from a user gesture
 *  (e.g. toggling the switch) or the browser rejects it. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
	if (!notificationsSupported()) return "denied";
	try {
		return await Notification.requestPermission();
	} catch {
		return "denied";
	}
}

/** Show an OS notification when enabled + granted AND the page is not focused.
 *  Otherwise it is a safe no-op. Never throws. */
export async function notify(title: string, body?: string): Promise<void> {
	if (!notificationsSupported()) return;
	if (document.hasFocus()) return; // user is watching — don't spam (sound covers it)
	if (!loadNotifySettings().enabled) return;
	if (Notification.permission !== "granted") return;

	const options: NotificationOptions = {
		body,
		// appUrl keeps the icon path valid under nginx sub-path deployments
		// (e.g. /pi/); root deployments resolve to the exact same URL.
		icon: appUrl("/icons/icon-192.png"),
		badge: appUrl("/icons/icon-192.png"),
		tag: "pi-web-ui",
	};
	try {
		// Prefer the service worker's showNotification so it works even while
		// the PWA is backgrounded; fall back to a page Notification.
		const reg = await navigator.serviceWorker?.getRegistration();
		if (reg && typeof reg.showNotification === "function") {
			reg.showNotification(title, options);
		} else {
			new Notification(title, options);
		}
	} catch {
		// notifications can't be shown right now — ignore
	}
}
