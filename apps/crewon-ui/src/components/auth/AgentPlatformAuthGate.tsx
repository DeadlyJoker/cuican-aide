import {
  createContext,
  useEffect,
  useContext,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Building2,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  X,
} from "lucide-react";

import {
  beginWeComLogin,
  completeWeComLogin,
  loginAgentPlatform,
  logoutAgentPlatform,
  readAgentPlatformCurrentUser,
  readWeComLoginConfig,
  registerAgentPlatform,
  setAgentPlatformPassword,
  type AgentPlatformUser,
  type WeComLoginConfig,
} from "../../lib/agent-platform/agentPlatformSession";
import {
  clearPimLaunchToken,
  getPimLaunchToken,
  isPimLaunchSession,
  setPimLaunchToken,
} from "../../lib/agent-platform/pimLaunchBridge";

type AuthMode = "login" | "register";

export type AgentPlatformAccount = {
  needsPassword: boolean;
  providerLabel: string;
  user: AgentPlatformUser;
  onLogout: () => void;
  onSetPassword: () => void;
};

const AgentPlatformAccountContext = createContext<AgentPlatformAccount | null>(
  null,
);

export function useAgentPlatformAccount() {
  return useContext(AgentPlatformAccountContext);
}

export function PasswordInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">,
) {
  const [visible, setVisible] = useState(false);
  const actionLabel = visible ? "隐藏密码" : "显示密码";
  return (
    <div className="crewon-auth-password-input">
      <input {...props} type={visible ? "text" : "password"} />
      <button
        aria-label={actionLabel}
        title={actionLabel}
        type="button"
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
      </button>
    </div>
  );
}

export function clearWeComCallbackParams(params: URLSearchParams) {
  params.delete("wecom_ticket");
  params.delete("code");
  params.delete("state");
  params.delete("sso_error");
  const query = params.toString();
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
}

