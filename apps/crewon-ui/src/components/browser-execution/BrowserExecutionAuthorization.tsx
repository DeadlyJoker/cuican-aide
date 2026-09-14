import { useId, useLayoutEffect, useRef, useState } from "react";
import type {
  BrowserExecutionAuthorizationState,
  BrowserExecutionBridge,
  BrowserGrantRule,
  BrowserGrantScope,
  BrowserSkillRef,
} from "../../lib/browser-execution/browserExecutionGrant";
import "./BrowserExecutionAuthorization.css";

export type BrowserExecutionAuthorizationProps = {
  threadId: string | null;
  skillVersionRef: BrowserSkillRef;
  scope?: BrowserGrantScope;
  bridge?: BrowserExecutionBridge;
  onAuthorized?: () => void;
};

export function BrowserExecutionAuthorization(
  props: BrowserExecutionAuthorizationProps,
) {
  // A task or reviewed scope change must not reuse local state or async callbacks.
  const identity = JSON.stringify([
    props.threadId,
    props.skillVersionRef.skillId,
    props.skillVersionRef.versionId,
    props.skillVersionRef.contentDigest,
    props.scope ?? null,
  ]);
  return <AuthorizationPanel key={identity} {...props} />;
}

function AuthorizationPanel({
  threadId,
  skillVersionRef,
  scope,
  bridge: injectedBridge,
  onAuthorized,
}: BrowserExecutionAuthorizationProps) {
  const bridge =
    injectedBridge ??
    (typeof window === "undefined"
      ? undefined
      : window.crewonDesktop?.browserExecution);
  const titleId = useId();
  const statusId = useId();
  const [grant, setGrant] = useState<BrowserExecutionAuthorizationState | null>(
    null,
  );
  const [phase, setPhase] = useState<
    "loading" | "ready" | "authorizing" | "revoking"
  >(bridge && threadId ? "loading" : "ready");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lifecycle = useRef(0);
  const request = useRef(0);
  const mutationPending = useRef(false);
  const refreshStatus = useRef<() => void>(() => undefined);
  const blockedReason = !threadId?.trim()
    ? "请先选择一个任务"
    : !bridge
      ? "当前浏览器未连接"
      : scopeIssue(scope, skillVersionRef);

  // Invalidate callbacks during the commit, before an old task's promise can settle.
  useLayoutEffect(() => {
    const generation = ++lifecycle.current;
    mutationPending.current = false;
    setGrant(null);
    setNotice(null);
    setError(null);
    if (!bridge || !threadId?.trim()) {
      setPhase("ready");
      return;
    }
    const refresh = async () => {
      if (mutationPending.current) return;
      const currentRequest = ++request.current;
      setPhase("loading");
      setError(null);
      try {
        const result = await bridge.status(threadId);
        if (
          generation !== lifecycle.current ||
          currentRequest !== request.current
        )
          return;
        if (result !== null && !matchesThread(result, threadId)) {
          throw new Error("browser_authorization_status_mismatch");
        }
        setGrant(result);
      } catch {
        if (
          generation !== lifecycle.current ||
          currentRequest !== request.current
        )
          return;
        setError("无法读取浏览器授权，请重试。");
      } finally {
        if (
          generation === lifecycle.current &&
          currentRequest === request.current
        )
          setPhase("ready");
      }
    };
    refreshStatus.current = () => {
      void refresh();
    };
    void refresh();
    window.addEventListener("focus", refreshStatus.current);
    return () => {
      lifecycle.current += 1;
      window.removeEventListener("focus", refreshStatus.current);
      refreshStatus.current = () => undefined;
    };
  }, [bridge, threadId]);

  const authorize = async () => {
    if (
      !bridge ||
      !threadId ||
      blockedReason ||
      phase !== "ready" ||
      mutationPending.current
    )
      return;
    const generation = lifecycle.current;
    const currentRequest = ++request.current;
    mutationPending.current = true;
    setPhase("authorizing");
    setError(null);
    setNotice(null);
    try {
      const result = await bridge.authorize({
        threadId,
        ...(scope ? { scope } : {}),
      });
      if (
        generation !== lifecycle.current ||
        currentRequest !== request.current
      )
        return;
      if (
        !matchesThread(result, threadId) ||
        result.mode !== (scope ? "scoped" : "perAction")
      ) {
        throw new Error("browser_authorization_result_mismatch");
      }
      setGrant(result);
      onAuthorized?.();
    } catch {
      if (
        generation !== lifecycle.current ||
        currentRequest !== request.current
      )
        return;
      setError("授权未完成，请确认教学浏览器已打开并结束录制后重试。");
    } finally {
      if (
        generation === lifecycle.current &&
        currentRequest === request.current
      ) {
        mutationPending.current = false;
        setPhase("ready");
      }
    }
  };

  const revoke = async () => {
    if (!bridge || !threadId || !grant || mutationPending.current) return;
    const generation = lifecycle.current;
    const currentRequest = ++request.current;
    mutationPending.current = true;
    setPhase("revoking");
    setError(null);
    setNotice(null);
    try {
      await bridge.revoke(threadId);
      if (
        generation !== lifecycle.current ||
        currentRequest !== request.current
      )
        return;
      setGrant(null);
      setNotice("授权已撤销，浏览器由你接管。");
    } catch {
      if (
        generation !== lifecycle.current ||
        currentRequest !== request.current
      )
        return;
      setError("撤销未完成，请重试。");
    } finally {
      if (
        generation === lifecycle.current &&
        currentRequest === request.current
      ) {
        mutationPending.current = false;
        setPhase("ready");
      }
    }
  };

  const status =
    blockedReason ??
    (phase === "loading"
      ? "正在读取浏览器授权…"
      : phase === "authorizing"
        ? "正在授权…"
        : phase === "revoking"
          ? "正在接管并撤销授权…"
          : grant
            ? `已授权 · ${grant.mode === "scoped" ? "限定范围连续执行" : "逐次确认"}`
            : (notice ?? "尚未授权"));

  return (
    <section
      className="browser-execution-authorization"
      aria-labelledby={titleId}
      aria-busy={phase !== "ready"}
    >
      <header>
        <h3 id={titleId}>浏览器执行授权</h3>
        <p id={statusId} role="status" aria-live="polite">
          {status}
        </p>
      </header>
      <div className="browser-execution-authorization-scope">
        <strong>本次授权方式：{scope ? "限定范围连续执行" : "逐次确认"}</strong>
        {scope ? (
          <>
            <p>仅授权当前任务的指定技能版本使用以下网站与操作。自动批准模式下此范围仍生效，超出范围会停止，需要重新授权。</p>
            <dl>
              <dt>网站</dt>
              <dd>
                <ul>
                  {scope.origins.map((origin, index) => (
                    <li key={`${index}:${origin}`}>{origin}</li>
                  ))}
                </ul>
              </dd>
              <dt>操作范围</dt>
              <dd>
                <ol>
                  {scope.rules.map((rule, index) => (
                    <li key={index}>
                      <RuleSummary rule={rule} />
                    </li>
                  ))}
                </ol>
              </dd>
            </dl>
          </>
        ) : (
          <p>浏览器动作仍需逐次确认。此授权仅用于当前任务。</p>
        )}
      </div>
      {error && (
        <p className="browser-execution-authorization-error" role="alert">
          {error}
        </p>
      )}
      <div className="browser-execution-authorization-actions">
        <button
          type="button"
          className="browser-execution-authorize"
          disabled={Boolean(blockedReason) || phase !== "ready"}
          aria-describedby={statusId}
          onClick={() => {
            void authorize();
          }}
        >
          允许此任务使用浏览器
        </button>
        {grant && (
          <button
            type="button"
            disabled={phase === "authorizing" || phase === "revoking"}
            onClick={() => {
              void revoke();
            }}
          >
            接管并撤销授权
          </button>
        )}
        {error && bridge && threadId && (
          <button
            type="button"
            disabled={phase !== "ready"}
            onClick={() => refreshStatus.current()}
          >
            刷新授权状态
          </button>
        )}
      </div>
    </section>
  );
}

