# DeepSeek 模型路由对齐记录

<!-- 🍞 AI Breadcrumb — @COUPLED vendor/pi-web-ui/server/model-routing.ts,
     vendor/pi-web-ui/server/agent-service.ts, vendor/pi-web-ui/server/dsh/dsh-agent-service.ts,
     vendor/pi-web-ui/server/dsh/runtime/override.patch.yml, docs/README.md -->

本文记录 PI-dev 的 DeepSeek 模型路由与官方事实的对齐结果、核对日期、来源与遗留项。它是路由数字的唯一文字依据；代码侧事实源是
`vendor/pi-web-ui/server/model-routing.ts`（单测锁规格）。

**核对日期：2026-09-10（官方 DeepSeek-V4.1-Flash 发布当天）。**

## 1. 官方事实

| 项 | `deepseek-flash`（= DeepSeek-V4.1-Flash） | `deepseek-v4-pro`（= DeepSeek-V4-Pro-0813） |
| --- | --- | --- |
| 状态 | 当日 GA；取代 V4-Flash 与 V4-Flash-Vision-Exp（两者已退役） | GA，正在有序退场 |
| 旧 id 兼容 | `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍被接受，请求由 V4.1-Flash 服务、按 Flash 价计费 | — |
| 退场时点 | — | **2026-09-14 04:00 UTC** 起该 id 请求全部转 V4.1-Flash，按 Flash 计费，直到 V4.1-Pro 发布 |
| 视觉 | 原生多模态（JPEG / PNG / GIF / WebP） | 不支持（图片被静默忽略） |
| 上下文 / 最大输出 | 1M / 384K | 1M / 384K |
| 思考模式 | 非思考 + 思考（默认开，默认 effort `high`）；`off / low / high / max` | 同左 |
| 价格（USD / 1M token，低谷 → 高峰） | 入 0.15 → 0.3；缓存命中 0.003 → 0.006；出 0.6 → 1.2 | 入 0.66 → 1.32；缓存命中 0.022 → 0.044；出 1.98 → 3.96 |
| 并发上限 | 2500 | 500 |

高峰时段：UTC 周一至周五 01:00–04:00 与 06:00–10:00；其余时段为低谷（低谷价为高峰价的一半）。
思考档位映射（官方）：`minimal→low`、`low→low`、`medium→high`、`high→high`、`xhigh→high`、`max→max`，`off` 关闭思考模式。

事实来源：

- <https://api-docs.deepseek.com/news/news260910>
- <https://api-docs.deepseek.com/quick_start/pricing>
- <https://api-docs.deepseek.com/guides/vision>
- <https://api-docs.deepseek.com/guides/thinking_mode>
- <https://api-docs.deepseek.com/updates>

2026-09-10 用本实例已配置的 DeepSeek 凭据做的只读实测（密钥只在进程内读取，未打印、未落盘）：

| 实测 | 结果 |
| --- | --- |
| `GET https://api.deepseek.com/models` | 只返回 `deepseek-flash`、`deepseek-v4-pro`（旧 id 不再出现在列表里） |
| `POST /chat/completions` model=`deepseek-flash` | HTTP 200，响应 `model=deepseek-flash` |
| `POST /chat/completions` model=`deepseek-v4-flash` | HTTP 200，响应 `model=deepseek-flash`（兼容转发被证实） |
| `POST /chat/completions` model=`deepseek-v4-flash-vision-exp`（带图） | HTTP 200，响应 `model=deepseek-flash`，图片被接受 |
| `POST /chat/completions` model=`deepseek-v4-pro` | HTTP 200，响应 `model=deepseek-v4-pro`（尚未切换）；带图请求图片被忽略 |
| 思考 | 响应带 `reasoning_tokens`，默认即思考模式 |

## 2. 本系统的路由入口

| 入口 | 位置 | 对齐后的行为 |
| --- | --- | --- |
| pi 引擎运行时目录 | 内置 pi-ai 目录 + pi.dev 远端覆盖（实例数据目录 `agent/models-store.json`）+ **`agent/models.json` 覆盖层** | 通过覆盖层把 `deepseek/deepseek-flash` 注册进目录，并修正三个旧 id 的元数据 |
| pi 引擎顶栏模型列表 | `vendor/pi-web-ui/server/agent-service.ts` `listModels()` → `filterRoutableModels(models, rules)` | 只暴露 `deepseek/deepseek-flash`；旧 id 不再出现 |
| **模型路由规则（可配置）** | 设置面板 → **系统 → 模型路由规则**（存 `settings.retiredModelRoutes` / `modelRouteAliases`） | 退役路由与别名都**不用改代码**：`provider/id` 只匹配该服务商，裸 id 匹配所有服务商；每行一个，别名写 `旧id=新id`。「恢复出厂默认」= 清除自定义（回到 `model-routing.ts` 的 `DEFAULT_RETIRED_DEEPSEEK_ROUTES`） |
| DSH 引擎本地表与默认模型 | `vendor/pi-web-ui/server/dsh/dsh-agent-service.ts`、`dsh-client.ts` | 本地表只有 `deepseek-flash`（`vision: true`），默认模型即它；成本表用官方高峰价 |
| DSH adapter 目录 | `vendor/pi-web-ui/server/dsh/runtime/override.patch.yml` 的 `llm-deepseek` 行 | 显式 `models` 列表替换 adapter 默认的三个旧 id |
| 历史绑定 / 既有渠道 | 不经列表过滤的 `modelRuntime.getModel()` 解析路径 | 旧 id 仍可解析（元数据已对齐到实际服务模型），历史会话与渠道绑定不失效 |

