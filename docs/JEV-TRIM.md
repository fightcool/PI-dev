# Jev 工具结果过滤（jev-trim）

> 把 Jev 当**决策原语**用的第一处落地：在工具结果进入上下文之前，按「与当前目标是否相关」筛掉无关片段。
> 方案与路线见 [JEV-HARNESS-PLAN.md](JEV-HARNESS-PLAN.md) §3-P0；门禁本身见 [JEV-DECISION-GATE.md](JEV-DECISION-GATE.md)。

## 1. 为什么是 `tool_result`，为什么是「片段」

| 事实                                                                  | 出处                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| 工具结果占我们会话 token 的 **48.8%**（1166 条，2,485,603 字符样本）  | 本机会话 jsonl 实测（2026-09-20）                            |
| **不能改写历史前缀**：前缀缓存一失效，省下的 token 会以数倍价格还回去 | `docs/CONTEXT-POLICY.md §7`（`pi-context-prune` 因此被移除） |
| `tool_result` 钩子只影响**本次新追加**的消息，且可改写 `content`      | pi SDK `types.d.ts`：`on("tool_result", …)` → `{ content? }` |

所以省钱的位置只有一个：**结果追加进上下文的那一刻**。判断单位是「片段」（默认 ~1500 字符）：以片段为单位判断、以片段为单位保留，所有字符要么被判断过、要么显式写进省略标记。

## 2. 判定怎么发出去（一次请求批量问）

- `state = { objective, tool, sections: [{ index, text }] }`，`objective` 取会话分支里最后一条 **user** 消息（截断 600 字符）；
- 每个片段一条 `noul` 命题 `section_<i>`，用文档允许的反引号路径引用 state：`` `sections[i].text` `` / `` `objective` `` —— 片段正文**不进问题**（否则 state 会膨胀 N 倍）；
- 判据英文、双向给具体反例：`true` 侧 = 错误/断言/代码路径/必须改的行；`false` 侧 = 配色/无关模块/泛泛叙述；
- 一次请求批量 N 条（官方 rerank cookbook 的做法），走 `<app>/scripts/jev-ask.ts`（瘦入口，见 §5）。

> **判据质量决定成败**（这条是实测出来的）：同一份 state，判据写成 "Is this section needed?" 时，
> 相关片段 0.34 / 无关片段 0.31（**不可分**）；改成「明确比较对象 + 两侧真实反例」后
> 相关 **0.970** / CSS **0.030** / 截图流水 **0.040**（403ms、$0.0000518、三问批量）。

## 3. 开关与参数

配置文件：`<agentDir>/dev-con/jev-trim-settings.json`（0600）；环境变量优先级更高。

**为什么要有配置文件**：宿主（pi-web-ui 服务）的环境变量在启动时就定了，改它要重启服务。
配置文件让开关**立刻生效**，不必重启、不必动服务配置。

```jsonc
{
  "mode": "dry-run", // off（默认）| dry-run（只统计）| on（真改写）
  "minChars": 12000, // 小于这个字符数不动手（不为小输出付一次往返）
  "maxChars": 400000, // 大于这个直接放弃判定（state 太大会把成本与延迟一起推高）
  "sectionChars": 1500, // 片段目标大小
  "maxSections": 24, // 超过就合并相邻片段（粗粒度全覆盖，不丢字）
  "keepAt": 0.5, // 片段得分 ≥ 它才保留
  "maxPerSession": 3, // 一个会话最多裁几次
  "cliTimeoutMs": 20000,
}
```

命令：

```bash
npm run trim -- show                  # 看有效配置（含来源：env > 文件 > 默认）
npm run trim -- mode dry-run          # 只统计不改写（先跑这个量收益）
npm run trim -- mode on               # 真的裁剪
npm run trim -- stats [--json]        # 收益/代价汇总
```

## 4. 安全规则（代码里写死的，不受配置影响）

| 规则                                                                   | 原因                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| 失败/异常一律**原样放行**（返回 `undefined`），并 `console.error` 留痕 | 「看着是绿的其实一次也没判」是最危险的失败模式 |
| `isError` 的结果不裁                                                   | 错误正文往往就是全部信息                       |
| 模型**没回答**的片段一律保留                                           | 未判定 ≠ 不重要；没被判断的内容不许被丢掉      |
| 全判无关时至少留得分最高的一段                                         | 凭一次概率清空整份输出，风险不对称             |
| 保留比例 > 0.8 或省不到 15% → 不改写                                   | 改写本身有代价，收益必须明显                   |
| 只返回 `{ content }`，`details` / `isError` / `usage` 一律不碰         | 改了会让 UI 与后续逻辑错乱                     |
| 每次改写都在结果里留**可见标记**（保留 K/N 段 + 每段首行 + 重取方式）  | agent 必须能看出「这份结果被过滤过」           |
| 启动时未启用只 `console.warn`，不写统计                                | 默认关就是零开销                               |

