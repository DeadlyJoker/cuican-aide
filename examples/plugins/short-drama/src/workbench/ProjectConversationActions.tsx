import { useSyncExternalStore } from "react";
import type { ProjectConversationController } from "./ProjectConversationController";

export function ProjectConversationActions({
  controller,
}: {
  controller: ProjectConversationController;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  if (!snapshot.projectId) return null;
  const active = snapshot.bindings.find(
    (binding) => binding.state === "active",
  );
  return (
    <section className="drama-agent-entry" aria-label="项目 Agent 对话">
      <div className="panel-heading">
        <h2>和 Agent 一起完成短剧</h2>
      </div>
      <p className="detail-note">
        告诉 Agent
        你的想法、想改的地方或下一步。需要检查内容时，展开下方流程查看产物。
      </p>
      {snapshot.phase === "waiting" && (
        <p className="detail-note" role="status">
          正在等待模块就绪…
        </p>
      )}
      {snapshot.phase === "loading" && (
        <p className="detail-note" role="status">
          正在读取项目对话…
        </p>
      )}
      {snapshot.error && (
        <p className="detail-note" role="alert">
          {snapshot.error}
        </p>
      )}
      {snapshot.notice && (
        <p className="detail-note" role="status">
          {snapshot.notice}
        </p>
      )}
      <div className="detail-actions">
        <button
          className="button primary"
          disabled={
            active
              ? controller.locked || snapshot.phase !== "ready"
              : !controller.canCreate
          }
          onClick={() =>
            void (active
              ? controller.open(active.threadId)
              : controller.begin())
          }
        >
          {snapshot.creating || snapshot.openingThreadId
            ? "正在打开…"
            : active
              ? "继续与 Agent 对话"
              : "开始与 Agent 对话"}
        </button>
        {snapshot.phase === "unavailable" && (
          <button
            className="button secondary"
            onClick={() => void controller.refresh()}
          >
            重新连接
          </button>
        )}
        {snapshot.pendingCreation && (
          <button
            className="button secondary"
            disabled={snapshot.creating}
            onClick={() => void controller.retryCreation()}
          >
            重试原创建请求
          </button>
        )}
        {snapshot.pendingSourceRefresh && (
          <button
            className="button secondary"
            disabled={
              !controller.canRefreshSource ||
              snapshot.pendingSourceRefresh.input.projectId !==
                snapshot.projectId
            }
            onClick={() => void controller.retrySourceRefresh()}
          >
            {snapshot.refreshingSource ? "正在更新关联…" : "重试原关联更新"}
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
