/* 🍞 AI Breadcrumb — @COUPLED ../extensions/jev-gate/index.ts
 * 📖 docs/JEV-HOOK.md — official global extensions/*.ts discovery, without settings edits.
 */
import { mkdirSync, readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../extensions/jev-gate/index.ts", import.meta.url));
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const target = resolve(agentDir, "extensions/jev-gate.ts");
const content = `// Managed by PI-dev scripts/install-jev-hook.mjs\nexport { default } from ${JSON.stringify(source)};\n`;
const action = process.argv[2] ?? "install";
if (!["install", "uninstall"].includes(action)) throw new Error("Use install or uninstall");
if (existsSync(target) && readFileSync(target, "utf8") !== content) {
  throw new Error("已有不同的 jev-gate.ts；请先确认其来源并用原安装目录卸载，拒绝覆盖。");
}
if (action === "uninstall") {
  if (existsSync(target)) unlinkSync(target);
  console.log(`已卸载 ${target}；现有会话需 /reload 或重新创建。`);
} else {
  mkdirSync(resolve(agentDir, "extensions"), { recursive: true });
  if (!existsSync(target)) writeFileSync(target, content, { mode: 0o600, flag: "wx" });
  console.log(`已安装 ${target} → ${source}`);
  console.log("新会话自动加载；现有会话执行 /reload，或在宿主中重新创建会话运行时。");
}
