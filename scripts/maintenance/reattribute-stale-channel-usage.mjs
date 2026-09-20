/**
 * 用量历史「假渠道归属」清理（一次性迁移）。
 *
 * 为什么需要它：2026-09-20 之前，「渠道绑定」不校验实际模型 —— 模型被渠道以外的路径换掉后
 * （`channel_state` 还没到就用了非渠道模式列表的 `set_model`、`cycle_model`、项目默认模型……），
 * 旧绑定仍被当成这次请求的归属，于是「按来源/渠道」里出现 `渠道=UU apiClaude、模型=deepseek-flash`
 * 这种自相矛盾的行（实测 1214 条）。修复（P0-VERIFICATION §19）之后新记录不会再这样落盘，
 * 但**历史行仍在**：本脚本把「渠道的服务商 ≠ 记录的服务商」的行改回「未归属」。
 *
 * 用法：
 *   node scripts/maintenance/reattribute-stale-channel-usage.mjs          # 预演（默认，不写盘）
 *   node scripts/maintenance/reattribute-stale-channel-usage.mjs --apply  # 落盘（先备份、再原子替换）
 *   环境变量：PI_DEV_AGENT_DIR 覆盖 agentDir。
 *
 * 只改归属字段（channelId / credentialKeyName / bindingRevision / configRevision→保留）：
 * 不动 token、费用、时间、模型、providerId（providerId 本来就来自事件，是真的）。
 * 不做任何推断 —— 「服务商对得上」的行原样保留，「渠道已不存在」的行也按未归属处理。
 *
 * @COUPLED vendor/pi-web-ui/server/dev-con/channel-model.ts（bindingCoversModel 的服务商口径）、
 *   vendor/pi-web-ui/server/dev-con/usage-history.ts（channelId=null 归到 unattributed 桶）、
 *   docs/P0-VERIFICATION.md §19
 * @GOTCHA 本脚本会重写整个文件，而在线的 pi 进程随时在往同一个文件 append。所以每条写入都走
 *   「取样 → 读 → 算 → 写临时文件 → **紧贴 rename 之前再确认一次** → 原子替换」这个循环：
 *   中途发现文件变了就丢掉临时文件重来。剩下的窗口只有「最后一次确认 → rename」之间那一瞬。
 * @ASSUME 尽力而为，不是分布式事务；不建议在繁忙时段跑（预演不写盘，可先看数字）。
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir =
  process.env.PI_DEV_AGENT_DIR ?? join(homedir(), ".local/share/pi-dev/agent");
const historyPath = join(agentDir, "dev-con/usage-history.jsonl");
const channelsPath = join(agentDir, "dev-con/channels.json");
const apply = process.argv.includes("--apply");

/** channelId → 该渠道当前声明的服务商（绑定归属的判定基准）。 */
function channelProviders() {
  const providers = new Map();
  try {
    const catalog = JSON.parse(readFileSync(channelsPath, "utf8"));
    for (const channel of catalog.channels ?? []) {
      if (channel?.id) providers.set(channel.id, channel.providerId ?? null);
    }
  } catch (error) {
    console.error(`读不到渠道目录 ${channelsPath}：${error.message}`);
    process.exit(1);
  }
  return providers;
}

const providers = channelProviders();

/** 逐行处理：返回新行 + 统计。认不出来的行原样输出。 */
function reattribute(text) {
  const out = [];
  let total = 0;
  let kept = 0;
  let cleared = 0;
  const byPair = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    total += 1;
    const channelId =
      typeof record.channelId === "string" ? record.channelId : null;
    const providerId =
      typeof record.providerId === "string" ? record.providerId : null;
    const channelProvider = channelId
      ? (providers.get(channelId) ?? null)
      : null;
    if (
      !channelId ||
      (channelProvider && providerId && channelProvider === providerId)
    ) {
      kept += 1;
      out.push(line);
      continue;
    }
    // 渠道服务商对不上（或渠道已不存在 / 记录没有服务商）→ 这次请求不是渠道绑定的请求。
    const pair = `${channelId}(${channelProvider ?? "已删除"}) ← ${providerId ?? "?"}/${record.modelId ?? "?"}`;
    byPair.set(pair, (byPair.get(pair) ?? 0) + 1);
    delete record.channelId;
    delete record.credentialKeyName;
    delete record.bindingRevision;
    cleared += 1;
    out.push(JSON.stringify(record));
  }
  return { out, total, kept, cleared, byPair };
}

const fingerprint = (path) => {
  const stat = statSync(path);
  return `${stat.size}:${stat.mtimeMs}`;
};

function applyFile(path, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = fingerprint(path);
    const result = reattribute(readFileSync(path, "utf8"));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${path}.bak-${stamp}`;
    const tmp = `${path}.${process.pid}.reattribute`;
    copyFileSync(path, backup);
    writeFileSync(tmp, result.out.join("\n"), { mode: 0o600 });
    // 最后一次确认紧贴 rename：窗口只剩这一条语句本身。
    if (fingerprint(path) !== before) {
      unlinkSync(tmp);
      console.log(`${path} 在本次写入前被追加过，重试（第 ${attempt} 次）`);
      continue;
    }
    renameSync(tmp, path);
    console.log(
      `已清理 ${result.cleared} 条假归属：${path}（共 ${result.total} 条，备份 ${backup}）`,
    );
    return result;
  }
  console.error(
    `${path} 连续 ${maxAttempts} 次都在写入前被改动——现在很忙，稍后再跑或先停服务。未写入任何内容。`,
  );
  process.exit(1);
}

if (!existsSync(historyPath)) {
  console.error(`没有用量历史：${historyPath}`);
  process.exit(1);
}

const preview = reattribute(readFileSync(historyPath, "utf8"));
console.log(
  `用量历史：${preview.total} 条，服务商对得上（保留）：${preview.kept} 条，要改成「未归属」：${preview.cleared} 条`,
);
const pairs = [...preview.byPair].sort((a, b) => b[1] - a[1]);
for (const [pair, count] of pairs.slice(0, 12))
  console.log(`  ${count}  ${pair}`);
if (pairs.length > 12) console.log(`  …其余 ${pairs.length - 12} 种组合`);

if (!apply) {
  console.log("\n预演结束（未写盘）。要落盘请加 --apply。");
  process.exit(0);
}
applyFile(historyPath);
