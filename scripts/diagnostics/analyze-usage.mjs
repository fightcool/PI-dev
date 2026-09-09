#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import readline from "node:readline";

const input = process.argv[2];
if (!input || process.argv.includes("--help")) {
  console.error("Usage: node scripts/diagnostics/analyze-usage.mjs <csv>");
  process.exit(input ? 0 : 2);
}

const file = resolve(input);
const info = await stat(file).catch(() => null);
if (!info?.isFile()) throw new Error(`CSV file not found: ${file}`);

const rl = readline.createInterface({
  input: createReadStream(file),
  crlfDelay: Infinity,
});
let header;
const rows = [];
for await (const line of rl) {
  if (!line.trim()) continue;
  const cells = line.split(",");
  if (!header) {
    header = cells.map((cell) => cell.replace(/^\uFEFF/, ""));
    continue;
  }
  if (cells.length < header.length) continue;
  const row = Object.fromEntries(header.map((name, i) => [name, cells[i]]));
  const inputTokens = Number(row["提示词tokens"]);
  if (row["类型"] === "consume" && Number.isFinite(inputTokens))
    rows.push({
      time: row["时间"],
      inputTokens,
      outputTokens: Number(row["补全tokens"]) || 0,
      cost: Number(row["花费"]) || 0,
      status: row["类型"],
    });
}
if (!rows.length) throw new Error("No consumable rows found");
const sum = (values) => values.reduce((total, value) => total + value, 0);
const sorted = [...rows].sort((a, b) => b.inputTokens - a.inputTokens);
const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor((1 - p) * sorted.length))].inputTokens;
const thresholds = [10_000, 50_000, 100_000, 200_000, 500_000, 1_000_000];
const result = {
  file: basename(file),
  consumeRequests: rows.length,
  inputTokensTotal: sum(rows.map((row) => row.inputTokens)),
  outputTokensTotal: sum(rows.map((row) => row.outputTokens)),
  costTotal: sum(rows.map((row) => row.cost)),
  maxInputTokens: sorted[0].inputTokens,
  thresholds: Object.fromEntries(thresholds.map((threshold) => [String(threshold), rows.filter((row) => row.inputTokens >= threshold).length])),
  distribution: {
    under10k: rows.filter((row) => row.inputTokens < 10_000).length,
    from10kTo100k: rows.filter((row) => row.inputTokens >= 10_000 && row.inputTokens < 100_000).length,
    from100kTo250k: rows.filter((row) => row.inputTokens >= 100_000 && row.inputTokens < 250_000).length,
    from250kTo500k: rows.filter((row) => row.inputTokens >= 250_000 && row.inputTokens < 500_000).length,
    over500k: rows.filter((row) => row.inputTokens >= 500_000).length,
  },
  percentiles: {
    p50: percentile(0.5),
    p90: percentile(0.9),
    p99: percentile(0.99),
  },
  largestRequests: sorted.slice(0, 10).map(({ time, inputTokens, outputTokens, cost }) => ({ time, inputTokens, outputTokens, cost })),
};
console.log(JSON.stringify(result, null, 2));
