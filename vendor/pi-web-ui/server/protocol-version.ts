/**
 * Wire-protocol version. Bump whenever a protocol change would make an old
 * browser tab talk to a newer server (or vice versa) in a broken way — the
 * classic symptom is "UI is new, WS handling is old" after an in-place app
 * update before the auto-restart completes.
 *
 * Lives OUTSIDE protocol.ts (which must stay pure types). The frontend keeps
 * its own copy in web/src/protocol-version.ts; scripts/check-protocol-sync.mjs
 * verifies the two never drift.
 */
/* 🍞 @COUPLED server/protocol.ts — 协议改动必须同时 bump 两份版本号（scripts/check-protocol-sync.mjs 校验） */
export const PROTOCOL_VERSION = 25;
