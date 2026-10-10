import {
  createContext,
  useEffect,
  useContext,
  useState,
  useRef,
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
import { isAgentPlatformAuthTransientError } from "../../lib/agent-platform/agentPlatformAuthBootstrap";
import {
  crewonUnifiedSsoEnabled,
  captureAgentPlatformSession,
  assertAgentPlatformSessionCurrent,
  type AgentPlatformSessionSnapshot,
  AGENT_PLATFORM_TOKEN_STORAGE_KEY,
  AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
} from "../../lib/agent-platform/agentPlatformClient";
import {
  clearPimLaunchToken,
  isPimLaunchSession,
} from "../../lib/agent-platform/pimLaunchBridge";
import {
  DesktopLocalManagementAccessProvider,
  useNativeLocalManagementAccess,
} from "../../lib/desktop/DesktopLocalManagementContext";
import { isDesktopLocalManagementAccess } from "../../lib/desktop/desktopLocalManagementAccess";

import {
  AgentPlatformAccountRestoration,
  type AgentPlatformAccountState,
} from "../../lib/agent-platform/agentPlatformAccountRestoration";

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
  onReturnToLocalManagement?: () => void;
  onRetryAccount?: () => void;
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

          {wecomConfig.enabled === true && wecomConfig.provider === "wecom" ? (
            <>
              <button
                className="crewon-auth-sso"
                disabled={busy}
                type="button"
                onClick={onWeComLogin}
              >
                <Building2 aria-hidden="true" />
                使用{wecomConfig.label}登录
              </button>
              <div className="crewon-auth-divider">
                <span>或使用账号密码</span>
              </div>
            </>
          ) : null}

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
              <input
                type="password"
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
  const localManagementAccess = useNativeLocalManagementAccess();
  const [enterpriseLoginRequested, setEnterpriseLoginRequested] =
    useState(false);
  const [localManagementRequested, setLocalManagementRequested] =
    useState(false);
  const restorationRef = useRef<AgentPlatformAccountRestoration | null>(null);
  if (!restorationRef.current) {
    restorationRef.current = new AgentPlatformAccountRestoration({
      read: (signal) => readAgentPlatformCurrentUser({ signal }),
      hasCredentials: () =>
        hasStoredAccountSession() ||
        isPimLaunchSession() ||
        crewonUnifiedSsoEnabled(),
      isTransient: isAgentPlatformAuthTransientError,
      events: window,
    });
  }
  const restoration = restorationRef.current;
  const interactionEpoch = useRef(0);
  const actionCurrent = (
    epoch: number,
    session?: AgentPlatformSessionSnapshot,
  ) => {
    if (interactionEpoch.current !== epoch) return false;
    if (session) {
      try {
        assertAgentPlatformSessionCurrent(session);
      } catch {
        return false;
      }
    }
    return true;
  };
  const recoverAccountAction = (reason: unknown) => {
    // A late failed account action has no authority over a newly verified user.
    if (restoration.state.status === "authenticated") return;
    if (
      hasStoredAccountSession() ||
      isPimLaunchSession() ||
      crewonUnifiedSsoEnabled() ||
      (reason instanceof Error &&
        reason.message === "agent_platform_session_changed")
    ) {
      setError(null);
      restoration.resume();
      return;
    }
    restoration.accept(null);
    setError(reason instanceof Error ? reason.message : "请求失败，请稍后重试");
  };
  const callbackOperation = useRef<{
    ticket: string;
    pending: Promise<AgentPlatformUser>;
  } | null>(null);
  const [accountState, setAccountState] = useState<AgentPlatformAccountState>(
    restoration.state,
  );
  const user =
    accountState.status === "authenticated" ? accountState.user : null;
  const checking = accountState.status === "restoring";
  const setUser = (
    next:
      | AgentPlatformUser
      | null
      | ((current: AgentPlatformUser | null) => AgentPlatformUser | null),
  ) => {
    const current =
      restoration.state.status === "authenticated"
        ? restoration.state.user
        : null;
    restoration.accept(typeof next === "function" ? next(current) : next);
  };
  const storedAccountSession = hasStoredAccountSession();
  const hadStoredAccountSession = useRef(storedAccountSession).current;
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<AuthMode>("login");
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
    const configController = new AbortController();
    const unsubscribe = restoration.subscribe((state) => {
      setAccountState(state);
      if (state.status === "authenticated") {
        setBusy(false);
        setError(null);
      }
      if (state.status === "restoring") {
        setPasswordDialogOpen(false);
        setPasswordError(null);
      }
    });
    const configSession = captureAgentPlatformSession();
    void Promise.resolve()
      .then(() => {
        configController.signal.throwIfAborted();
        return readWeComLoginConfig({ signal: configController.signal });
      })
      .then(
        (config) => {
          if (!cancelled) {
            try {
              assertAgentPlatformSessionCurrent(configSession);
            } catch {
              return;
            }
            setWeComConfig(config);
          }
        },
        () => undefined,
      );

    const params = new URLSearchParams(window.location.search);
    const ssoError = params.get("sso_error");
    const ticket = params.get("wecom_ticket");
    if (ssoError || ticket) {
      restoration.suspend();
      if (ssoError) {
        restoration.accept(
          null,
          ssoError === "access_denied"
            ? "企业账号暂时无法进入 CrewON，请重试；如仍失败请联系管理员。"
            : ssoError === "temporarily_unavailable"
              ? "企业登录服务暂时不可用，请稍后重试。"
              : "企业登录未完成，请重新扫码登录。",
        );
        clearWeComCallbackParams(params);
      } else if (ticket) {
        if (callbackOperation.current?.ticket !== ticket) {
          callbackOperation.current = {
            ticket,
            pending: completeWeComLogin(ticket),
          };
        }
        const callbackEpoch = interactionEpoch.current;
        void callbackOperation.current.pending
          .then(
            (currentUser) => {
              if (!cancelled && actionCurrent(callbackEpoch))
                restoration.accept(currentUser);
            },
            (reason) => {
              if (!cancelled && actionCurrent(callbackEpoch))
                recoverAccountAction(reason);
            },
          )
          .finally(() => {
            if (!cancelled) clearWeComCallbackParams(params);
          });
      }
    }
    return () => {
      cancelled = true;
      ++interactionEpoch.current;
      configController.abort();
      unsubscribe();
    };
  }, [restoration]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const actionEpoch = ++interactionEpoch.current;
    restoration.suspend();
    setBusy(true);
    setError(null);
    setNotice(null);
    const data = new FormData(event.currentTarget);
    const username = String(data.get("username") ?? "").trim();
    const password = String(data.get("password") ?? "");
    try {
      if (mode === "login") {
        const currentUser = await loginAgentPlatform(username, password);
        if (actionCurrent(actionEpoch)) setUser(currentUser);
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
      if (!actionCurrent(actionEpoch)) return;
      if (registration.access_token) {
        const currentUser = await readAgentPlatformCurrentUser();
        if (actionCurrent(actionEpoch)) setUser(currentUser);
      } else {
        restoration.accept(null);
        setMode("login");
        setNotice("注册申请已提交，请完成邮箱验证或等待管理员审批后登录。");
      }
    } catch (reason) {
      if (actionCurrent(actionEpoch)) recoverAccountAction(reason);
    } finally {
      if (actionCurrent(actionEpoch)) setBusy(false);
    }
  }

  async function loginWithWeCom() {
    const actionEpoch = ++interactionEpoch.current;
    const actionSession = captureAgentPlatformSession();
    restoration.suspend();
    setBusy(true);
    setError(null);
    try {
      const loginUrl = await beginWeComLogin();
      if (actionCurrent(actionEpoch, actionSession))
        window.location.assign(loginUrl);
      else if (actionCurrent(actionEpoch)) restoration.resume();
    } catch (reason) {
      if (actionCurrent(actionEpoch)) {
        recoverAccountAction(reason);
        setBusy(false);
      }
    }
  }

  async function saveInitialPassword(password: string) {
    if (!password) {
      setPasswordError("两次输入的密码不一致");
      return;
    }
    const actionEpoch = ++interactionEpoch.current;
    const actionSession = captureAgentPlatformSession();
    setBusy(true);
    setPasswordError(null);
    try {
      await setAgentPlatformPassword(password);
      if (!actionCurrent(actionEpoch, actionSession)) return;
      setUser((current) =>
        current ? { ...current, password_login_enabled: true } : current,
      );
      setPasswordDialogOpen(false);
    } catch (reason) {
      if (actionCurrent(actionEpoch, actionSession))
        setPasswordError(
          reason instanceof Error ? reason.message : "设置登录密码失败",
        );
    } finally {
      if (actionCurrent(actionEpoch, actionSession)) setBusy(false);
    }
  }

  if (
    !user &&
    !checking &&
    localManagementAccess &&
    !enterpriseLoginRequested &&
    ((!hadStoredAccountSession && !storedAccountSession) ||
      localManagementRequested)
  ) {
    return (
      <DesktopLocalManagementAccessProvider
        access={localManagementAccess}
        onLoginAccount={() => {
          setEnterpriseLoginRequested(true);
          setLocalManagementRequested(false);
        }}
      >
        <AgentPlatformAccountContext.Provider value={null}>
          {children}
        </AgentPlatformAccountContext.Provider>
      </DesktopLocalManagementAccessProvider>
    );
  }

  if (checking) {
    return (
      <div
        className="crewon-auth-checking"
        role="status"
        data-account-state="restoring"
      >
        <span className="crewon-auth-brand-mark">C</span>
        <LoaderCircle className="spin" aria-hidden="true" />
        <p>
          {accountState.status === "restoring" && accountState.unavailable
            ? "账号连接暂不可用，正在自动重连…"
            : "正在恢复登录状态…"}
        </p>
      </div>
    );
  }

  if (!user) {
    return (
      <AgentPlatformAuthScreen
        busy={busy}
        error={
          error ??
          (accountState.status === "anonymous" ? accountState.error : null)
        }
        mode={mode}
        notice={notice}
        onModeChange={(nextMode) => {
          setMode(nextMode);
          setError(null);
          setNotice(null);
        }}
        onSubmit={submit}
        onWeComLogin={() => void loginWithWeCom()}
        onReturnToLocalManagement={
          localManagementAccess
            ? () => {
                if (isDesktopLocalManagementAccess(localManagementAccess)) {
                  setEnterpriseLoginRequested(false);
                  setLocalManagementRequested(true);
                }
              }
            : undefined
        }
        wecomConfig={wecomConfig}
      />
    );
  }

  const wecomLinked = user.linked_providers?.includes("wecom") ?? false;
  const needsPassword = user.password_login_enabled === false;
  const logout = () => {
    const actionEpoch = ++interactionEpoch.current;
    restoration.suspend();
    setBusy(true);
    setUser(null);
    // The account function withdraws credentials synchronously. Capture its
    // resulting session so a later account B supersedes this logout's cleanup.
    const pendingLogout = isPimLaunchSession()
      ? Promise.resolve(clearPimLaunchToken())
      : logoutAgentPlatform();
    const actionSession = captureAgentPlatformSession();
    void pendingLogout
      .catch(() => undefined)
      .finally(() => {
        if (!actionCurrent(actionEpoch, actionSession)) return;
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

function hasStoredAccountSession(): boolean {
  try {
    return Boolean(
      localStorage.getItem(AGENT_PLATFORM_TOKEN_STORAGE_KEY) ||
        localStorage.getItem(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY),
    );
  } catch {
    // An unavailable credential store must not silently authorize a different mode.
    return true;
  }
}