`docs/DEV-CON-PROPOSAL.md` 的渠道绑定引用 `provider/model`，因此“隐藏旧 id”只影响新选择，不影响既有绑定的可解析性与费用显示。

## 3. 实例侧覆盖块（`agent/models.json`）

该文件属于实例数据，不进 Git；内容由本文与 `model-routing.ts` 约束：

```jsonc
{
  "providers": {
    // …既有服务商（cctq）保持不变…
    "deepseek": {
      "models": [
        {
          "id": "deepseek-flash",
          "name": "DeepSeek-V4.1-Flash",
          "api": "openai-completions",
          "baseUrl": "https://api.deepseek.com",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1000000,
          "maxTokens": 384000,
          "cost": { "input": 0.3, "output": 1.2, "cacheRead": 0.006, "cacheWrite": 0 },
          "thinkingLevelMap": { "minimal": "low", "low": "low", "medium": "high", "high": "high", "xhigh": "high", "max": "max" },
          "compat": {
            "supportsStore": false,
            "supportsDeveloperRole": false,
            "maxTokensField": "max_tokens",
            "requiresReasoningContentOnAssistantMessages": true,
            "thinkingFormat": "deepseek"
          }
        }
      ],
      "modelOverrides": {
        "deepseek-v4-flash": { "name": "DeepSeek-V4.1-Flash (retired id: deepseek-v4-flash)", "input": ["text", "image"], "contextWindow": 1000000, "maxTokens": 384000 },
        "deepseek-v4-flash-vision-exp": { "name": "DeepSeek-V4.1-Flash (retired id: deepseek-v4-flash-vision-exp)", "input": ["text", "image"], "contextWindow": 1000000, "maxTokens": 384000 },
        "deepseek-v4-pro": { "name": "DeepSeek-V4-Pro (routes to V4.1-Flash from 2026-09-14T04:00Z)" }
      }
    }
  }
}
```

- 两个已退役 Flash 别名的成本与上下文一并对齐到 V4.1-Flash；`deepseek-v4-pro` 保留 V4-Pro 自身价格，名称标注退场时点。
- 成本表只能存一个单价（pi 与 DSH 都不支持高峰/低谷分时），统一记录**高峰列表价**，估算不会低于实际扣费；低谷折扣见第 1 节。

## 4. 验证方式

```bash
# 规格单测（官方数字、退役过滤、DSH 目录）
npm --prefix vendor/pi-web-ui run test:unit

# 类型检查
npm run typecheck

# DSH 协议冒烟（需要 dsh 运行时树；无树时自动 SKIP）
npm --prefix vendor/pi-web-ui run test:smoke
```

实例侧目录是否真的对齐，用同一 SDK + 实例 agent 目录核对（只读、不联网）：

```bash
PI_OFFLINE=1 node -e 'const {ModelRuntime}=await import("@earendil-works/pi-coding-agent");
const d="/home/dev/.local/share/pi-dev/agent";
const rt=await ModelRuntime.create({authPath:`${d}/auth.json`,modelsPath:`${d}/models.json`,modelsStorePath:`${d}/models-store.json`,refreshOnCreate:false});
for (const id of ["deepseek-flash","deepseek-v4-flash","deepseek-v4-pro"])
  console.log(id, JSON.stringify(rt.getModel("deepseek", id)?.name));' --input-type=module
```

## 5. 可配置规则（操作者入口）

官方随时会上/下线路由，因此**退役列表与别名不是写死的**：设置面板 → 系统 → 「模型路由规则」可以直接改，
保存后立即对模型选择器生效（历史会话与已绑定渠道仍可解析，不受影响）。

| 存储 | 语义 |
| --- | --- |
| 缺省（没保存过） | 用 `server/model-routing.ts` 的出厂默认（官方核对日见第 1 节） |
| 保存了列表 | 以保存的为准；**空列表是合法状态** = 不隐藏任何路由 |
| 「恢复出厂默认」 | 清除自定义（存 `null`），回到出厂默认，之后默认值更新会自动跟随 |

模型本身的**名字 / 上下文 / 价格 / 思考档位**不在这里，仍在 `agent/models.json`（设置面板「管理模型」可改）：
路由规则只管「哪些 id 不出现在选择器里」，两处职责不重叠（避免同一事实出现两份可写来源）。

验证方式：

```bash
# 规则归一化与过滤（含自定义/裸 id/空列表三态）
npm --prefix vendor/pi-web-ui exec vitest run tests/unit/model-routing.test.ts
# 端到端：设置 → list_models 立即生效 → 落盘 → 重连仍在 → null 清除
npm --prefix vendor/pi-web-ui run test:smoke   # 含 model-routing-rules-test
```

## 6. 遗留项与后续

1. **pi.dev 远端目录上游未更新**：`https://pi.dev/api/models/providers/deepseek` 与实例缓存 `agent/models-store.json` 仍只有三个旧 id。我们不伪造上游缓存，靠 `models.json` 覆盖层对齐；上游更新后覆盖层仍可保留（同 id 同名合并）。
2. **思考档位只接了 `high`**：pi 侧目录已支持 `off/low/high/max`（推理档位由目录驱动）；DSH 侧部署固定 `reasoningEffort: high`，`off/low/max` 尚未接线，界面提示已改为如实说明。
3. **分时计价未接入**：成本表按高峰价记录；若将来要显示低谷真值，需要 pi/DSH 成本模型支持时段档位。
4. **DSH 侧未做真实启动验证**：本开发机未安装 dsh 运行时树，DSH 改动只做到 adapter schema 校验 + 单测 + 协议冒烟脚本断言；上线 DSH 前需在有运行时树的环境跑 `test:smoke`。
