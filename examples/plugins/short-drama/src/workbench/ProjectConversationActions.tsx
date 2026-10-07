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
  return (
    <section className="detail-panel" aria-label="项目 Agent 对话">
      <div className="panel-heading">
        <h2>与 Agent 创作</h2>
        <button
          className="text-button"
          disabled={
            snapshot.creating ||
            snapshot.refreshingSource ||
            snapshot.openingThreadId !== null
          }
          onClick={() => void controller.refresh()}
        >
          刷新项目对话
        </button>
      </div>
      <p className="detail-note">
        在对话中讨论想法、完善需求、生成大纲或分集剧本。对话与手动页面使用同一份项目成果。
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
          className="button secondary"
          disabled={!controller.canCreate}
          onClick={() => void controller.create()}
        >
          {snapshot.creating ? "正在创建对话…" : "新建项目对话"}
        </button>
        <span className="detail-note">
          {snapshot.workspace
            ? (snapshot.workspace.name ??
              (snapshot.workspace.workspaceId
                ? "当前工作空间"
                : "未选择工作空间"))
            : "工作空间信息尚未就绪"}
        </span>
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
    </section>
  );
}
