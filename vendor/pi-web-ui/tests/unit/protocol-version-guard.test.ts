/* 🍞 AI Breadcrumb — @COUPLED ../../server/protocol.ts, ../../server/protocol-version.ts,
 *   ../../web/src/protocol-version.ts, ../../scripts/check-protocol-sync.mjs
 * 📖 docs/NEWAPI-GATEWAY.md（本次协议改动：渠道消息移除、网关配置/用量消息新增）
 * @CONTRACT 这道守卫取代「记得手动 bump」：protocol.ts 的任何内容变化（消息/字段/注释以外的
 *   语义与结构）都会让指纹变化，从而强制提交者显式 bump PROTOCOL_VERSION 并更新本文件的期望值。
 *   否则新旧前端/后端在升级窗口里无法通过版本号识别不匹配（会静默出错）。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../server/protocol-version.js";

/** 去掉注释与空白后的协议正文指纹（改写注释不影响，改协议一定影响）。 */
const fingerprint = (src: string): string =>
	createHash("sha256")
		.update(
			src
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^\s*\/\/.*$/gm, "")
				.replace(/\s+/g, " ")
				.trim(),
		)
		.digest("hex")
		.slice(0, 16);

describe("protocol version guard", () => {
	it("requires a PROTOCOL_VERSION bump whenever protocol.ts changes", () => {
		const src = readFileSync(join(__dirname, "..", "..", "server", "protocol.ts"), "utf8");
		expect(
			{ version: PROTOCOL_VERSION, digest: fingerprint(src) },
			"protocol.ts 变了：请 bump server/protocol-version.ts 与 web/src/protocol-version.ts，并把本用例记录的指纹换成新值",
		).toEqual({ version: 39, digest: "09bf02e13c010ead" });
	});
});
