import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Building2, LoaderCircle, ShieldCheck } from "lucide-react";

import {
  beginWeComLogin,
  completeWeComLogin,
  loginAgentPlatform,
  logoutAgentPlatform,
  readAgentPlatformCurrentUser,
  readWeComLoginConfig,
  registerAgentPlatform,
  type AgentPlatformUser,
  type WeComLoginConfig,
} from "../../lib/agent-platform/agentPlatformSession";

type AuthMode = "login" | "register";

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
            <small>Agent command workspace</small>
          </span>
        </a>
        <div className="crewon-auth-story-copy">
          <span className="crewon-auth-kicker">YOUR AGENT TEAM, READY TO WORK</span>
          <h1>今天，想让你的 Agent 小队完成什么？</h1>
          <p>
            像安排真实团队一样描述目标，CrewON 会组合员工、技能、服务和知识，
            把任务推进到可交付结果。
          </p>
          <div className="crewon-auth-task-preview" aria-hidden="true">
            <span>例如：分析本周项目风险，整理负责人和下一步，并沉淀到知识库</span>
            <b>↑</b>
          </div>
          <div className="crewon-auth-scenarios" aria-hidden="true">
            <span>整理今日事项</span>
            <span>执行代码审查</span>
            <span>生成交付方案</span>
            <span>检索企业知识</span>
          </div>
          <div className="crewon-auth-proof">
            <span>Agent 员工</span>
            <span>Skill 技能</span>
            <span>MCP 服务</span>
            <span>完整知识库</span>
          </div>
        </div>
        <p className="crewon-auth-story-foot">
          <ShieldCheck aria-hidden="true" />
          账号、权限与资源目录统一来自 agent-platform
        </p>
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
              <span>用户名</span>
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
                name="password"
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                minLength={8}
                type="password"
                required
              />
              {mode === "register" ? (
                <small>至少 8 位，包含大小写字母和数字</small>
              ) : null}
            </label>
            {mode === "register" ? (
              <label>
                <span>确认密码</span>
                <input
                  name="confirmPassword"
                  autoComplete="new-password"
                  type="password"
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

          <div className="crewon-auth-divider">
            <span>企业单点登录</span>
          </div>
          <button
            className="crewon-auth-sso"
            disabled={busy || !wecomConfig.enabled}
            title={wecomConfig.reason || undefined}
            type="button"
            onClick={onWeComLogin}
          >
            <Building2 aria-hidden="true" />
            {busy
              ? "正在连接企业微信…"
              : wecomConfig.enabled
                ? "使用企业微信登录"
                : "企业微信（配置后启用）"}
          </button>
          {!wecomConfig.enabled && wecomConfig.reason ? (
            <p className="crewon-auth-sso-note">{wecomConfig.reason}</p>
          ) : null}
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
        const code = params.get("code");
        const state = params.get("state");
        if (code && state) {
          const currentUser = await completeWeComLogin(code, state);
          params.delete("code");
          params.delete("state");
          const query = params.toString();
          window.history.replaceState(
            {},
            "",
            `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
          );
          if (!cancelled) setUser(currentUser);
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

  return (
    <>
      {children}
      <aside className="crewon-session-pill" aria-label="当前企业账号">
        <span>{user.nickname || user.username}</span>
        <small>{user.role}</small>
        <button
          type="button"
          onClick={() => {
            logoutAgentPlatform();
            setUser(null);
          }}
        >
          退出
        </button>
      </aside>
    </>
  );
}
