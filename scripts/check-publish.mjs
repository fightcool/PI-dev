import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';

const result = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
if (result.status !== 0 || result.error) throw new Error('Cannot enumerate tracked files.');
const files = result.stdout.split('\0').filter(Boolean);
if (files.length === 0) throw new Error('Stage the explicit deliverable files before running this check.');
const forbidden = /(^|\/)(node_modules|\.venv|\.tools|\.pi|\.pi-web|\.pi-lens|artifacts|sessions|uploads)(\/|$)|(^|\/)(auth|models|mcp|runtime)\.json$|(^|\/)token$|\.env($|\.)|\.(pem|key|enc|db|sqlite3?|jsonl|log)$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/,
];
let failed = false;
for (const file of files) {
  if (forbidden.test(file) && !file.endsWith('.example')) {
    console.error(`FAIL private/runtime path tracked: ${file}`);
    failed = true;
  }
  const content = readFileSync(join(ROOT, file));
  if (content.includes(0) || content.length > 5 * 1024 * 1024) {
    console.error(`FAIL binary/oversized file: ${file}`);
    failed = true;
  }
  if (secretPatterns.some((pattern) => pattern.test(content.toString('utf8')))) {
    console.error(`FAIL suspected secret in ${file} (value redacted)`);
    failed = true;
  }
}
console.log(`${failed ? 'FAIL' : 'PASS'} publication check: ${files.length} tracked files; manual review still required`);
process.exitCode = failed ? 1 : 0;
