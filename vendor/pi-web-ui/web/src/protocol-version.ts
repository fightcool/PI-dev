/**
 * Frontend copy of server/protocol-version.ts (protocol.ts itself must stay
 * pure types, so the constant lives here). scripts/check-protocol-sync.mjs
 * verifies both copies carry the same number — bump them together.
 */
/* 🍞 @COUPLED server/protocol-version.ts — 协议改动必须同时 bump 两份版本号（scripts/check-protocol-sync.mjs 校验） */
export const PROTOCOL_VERSION = 21;
