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
    const session = await auth.recovery(codes[0]);
    expect(session).toBeTruthy();
    expect(auth.valid(session!)).toBe(true);
    expect(await auth.recovery(codes[0])).toBeNull();
    const sessions = JSON.parse(await readFile(join(dir, "webauthn.json"), "utf8")).sessions as Record<string, unknown>;
    expect(sessions).toHaveProperty(createHash("sha256").update(session!).digest("base64url"));
    expect(sessions).not.toHaveProperty(session!);
  });
});
