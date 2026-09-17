/**
 * 🍞 AI Breadcrumb
 * @COUPLED tests/run-smoke.mjs（smokeEnv 与本文件同一口径：带 PI_WEB_TOKEN 的宿主会 401）,
 *          tests/left-panel-test.mjs / tests/panel-layout-test.mjs / tests/new-project-ui-test.mjs
 *          （三处曾各抄一份，行为已经开始分叉）
 * @CONTRACT 自起隔离服务端的测试用 isolatedEnv() 造环境、用 seedToken(page) 过纯客户端 Passkey 门。
 * @GOTCHA 宿主 shell 可能带着 PI_WEB_TOKEN（本机就是）：不剥离的话隔离实例要鉴权，
 *   页面停在登录卡、`.panel-left` 永不渲染 —— 表现为与本用例无关的假失败。
 *   同理 PasskeyGate 是「纯客户端」门：隔离实例下任何 token 都能过，但必须先种 localStorage。
 */

/** 需要从继承环境里摘掉的宿主变量（与 run-smoke.mjs 的 smokeEnv 同口径）。 */
const HOST_ONLY_KEYS = ["PI_WEB_TOKEN", "PI_WEB_MANAGED"];

/** 隔离实例的鉴权与语言（纯客户端 Passkey 门只检查「有 token」，不校验值）。 */
export const E2E_TOKEN = "e2e-isolated-instance";
export const E2E_LANG = "zh";

/**
 * 去掉宿主鉴权变量的进程环境，并叠加本次用例自己的变量。
 * @param {Record<string, string>} [extra] 例如 { PI_WEB_PORT, PI_WEB_DATA_DIR, PI_WEB_CWD }
 */
export function isolatedEnv(extra = {}) {
	const env = { ...process.env };
	for (const key of HOST_ONLY_KEYS) delete env[key];
	return { ...env, ...extra };
}

/**
 * 让页面跳过 Passkey 门并固定语言（在 page.goto 之前调用）。
 * @param {import("playwright-core").Page} page
 * @param {string} [lang]
 */
export async function seedToken(page, lang = E2E_LANG) {
	await page.addInitScript(
		`try{localStorage.setItem('pi-web-ui:token',${JSON.stringify(E2E_TOKEN)});localStorage.setItem('pi-web-ui:lang',${JSON.stringify(lang)})}catch(e){}`,
	);
}
