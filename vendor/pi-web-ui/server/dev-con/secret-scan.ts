/*
 * ─── 🍞 AI Breadcrumb Navigation ──────────────────
 * Tag meanings: @COUPLED=linked files @GOTCHA=gotcha @BUGFIX=bug fix @MAGIC=magic number
 *              @DEPENDS=external dependency @ASSUME=assumption @TODO=todo @WHY=design rationale
 *              @PERF=performance @CONTRACT=interface contract 📖=dev doc reference
 *
 * Breadcrumbs (changing this affects):
 *   @COUPLED jev-model.ts / jev-settings.ts / jev-samples.ts（Jev 配置里只允许密钥**名**）,
 *            ../model-admin.ts（同一个「明文密钥不进元数据」的不变量）
 *   @CONTRACT 只做形状判断，不联网、不读盘：含占位符的一定不是明文；sk-/ghp_ 这类前缀 +
 *             够长的无空格串才算密钥。宁可误报也不漏（§4 密钥不外泄）。
 *   @WHY 这两个函数原先住在 account-template.ts / channel-model.ts 里（渠道时代的渠道元数据闸子）。
 *        渠道能力移除后，仍然需要它们的只剩 Jev 配置校验，所以抽成独立小模块，
 *        避免为了两个纯函数保留整套渠道代码。
 * ──────────────────────────────────────────────────
 */

/**
 * 「这个值里写的是明文密钥吗」的启发式（用于校验时劝用户改成密钥**名**引用）。
 * @CONTRACT 只看形状：含占位符就一定不是明文；sk-/ghp_ 这类前缀 + 够长的无空格串才算。
 */
export function looksLikeLiteralSecret(value: string): boolean {
	if (typeof value !== "string") return false;
	if (value.includes("{apiKey}") || value.includes("{baseUrl}")) return false;
	const body = value.replace(/^\s*(bearer|basic|token)\s+/i, "").trim();
	if (/\s/.test(body)) return false;
	return /^(sk|pk|rk|api|ghp|gho|xox[abp])[-_]/i.test(body) && body.length >= 16;
}

/**
 * 禁止把密钥正文写进任何持久化元数据（本模块的唯一安全不变量）。
 * 返回命中的字段路径列表；非空即拒绝写入。
 */
export function findSecretMaterial(value: unknown, path = ""): string[] {
	const forbidden = new Set([
		"apikey",
		"api_key",
		"key",
		"keys",
		"token",
		"secret",
		"password",
		"headers",
		"authorization",
	]);
	const hits: string[] = [];
	const walk = (node: unknown, at: string): void => {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			node.forEach((item, i) => walk(item, `${at}[${i}]`));
			return;
		}
		for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
			const here = at ? `${at}.${k}` : k;
			if (forbidden.has(k.trim().toLowerCase()) && v !== null && v !== undefined && v !== "") hits.push(here);
			walk(v, here);
		}
	};
	walk(value, path);
	return hits;
}
