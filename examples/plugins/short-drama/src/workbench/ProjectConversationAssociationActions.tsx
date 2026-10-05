import { useSyncExternalStore } from "react";
import type { ProjectConversationAssociationController } from "./ProjectConversationAssociationController";
export function ProjectConversationAssociationActions({
  controller,
  blocked,
  onAttached,
}: {
  controller: ProjectConversationAssociationController;
  blocked: boolean;
  onAttached(): void;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  if ((!snapshot.projectId || !snapshot.threadId) && !snapshot.pending)
    return null;
  return (
    <section className="detail-panel" aria-label="关联当前 Agent 会话">
      <div className="panel-heading">
        <h2>继续当前对话</h2>
        <button
          className="text-button"
          disabled={snapshot.reading || snapshot.writing}
          onClick={() => void controller.refresh().then(onAttached)}
        >
          重新读取关联
        </button>
      </div>
      <p className="detail-note">
        将正在查看的会话关联到这个项目，保留它的工作空间和历史。关联后可选择创作阶段或执行计划。
      </p>
      {snapshot.candidate && (
        <p className="detail-note">
          {snapshot.candidate.workspaceId
            ? "沿用此会话的工作空间"
            : "此会话未绑定工作空间"}
        </p>
      )}
      <div className="detail-actions">
        <button
          className="button secondary"
          disabled={blocked || !controller.canAttach}
          onClick={() => void controller.attach().then(onAttached)}
        >
          {snapshot.writing ? "正在关联…" : "关联当前会话"}
        </button>
        {snapshot.pending && (
          <button
            className="button secondary"
            disabled={snapshot.reading || snapshot.writing || blocked}
            onClick={() => void controller.retryOriginal().then(onAttached)}
          >
            重试原关联请求
          </button>
        )}
      </div>
      {snapshot.notice && (
        <p className="detail-note" role="status">
          {snapshot.notice}
        </p>
      )}
      {snapshot.error && (
        <p className="detail-note" role="alert">
          {snapshot.error}
        </p>
      )}
    </section>
  );
}