export function SetPasswordDialog({
  busy,
  error,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (password: string) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = String(data.get("newPassword") ?? "");
    const confirmation = String(data.get("confirmPassword") ?? "");
    onSubmit(password === confirmation ? password : "");
  }

  return (
    <div className="crewon-password-backdrop" role="presentation">
      <section
        aria-labelledby="crewon-password-title"
        aria-modal="true"
        className="crewon-password-dialog"
        role="dialog"
      >
        <header>
          <span>
            <LockKeyhole aria-hidden="true" />
          </span>
          <div>
            <h2 id="crewon-password-title">设置登录密码</h2>
            <p>设置后可使用用户名或企业邮箱登录</p>
          </div>
          <button aria-label="关闭" type="button" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <form onSubmit={submit}>
          <label>
            <span>新密码</span>
            <PasswordInput name="newPassword" minLength={8} required />
          </label>
          <label>
            <span>确认密码</span>
            <PasswordInput name="confirmPassword" minLength={8} required />
          </label>
          <small>至少 8 位，包含大小写字母和数字</small>
          {error ? <p role="alert">{error}</p> : null}
          <button className="crewon-auth-submit" disabled={busy} type="submit">
            {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
            保存密码
          </button>
        </form>
      </section>
    </div>
  );
}

export function AgentPlatformAuthScreen({
  busy,
  error,
  mode,
  notice,
  onModeChange,
  onSubmit,
  onWeComLogin,
  wecomConfig,
}: {
  busy: boolean;
  error: string | null;
  mode: AuthMode;
  notice: string | null;
  onModeChange: (mode: AuthMode) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onWeComLogin: () => void;
  wecomConfig: WeComLoginConfig;
}) {
  return (
    <main className="crewon-auth-shell">
      <section className="crewon-auth-story" aria-label="CrewON 产品介绍">
        <a className="crewon-auth-brand" href="#">
          <span className="crewon-auth-brand-mark">C</span>
          <span>
            <strong>CrewON</strong>
            <small>Agent 协作工作台</small>
          </span>
        </a>
        <div className="crewon-auth-story-copy">
          <h1>CrewON 智能协作工作台</h1>
          <p>统一组织 Agent、Skill、MCP 与企业知识，协同推进任务交付。</p>
        </div>
      </section>

      <section className="crewon-auth-panel" aria-label="账号登录注册">
        <div className="crewon-auth-card">
          <header>
            <span className="crewon-auth-mobile-brand">CrewON</span>
            <h2>{mode === "login" ? "进入 CrewON" : "创建企业账号"}</h2>
            <p>
              {mode === "login"
                ? "登录后继续进入智能体工作台"
                : "注册信息将写入 agent-platform user 表"}
            </p>
          </header>

          <button
            className="crewon-auth-sso"
            disabled={busy || !wecomConfig.enabled}
            title={wecomConfig.reason || undefined}
            type="button"
            onClick={onWeComLogin}
          >
            <Building2 aria-hidden="true" />
            {busy
              ? `正在连接${wecomConfig.label}…`
              : wecomConfig.enabled
                ? `使用${wecomConfig.label}登录`
                : "企业微信（配置后启用）"}
          </button>
          {!wecomConfig.enabled && wecomConfig.reason ? (
            <p className="crewon-auth-sso-note">{wecomConfig.reason}</p>
          ) : null}

          <div className="crewon-auth-divider">
            <span>或使用账号密码</span>
          </div>

          <div
            className="crewon-auth-tabs"
            role="tablist"
            aria-label="登录或注册"
          >
            <button
              aria-selected={mode === "login"}
              className={mode === "login" ? "active" : undefined}
              role="tab"
              type="button"
              onClick={() => onModeChange("login")}
            >
              登录
            </button>
            <button
              aria-selected={mode === "register"}
              className={mode === "register" ? "active" : undefined}
              role="tab"
              type="button"
              onClick={() => onModeChange("register")}
            >
              注册
            </button>
          </div>

          <form className="crewon-auth-form" onSubmit={onSubmit}>
            <label>
              <span>{mode === "login" ? "用户名或邮箱" : "用户名"}</span>
              <input
                name="username"
                autoComplete="username"
                minLength={3}
                required
              />
            </label>
            {mode === "register" ? (
              <label>
                <span>企业邮箱</span>
                <input
                  name="email"
                  autoComplete="email"
                  type="email"
                  required
                />
              </label>
            ) : null}
            <label>
              <span>密码</span>
              <PasswordInput
                name="password"
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                minLength={8}
                required
              />
              {mode === "register" ? (
                <small>至少 8 位，包含大小写字母和数字</small>
              ) : null}
            </label>
            {mode === "register" ? (
              <label>
                <span>确认密码</span>
                <PasswordInput
                  name="confirmPassword"
                  autoComplete="new-password"
                  required
                />
              </label>
            ) : null}

            {error ? (
              <p className="crewon-auth-message error" role="alert">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p className="crewon-auth-message success">{notice}</p>
            ) : null}

            <button
              className="crewon-auth-submit"
              disabled={busy}
              type="submit"
            >
              {busy ? (
                <LoaderCircle className="spin" aria-hidden="true" />
              ) : null}
              <span>
                {busy
                  ? "处理中…"
                  : mode === "login"
                    ? "进入 CrewON"
                    : "创建账号"}
              </span>
              {!busy ? <ArrowRight aria-hidden="true" /> : null}
            </button>
          </form>

          <footer>登录即表示同意企业账号与资源访问策略</footer>
        </div>
      </section>
    </main>
  );
}

export function AgentPlatformAuthGate({ children }: { children: ReactNode }) {
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<AuthMode>("login");
  const [user, setUser] = useState<AgentPlatformUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [wecomConfig, setWeComConfig] = useState<WeComLoginConfig>({
    enabled: false,
    provider: "wecom",
    label: "企业微信",
  });

  useEffect(() => {
    let cancelled = false;
    async function initializeAccount() {
      try {
        const config = await readWeComLoginConfig();
        if (!cancelled) setWeComConfig(config);

        const params = new URLSearchParams(window.location.search);

        // --- PIM launch token path ---
        // When the user enters from a PIM showcase page, the launch token
        // anchors the session. Use it to fetch the current user and skip
        // the login screen entirely.
        if (isPimLaunchSession()) {
          try {
            const currentUser = await readAgentPlatformCurrentUser();
            if (!cancelled) setUser(currentUser);
          } catch {
            // Token is invalid or expired — clear it and let the user
            // re-enter from PIM.
            if (!cancelled) {
              clearPimLaunchToken();
              setError("演示访问会话已过期，请从 PIM 样例展示页重新进入。");
            }
          } finally {
            if (!cancelled) setChecking(false);
          }
          return;
        }

        const ssoError = params.get("sso_error");
        if (ssoError) {
          setError(
            ssoError === "access_denied"
              ? "企业账号暂时无法进入 CrewON，请重试；如仍失败请联系管理员。"
              : ssoError === "temporarily_unavailable"
                ? "企业登录服务暂时不可用，请稍后重试。"
                : "企业登录未完成，请重新扫码登录。",
          );
          clearWeComCallbackParams(params);
          return;
        }
        const ticket = params.get("wecom_ticket");
        if (ticket) {
          try {
            const currentUser = await completeWeComLogin(ticket);
            if (!cancelled) setUser(currentUser);
          } finally {
            clearWeComCallbackParams(params);
          }
          return;
        }
        const currentUser = await readAgentPlatformCurrentUser();
        if (!cancelled) setUser(currentUser);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "账号服务不可用");
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    }
    void initializeAccount();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const data = new FormData(event.currentTarget);
    const username = String(data.get("username") ?? "").trim();
    const password = String(data.get("password") ?? "");
    try {
      if (mode === "login") {
        setUser(await loginAgentPlatform(username, password));
        return;
      }
      const confirmPassword = String(data.get("confirmPassword") ?? "");
      if (password !== confirmPassword) {
        throw new Error("两次输入的密码不一致");
      }
      const registration = await registerAgentPlatform({
        username,
        email: String(data.get("email") ?? "").trim(),
        password,
      });
      if (registration.access_token) {
        setUser(await readAgentPlatformCurrentUser());
      } else {
        setMode("login");
        setNotice("注册申请已提交，请完成邮箱验证或等待管理员审批后登录。");
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "请求失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  }

  async function loginWithWeCom() {
    setBusy(true);
    setError(null);
    try {
      window.location.assign(await beginWeComLogin());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "企业微信登录失败");
      setBusy(false);
    }
  }

  async function saveInitialPassword(password: string) {
    if (!password) {
      setPasswordError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    setPasswordError(null);
    try {
      await setAgentPlatformPassword(password);
      setUser((current) =>
        current ? { ...current, password_login_enabled: true } : current,
      );
      setPasswordDialogOpen(false);
    } catch (reason) {
      setPasswordError(
        reason instanceof Error ? reason.message : "设置登录密码失败",
      );
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <div className="crewon-auth-checking">
        <span className="crewon-auth-brand-mark">C</span>
        <LoaderCircle className="spin" aria-hidden="true" />
        <p>正在连接企业账号与资源目录…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <AgentPlatformAuthScreen
        busy={busy}
        error={error}
        mode={mode}
        notice={notice}
        onModeChange={(nextMode) => {
          setMode(nextMode);
          setError(null);
          setNotice(null);
        }}
        onSubmit={submit}
        onWeComLogin={() => void loginWithWeCom()}
        wecomConfig={wecomConfig}
      />
    );
  }

  const wecomLinked = user.linked_providers?.includes("wecom") ?? false;
  const needsPassword = user.password_login_enabled === false;
  const logout = () => {
    setBusy(true);
    // When in a PIM launch session, clearing the token is sufficient —
    // there is no server-side session to destroy.
    if (isPimLaunchSession()) {
      clearPimLaunchToken();
      setUser(null);
      setBusy(false);
      return;
    }
    void logoutAgentPlatform()
      .catch(() => undefined)
      .finally(() => {
        setUser(null);
        setBusy(false);
      });
  };
  return (
    <AgentPlatformAccountContext.Provider
      value={{
        needsPassword,
        providerLabel: wecomLinked
          ? "企业微信已绑定"
          : user.role === "admin"
            ? "管理员"
            : "用户",
        user,
        onLogout: logout,
        onSetPassword: () => setPasswordDialogOpen(true),
      }}
    >
      {children}
      <aside className="crewon-session-pill" aria-label="当前企业账号">
        <span>{user.display_name || user.nickname || user.username}</span>
        <small>{wecomLinked ? "企业微信已绑定" : user.role}</small>
        {needsPassword ? (
          <button
            className="security"
            type="button"
            onClick={() => setPasswordDialogOpen(true)}
          >
            设置密码
          </button>
        ) : null}
        <button type="button" onClick={logout}>
          退出
        </button>
      </aside>
      {passwordDialogOpen ? (
        <SetPasswordDialog
          busy={busy}
          error={passwordError}
          onClose={() => {
            setPasswordDialogOpen(false);
            setPasswordError(null);
          }}
          onSubmit={(password) => void saveInitialPassword(password)}
        />
      ) : null}
    </AgentPlatformAccountContext.Provider>
  );
}
