import { useState, type FormEvent } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { appUrl } from "../base-url";
import { authToken, setAuthToken } from "../auth-token";

async function request(path: string, body?: unknown) {
  const response = await fetch(appUrl(`/api/auth/${path}`), { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "认证失败");
  return data;
}

export function PasskeyGate({ children }: { children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A deployment protected by PI_WEB_TOKEN can be entered from a browser that
  // does not have the phone's synced Passkey. `?token=…` is absorbed by
  // initAuthToken() before this component renders; accepting that persisted
  // token here lets the server-side token middleware authorize API/WS calls.
  // When no token is present, retain the Passkey gate for local/device login.
  const [ready, setReady] = useState(() => Boolean(authToken()));
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [tokenMode, setTokenMode] = useState(false);
  const [tokenValue, setTokenValue] = useState("");
  const [showToken, setShowToken] = useState(false);
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
  const runTokenLogin = async (event: FormEvent) => {
    event.preventDefault();
    const token = tokenValue.trim();
    if (!token) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(appUrl(`/api/themes?token=${encodeURIComponent(token)}`));
      if (!response.ok) throw new Error("访问口令不正确");
      setAuthToken(token);
      setReady(true);
    } catch (e) { setError(e instanceof Error ? e.message : "登录失败"); }
    finally { setBusy(false); }
  };
  return <main className="passkey-gate"><section className="passkey-card"><h1>PI Web UI</h1>{tokenMode ? <><p>输入服务器访问口令登录当前浏览器。</p><p className="passkey-hint">口令在服务器上，运行 <code>cat ~/.config/pi-dev/token</code> 查看。</p><form onSubmit={runTokenLogin} style={{ display: "flex", gap: ".4rem", alignItems: "center" }}><input type={showToken ? "text" : "password"} value={tokenValue} onChange={(event) => setTokenValue(event.target.value)} autoComplete="current-password" autoFocus required style={{ flex: 1 }} /><button type="button" className="secondary" disabled={busy} onClick={() => setShowToken((v) => !v)} aria-label={showToken ? "隐藏口令" : "显示口令"}>{showToken ? "隐藏" : "显示"}</button><button disabled={busy}>使用访问口令登录</button></form><button className="secondary" disabled={busy} onClick={() => { setTokenMode(false); setError(""); }}>返回 Passkey 登录</button></> : <><p>使用设备 Passkey 安全登录。</p>{registered === null ? <><button disabled={busy} onClick={() => run("login")}>使用 Passkey 登录</button><button className="secondary" disabled={busy} onClick={() => setRegistered(false)}>首次注册 Passkey</button><button className="secondary" disabled={busy} onClick={() => setTokenMode(true)}>使用访问口令登录</button></> : <><p>请在设备上创建 Passkey，完成后即可登录。</p><button disabled={busy} onClick={() => run("register")}>创建 Passkey</button><button className="secondary" disabled={busy} onClick={() => setRegistered(null)}>返回登录</button></>}</>}{error && <p role="alert" className="passkey-error">{error}</p>}</section></main>;
}
