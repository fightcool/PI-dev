/* 🍞 AI Breadcrumb — @COUPLED ../dev-con/jev-model.ts（命题负载形状）, ../dev-con/jev-gate.ts（evaluate 入口）
 * 📖 docs/JEV-HARNESS-PLAN.md §6 —— harness 里所有临时判断走这一个入口，不要再各写一份调用逻辑。
 */

/**
 * 通用临时命题的载荷校验（纯函数，零 IO、零网络）。
 *
 * @WHY 注册表里的三个命题（`JEV_PROPOSITIONS`）只服务「提交/PR 门禁」。而把 Jev 当**可编程决策原语**用时
 *   （工具结果裁剪、文件重排、路由升级、护栏、轨迹校验），问题是临时的、按调用方现造的：
 *   `{ "<id>": { type: "noul", instructions, criteria } }`。这一层就是那种载荷的形状闸门。
 * @CONTRACT 只做**形状**校验，不猜语义、不改写内容：
 *   - 载荷必须是**对象**（record；键=命题名，值=命题），且 1..`ASK_MAX_QUESTIONS` 条；
 *   - 键必须匹配 `^[a-z][a-z0-9_]{0,100}$` —— 与注册表 id 同一套规则，别让缓存键与审计里出现怪字符串；
 *   - 值必须带 `type`（`noul` | `choice` | `score`，上游 zod 要求判别字段）与非空 `instructions`。
 *   `criteria` 等更深的要求交给上游（zod 会 400），本地不重复实现第二套 schema —— 多了就会漂移。
 * @GOTCHA 报错信息里**永不回显** state 或载荷正文（调用方的 state 可能是整份 diff/源码）：
 *   只报 id 与原因。
 */
export const ASK_ID_RE = /^[a-z][a-z0-9_]{0,100}$/;
export const ASK_MAX_QUESTIONS = 32;
export const ASK_TYPES = ["noul", "choice", "score"] as const;

export type AskQuestionType = (typeof ASK_TYPES)[number];
export type AskQuestionsPayload = Record<string, { type: AskQuestionType; instructions: unknown }>;

/** 参数/形状问题（区别于上游/网络问题）：CLI 一律映射成退出码 3。 */
export class JevAskError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JevAskError";
	}
}

/**
 * `ask` 的退出码映射。
 * @WHY 门禁用三态（0 通过/1 阻断/2 转人工）是对的；但 harness 里做**排序/筛选**时（工具结果裁剪、
 *   文件重排）调用方要的是**原始概率**，不是「这条命题被判成 block」——套阈值只会让「无关片段」
 *   也返回退出码 1，看着像失败。所以 `--raw` 明确表示「只要数，不要三态」：成功即 0，出错仍 3。
 */
export function askExitCode(decision: { error?: { code: string } | null; outcome: string }, raw: boolean): number {
	if (decision.error) return 3;
	if (raw) return 0;
	return { approve: 0, block: 1, review: 2 }[decision.outcome] ?? 3;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** 解析并校验临时命题载荷。返回原对象（不改写），失败抛 {@link JevAskError}。 */
export function parseAskQuestions(raw: unknown): AskQuestionsPayload {
	if (!isPlainObject(raw)) {
		throw new JevAskError('命题载荷必须是对象：{ "<id>": { "type": "noul", "instructions": …, "criteria": … } }');
	}
	const entries = Object.entries(raw);
	if (entries.length === 0) throw new JevAskError("命题载荷为空：至少要一条命题");
	if (entries.length > ASK_MAX_QUESTIONS) {
		throw new JevAskError(`命题过多（${entries.length} > ${ASK_MAX_QUESTIONS}）：一个请求里批量问，但别把请求堆成墙`);
	}
	for (const [id, value] of entries) {
		if (!ASK_ID_RE.test(id)) {
			throw new JevAskError(
				`命题 id 非法：${JSON.stringify(id)}（要求：小写字母开头，只含小写字母/数字/下划线，长度 ≤101）`,
			);
		}
		if (!isPlainObject(value)) throw new JevAskError(`命题 ${id} 必须是对象（含 type 与 instructions）`);
		const type = value.type;
		if (!ASK_TYPES.includes(type as AskQuestionType)) {
			throw new JevAskError(`命题 ${id} 的 type 必须是 ${ASK_TYPES.join(" / ")}（上游要求判别字段，缺了会 400）`);
		}
		const instructions = value.instructions;
		const instructionsOk =
			typeof instructions === "string"
				? instructions.trim().length > 0
				: isPlainObject(instructions) && Object.keys(instructions).length > 0;
		if (!instructionsOk) {
			throw new JevAskError(`命题 ${id} 缺少 instructions（字符串或对象，且非空）：判定句必须写在这里`);
		}
	}
	return raw as AskQuestionsPayload;
}