## 5. 延迟与成本（实测，2026-09-21）

| 路径                                                 | 墙钟              | 说明                                                                                                     |
| ---------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| 完整 CLI `node --import tsx scripts/jev-gate.ts ask` | **2.37-2.47s**    | 冷启动，其中 **~2.5s 全在 `import "@earendil-works/pi-coding-agent"`**（CLI 只用了它的 `getAgentDir()`） |
| 瘦入口 `node --import tsx scripts/jev-ask.ts`        | **~0.65s** 冷启动 | 不 import SDK；`agentDir` 等价复制，有单测与 SDK 逐例对比                                                |
| 瘦入口 + 真实判定（cache miss）                      | **1295ms**        | 其中模型 API 631ms（3 问批量）                                                                           |
| 瘦入口 + 磁盘缓存命中                                | **~350ms**        | 判定 6ms；同样的工具结果重复出现几乎免费                                                                 |

成本：3 问批量 `$0.0000518`（in=1234 / out=58）。**只算输入 token**，输出免费。

代价与收益的口径：一次裁剪 = 一次判定（~1.3s，重复结果 ~0.35s），换来的是结果里省下的字符
（`stats` 里 `charsBefore → charsAfter`，`≈ 字符数/4` 估 token）。`maxPerSession` 默认 3 是保护：
连续大输出时不许把每一轮都拖成秒级。

## 6. 统计怎么读（`npm run trim -- stats`）

```text
判定 8 次（成功 7 / 失败 1），其中会改动 5 次、判完不改 2 次
字符：420000 → 130000（省 290000，69.0%，≈ 72500 token）
耗时：墙钟 p50 1300ms / max 2600ms（其中模型 API max 640ms —— 差值就是 CLI 冷启动开销）
成本：$0.000420；缓存 {"miss":6,"disk":1}
跳过：below-min-chars=11 is-error=2 no-objective=1
失败原因：cli-timeout=1
```

- `判定/改动/判完不改`：**判完不改**是正常的（相关内容本来就该全留），不是失败；
- `跳过`：为什么没动手（按原因分类，用来调 `minChars` 等参数）；
- `失败原因`：`app-not-found` / `cli-timeout` / `decision-error:*` —— 出现这些要当 bug 看待（留痕就是为了能看见）；
- 统计只记数字与判定结果，**永不记 state/片段正文**（可能是源码或密钥），文件 0600、4 MiB 轮转。

## 7. 安装与生效

```bash
# 安装所有 extensions/jev-*（内容寻址：入口名带内容哈希，宿主按路径缓存 factory，改名才能刷新）
PI_CODING_AGENT_DIR=/home/dev/.local/share/pi-dev/agent node scripts/install-jev-hook.mjs install

# 卸载
PI_CODING_AGENT_DIR=/home/dev/.local/share/pi-dev/agent node scripts/install-jev-hook.mjs uninstall
```

产物：`<agentDir>/extensions/jev-trim-<hash>.ts` → `<agentDir>/hooks/jev-trim-<hash>/`（本体 + `.managed-by` + `app.json`）。
本体必须在 `extensions/` **之外**（pi 会把 `extensions/<目录>/index.ts` 也当扩展发现 → 同一个钩子加载两次）。
`app.json` 记的是「CLI 在哪个 checkout」，会话在**别的项目**里工作时靠它兜底 —— 路径写错不会报错，只会静默不生效，所以有单测钉住。

改完本体要重跑 install（哈希变 → 入口名变 → 宿主缓存失效）；新会话自动加载，现有会话 `/reload`。

## 8. 已知限制

- `ask` 只消费 `noul` 答案（`server/dev-con/jev-gate.ts` 的抽取只认 `type:"noul"`）：想要分级排序（Score 原语）需要先扩抽取与阈值语义 —— 排 P1；
- 判定在 `tool_result` 里**同步**发生，所以延迟直接叠在回合上（瘦入口把它压到 ~0.65s + API）；
- 只覆盖「与目标相关」这一个判据：更细的「这段是不是重复信息」「这段是不是已经过期」都还没做；
- `details`/非文本 part 不参与判定（图片、结构化结果原样保留）。