function scopeIssue(
  scope: BrowserGrantScope | undefined,
  ref: BrowserSkillRef,
): string | null {
  if (!scope) return null;
  if (
    scope.skillVersionRef.skillId !== ref.skillId ||
    scope.skillVersionRef.versionId !== ref.versionId ||
    scope.skillVersionRef.contentDigest !== ref.contentDigest
  ) {
    return "授权范围与当前技能版本不一致，请重新选择。";
  }
  if (scope.origins.length === 0 || scope.rules.length === 0)
    return "本次授权范围尚未配置完整。";
  return null;
}

function matchesThread(
  state: BrowserExecutionAuthorizationState,
  threadId: string,
): boolean {
  return (
    state.threadId === threadId &&
    typeof state.sessionId === "string" &&
    state.sessionId.length > 0 &&
    Number.isSafeInteger(state.revision) &&
    state.revision >= 0 &&
    (state.mode === "perAction" || state.mode === "scoped")
  );
}

function RuleSummary({ rule }: { rule: BrowserGrantRule }) {
  const labels = {
    navigate: "打开页面",
    click: "点击",
    fill: "填写",
    select: "选择",
    download: "下载文件",
  };
  return (
    <div className="browser-execution-authorization-rule">
      <strong>{labels[rule.action]}</strong>
      {rule.target && (
        <span>
          控件：{rule.target.role} · {rule.target.name}
        </span>
      )}
      {rule.urlTemplate && <span>地址：{rule.urlTemplate}</span>}
      {rule.value && (
        <span>
          {"literal" in rule.value
            ? `固定值：${rule.value.literal === "" ? "空文本" : rule.value.literal}`
            : `参数：${rule.value.parameter}（运行时提供）`}
        </span>
      )}
    </div>
  );
}
