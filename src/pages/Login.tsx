import { FormEvent, useState } from "react";
import { api } from "../api";
import { Button, Field, inputCls } from "../components/ui";

export default function Login({ setupRequired, onDone }: { setupRequired: boolean; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (setupRequired && password !== password2) return setError("兩次輸入的密碼不一樣");
    setBusy(true);
    try {
      if (setupRequired) await api("/api/auth/setup", { method: "POST", json: { code, username, password } });
      else await api("/api/auth/login", { method: "POST", json: { username, password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="safe-top flex min-h-screen flex-col bg-ink px-6 text-rose">
      <div className="mx-auto w-full max-w-sm flex-1 pt-[12vh]">
        <div className="arch-dark mx-auto mb-8 grid h-36 w-28 place-items-center text-4xl text-rose">✝</div>
        <h1 className="text-center font-serif text-[28px] font-bold tracking-[0.15em]">電子衣櫃</h1>
        <p className="mt-2 text-center text-sm text-mauve">{setupRequired ? "首次使用，請建立你的帳戶" : "登入你的私人衣櫃"}</p>
        <form onSubmit={submit} className="mt-8 space-y-4 [&_span]:text-rose/70">
          {setupRequired && (
            <Field label="首次設定碼">
              <input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" required />
            </Field>
          )}
          <Field label="用戶名稱">
            <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" required />
          </Field>
          <Field label="密碼">
            <input
              className={inputCls}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={setupRequired ? "new-password" : "current-password"}
              minLength={setupRequired ? 8 : undefined}
              required
            />
          </Field>
          {setupRequired && (
            <Field label="再次輸入密碼">
              <input className={inputCls} type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" required />
            </Field>
          )}
          {error && <p className="rounded-2xl bg-wine/20 px-4 py-2 text-sm text-rose">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "請稍候…" : setupRequired ? "建立帳戶" : "登入"}
          </Button>
        </form>
      </div>
    </div>
  );
}
