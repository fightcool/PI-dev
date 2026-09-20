/* 🍞 AI Breadcrumb — @COUPLED index.ts, ../../tests/jev-hook.test.mjs
 * 📖 docs/JEV-HOOK.md
 * @WHY Recognize only literal, straight-line shell commands. Never evaluate shell text.
 */
import { resolve } from "node:path";

/** A deliberately small shell lexer: unsupported syntax means no interception. */
function commands(source) {
  const result = [];
  let words = [], word = "", active = false, quote = "";
  const flush = () => { if (active) words.push(word); word = ""; active = false; };
  const end = () => { flush(); if (words.length) result.push(words); words = []; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) { quote = ""; continue; }
      if (quote === '"' && /[$`\\]/.test(c)) return null;
      word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (c === "\\" && source[i + 1] === "\n") { i++; continue; }
    if (/[$`\\<>|(){}*?[\]~]/.test(c)) return null;
    if (c === "#" && !active) {
      while (i < source.length && source[i] !== "\n") i++;
      end();
      continue;
    }
    if (c === "&") {
      if (source[++i] !== "&") return null;
      end();
    } else if (c === ";" || c === "\n") end();
    else if (/\s/.test(c)) flush();
    else { word += c; active = true; }
  }
  if (quote) return null;
  end();
  // Do not treat a line inside a control structure/function as an unconditional command.
  if (result.some((w) => /^(if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|!|time)$/.test(w[0]))) return null;
  return result;
}

function commitOptions(args) {
  let amend = false, unsupported;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (["--dry-run", "--help", "-h"].includes(a)) return null;
    if (a === "--amend") amend = true;
    else if (["-m", "--message", "-F", "--file", "--author", "--date", "-C", "--reuse-message", "-c", "--reedit-message", "--cleanup", "--trailer"].includes(a)) {
      if (args[++i] === undefined) return null;
    } else if (/^(--(message|file|author|date|reuse-message|reedit-message|cleanup|trailer)=|-m.+|-F.+)/.test(a)) continue;
    else if (["--no-edit", "--allow-empty", "--allow-empty-message", "--no-verify", "-n", "--no-gpg-sign", "--signoff", "-s", "--quiet", "-q", "--verbose", "-v", "--reset-author"].includes(a) || /^(-S|--gpg-sign)(=|$)/.test(a)) continue;
    else unsupported = "提交选项可能改变暂存内容（如 -a、路径选择、交互暂存），无法确定提交 diff";
  }
  return { amend, unsupported };
}

/** @returns {{cwd: string, amend: boolean, unsupported?: string}[]} */
export function detectCommits(command, cwd) {
  if (typeof command !== "string" || !command.includes("commit")) return [];
  const parts = commands(command);
  if (!parts) return [];
  const commits = [];
  let prefixChanged = false;
  for (const words of parts) {
    if (words[0] === "cd" && words.length === 2 && !words[1].startsWith("-")) {
      cwd = resolve(cwd, words[1]);
      continue;
    }
    let i = words[0] === "command" ? 1 : 0;
    if (!["git", "/usr/bin/git", "/bin/git"].includes(words[i])) { prefixChanged = true; continue; }
    i++;
    let repo = cwd, configUnsupported = false;
    while (i < words.length) {
      const a = words[i];
      if (a === "-C") { if (words[++i] === undefined) return []; repo = resolve(repo, words[i++]); }
      else if (a.startsWith("-C") && a.length > 2) { repo = resolve(repo, a.slice(2)); i++; }
      else if (a === "-c") {
        if (words[++i] === undefined) return [];
        // Identity/colour settings do not change the tree. Other overrides are not replayed.
        if (!/^(user\.(name|email)|color\.[\w.-]+)=/.test(words[i++])) configUnsupported = true;
      } else if (a.startsWith("-c") && a.length > 2) { configUnsupported = true; i++; }
      else if (["--no-pager", "--no-optional-locks"].includes(a)) i++;
      else break;
    }
    if (words[i] !== "commit") { prefixChanged = true; continue; }
    const options = commitOptions(words.slice(i + 1));
    if (!options) continue;
    commits.push({ cwd: repo, ...options, unsupported: options.unsupported ??
      (prefixChanged ? "提交前有其它命令，暂存区可能尚未就绪；请将暂存和提交拆成两次工具调用" :
        configUnsupported ? "git -c 覆盖可能改变仓库或提交行为，无法确定提交 diff" : undefined) });
    prefixChanged = true;
  }
  return commits;
}
