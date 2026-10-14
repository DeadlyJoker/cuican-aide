import { useSyncExternalStore } from "react";
import type { ProjectConversationController } from "./ProjectConversationController";

export function ProjectConversationActions({
  controller,
  presentation = "manual",
}: {
  controller: ProjectConversationController;
  presentation?: "automatic" | "manual";
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  if (!snapshot.projectId) return null;
  const automatic = presentation === "automatic";
  const active = snapshot.bindings.find(
    (binding) => binding.state === "active",
  );
  const activeSourceExpired =
    active !== undefined &&
    snapshot.sourceRefreshThreadId === active.threadId &&
    !snapshot.pendingSourceRefresh;
  const connecting =
    snapshot.resolvingWorkspace ||
    snapshot.creating ||
    snapshot.openingThreadId !== null ||
    snapshot.refreshingSource ||
    snapshot.automaticConnecting;
  const status = automatic
    ? snapshot.openedThreadId
      ? "项目对话已就绪"
      : snapshot.notice
    : snapshot.notice;
  return (
    <section className="drama-agent-entry" aria-label="项目 Agent 对话">
      {snapshot.phase === "waiting" && (
        <p className="detail-note" role="status">
          正在等待模块就绪…
        </p>
      )}
      {(snapshot.phase === "loading" || (automatic && connecting)) && (
        <p className="detail-note" role="status">
          {automatic ? "正在连接项目对话…" : "正在读取项目对话…"}
        </p>
      )}
      {snapshot.error && (
        <p className="detail-note" role="alert">
          {snapshot.error}
        </p>
      )}
      {status && (!automatic || (!connecting && !snapshot.error)) && (
        <p className="detail-note" role="status">
          {status}
        </p>
      )}
      <div className="detail-actions">
        {!automatic && (
          <button
            className="button primary"
            disabled={
              activeSourceExpired
                ? !controller.canRefreshSource
                : active
                  ? controller.locked || snapshot.phase !== "ready"
                  : !controller.canCreate
            }
            onClick={() =>
              void (activeSourceExpired && active
                ? controller.refreshSourceAndOpen(active.threadId)
                : active
                  ? controller.open(active.threadId)
                  : controller.begin())
            }
          >
            {snapshot.creating || snapshot.openingThreadId
              ? "正在打开…"
              : activeSourceExpired
                ? "更新关联并进入"
                : active
                  ? "继续与 Agent 对话"
                  : "开始与 Agent 对话"}
          </button>
        )}
        {automatic &&
          activeSourceExpired &&
          active &&
          !connecting &&
          controller.canRefreshSource && (
            <button
              className="button secondary"
              disabled={!controller.canRefreshSource}
              onClick={() =>
                void controller.refreshSourceAndOpen(active.threadId)
              }
            >
              更新关联并重新连接
            </button>
          )}
        {(automatic ? snapshot.error : snapshot.phase === "unavailable") &&
          !connecting &&
          !snapshot.pendingCreation &&
          !snapshot.pendingSourceRefresh &&
          !activeSourceExpired && (
            <button
              className="button secondary"
              onClick={() =>
                void (automatic ? controller.reconnect() : controller.refresh())
              }
            >
              重新连接
            </button>
          )}
        {snapshot.pendingCreation && (!automatic || !connecting) && (
          <button
            className="button secondary"
            disabled={!controller.canRetryCreation}
            onClick={() => void controller.retryCreation()}
          >
            {automatic ? "重新连接" : "重试原创建请求"}
          </button>
        )}
        {snapshot.pendingSourceRefresh && (!automatic || !connecting) && (
          <button
            className="button secondary"
            disabled={
              !controller.canRefreshSource ||
              snapshot.pendingSourceRefresh.input.projectId !==
                snapshot.projectId
            }
            onClick={() => void controller.retrySourceRefresh()}
          >
            {automatic
              ? "重试关联更新"
              : snapshot.refreshingSource
                ? "正在更新关联…"
                : "重试原关联更新"}
          </button>
        )}
      </div>
      <details className="drama-secondary-disclosure">
        <summary>其他对话</summary>
        <div className="detail-actions">
          <button
            className="text-button"
            disabled={controller.locked}
            onClick={() => void controller.refresh()}
          >
            刷新项目对话
          </button>
          <button
            className="button secondary"
            disabled={!controller.canCreate}
            onClick={() => void controller.create()}
          >
            新建项目对话
          </button>
        </div>
        {snapshot.bindings.map((binding, index) => (
          <div className="version-card" key={binding.threadId}>
            <div className="panel-heading">
              <strong>创作对话 {index + 1}</strong>
              <button
                className="button secondary"
                disabled={binding.state !== "active" || controller.locked}
                onClick={() => void controller.open(binding.threadId)}
              >
                {snapshot.openingThreadId === binding.threadId
                  ? "正在打开…"
                  : "进入对话"}
              </button>
            </div>
            {snapshot.sourceRefreshThreadId === binding.threadId &&
              !activeSourceExpired &&
              !snapshot.pendingSourceRefresh && (
                <button
                  className="button secondary"
                  disabled={!controller.canRefreshSource}
                  onClick={() =>
                    void controller.refreshSourceAndOpen(binding.threadId)
                  }
                >
                  更新关联并进入
                </button>
              )}
            <p className="detail-note">
              {new Date(binding.createdAt).toLocaleString("zh-CN")}
              {binding.state === "revoked" ? " · 已停止关联" : ""}
            </p>
          </div>
        ))}
        {snapshot.nextThreadId && (
          <button
            className="button secondary"
            disabled={
              snapshot.phase === "loading" ||
              snapshot.creating ||
              snapshot.refreshingSource ||
              snapshot.openingThreadId !== null
            }
            onClick={() => void controller.refresh({ more: true })}
          >
            加载更多项目对话
          </button>
        )}
      </details>
    </section>
  );
}
