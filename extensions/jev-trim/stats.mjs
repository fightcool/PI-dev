/* 🍞 AI Breadcrumb — @COUPLED index.ts（写）, ../../scripts/jev-trim-stats.mjs（读）
 * @WHY 没有统计就没法决定要不要开 `on`：这套改动省的是**字符**，花的是**一次网络调用 + 延迟**。
 *   记录必须同时含 `charsBefore/charsAfter`（收益）与 `wallMs/apiMs`（代价），否则算不出净收益。
 * @CONTRACT 只记数字与判定结果，**永不记 state/片段正文**（可能是源码或密钥）；文件 0600；
 *   超过上限就轮转一代（不是无限追加）。纯 IO 失败一律吞掉（统计坏了不能影响主流程）。
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export const TRIM_STATS_MAX_BYTES = 4 * 1024 * 1024;

export function trimStatsPath(agentDir) {
  return join(agentDir, "dev-con", "jev-trim.jsonl");
}

/** 建目录（**不用 recursive**：`/proc` 之类会死循环），只在父目录存在时补一层。 */
function ensureDir(dir) {
  try {
    if (existsSync(dir)) return true;
    const parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
    if (!existsSync(parent)) return false;
    mkdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** 追加一条统计；任何失败都静默（统计不是主流程）。 */
export function appendTrimStat(agentDir, record) {
  try {
    const path = trimStatsPath(agentDir);
    if (!ensureDir(join(agentDir, "dev-con"))) return false;
    try {
      if (existsSync(path) && statSync(path).size > TRIM_STATS_MAX_BYTES)
        renameSync(path, `${path}.1`);
    } catch {
      /* 轮转失败就继续追加（宁可文件大一点，也别丢数据） */
    }
    appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* 权限设置失败不算致命 */
    }
    return true;
  } catch {
    return false;
  }
}
