import { describe, expect, test } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebAuthnAuth } from "../../server/webauthn-auth";

describe("WebAuthn 持久化认证状态", () => {
  test("恢复码一次性消费并持久化会话", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-webauthn-"));
    const auth = new WebAuthnAuth(dir, "localhost", "https://localhost");
    await auth.load();
    const codes = await auth.recoveryCodes();
    // 落盘只存哈希：明文不出现在 webauthn.json 里（§4 凭据不回传/不裸存）。
    const raw = await readFile(join(dir, "webauthn.json"), "utf8");
    expect(raw).not.toContain(codes[0]);
    expect(JSON.parse(raw).recovery[0]).toBe(`sha256:${createHash("sha256").update(codes[0]).digest("base64url")}`);
    // 已有码时不再回显（哈希不可逆）。
    await expect(auth.recoveryCodes()).rejects.toThrow(/already exist/);
    const session = await auth.recovery(codes[0]);
    expect(session).toBeTruthy();
    expect(auth.valid(session!)).toBe(true);
    expect(await auth.recovery(codes[0])).toBeNull();
    const sessions = JSON.parse(await readFile(join(dir, "webauthn.json"), "utf8")).sessions as Record<string, unknown>;
    expect(sessions).toHaveProperty(createHash("sha256").update(session!).digest("base64url"));
    expect(sessions).not.toHaveProperty(session!);
  });

  test("旧版明文恢复码仍可登录，并在消费时迁移为哈希", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-webauthn-legacy-"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(dir, "webauthn.json"),
      JSON.stringify({ credentials: [], challenges: {}, sessions: {}, recovery: ["legacyplaintext", "sha256:deadbeef"] }),
      { mode: 0o600 },
    );
    const auth = new WebAuthnAuth(dir, "localhost", "https://localhost");
    await auth.load();
    const session = await auth.recovery("legacyplaintext");
    expect(session).toBeTruthy();
    const after = JSON.parse(await readFile(join(dir, "webauthn.json"), "utf8"));
    expect(after.recovery).toEqual(["sha256:deadbeef"]);
    expect(await auth.recovery("legacyplaintext")).toBeNull();
  });
});
