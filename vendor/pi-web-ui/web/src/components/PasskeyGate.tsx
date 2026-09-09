import { useState } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { appUrl } from "../base-url";

async function request(path: string, body?: unknown) {
  const response = await fetch(appUrl(`/api/auth/${path}`), { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "认证失败");
  return data;
}

export function PasskeyGate({ children }: { children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [registered, setRegistered] = useState<boolean | null>(null);
  if (ready) return <>{children}</>;
  const run = async (mode: "register" | "login") => {
    setBusy(true); setError("");
    try {
      const options = await request(`${mode}/options`);
      const response = mode === "register" ? await startRegistration({ optionsJSON: options }) : await startAuthentication({ optionsJSON: options });
      await request(`${mode}/verify`, response);
      setReady(true);
    } catch (e) { setError(e instanceof Error ? e.message : "认证失败"); }
    finally { setBusy(false); }
  };
  return <main className="passkey-gate"><section className="passkey-card"><h1>PI Web UI</h1><p>使用设备 Passkey 安全登录。</p>{registered === null ? <><button disabled={busy} onClick={() => run("login")}>使用 Passkey 登录</button><button className="secondary" disabled={busy} onClick={() => setRegistered(false)}>首次注册 Passkey</button></> : <><p>请在设备上创建 Passkey，完成后即可登录。</p><button disabled={busy} onClick={() => run("register")}>创建 Passkey</button><button className="secondary" disabled={busy} onClick={() => setRegistered(null)}>返回登录</button></>}{error && <p role="alert" className="passkey-error">{error}</p>}</section></main>;
}
