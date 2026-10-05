import type { ProjectTextController } from "./ProjectTextController";
import type { TextSnapshot } from "./ProjectTextController.types";

export function ProjectTextRecoveryActions({
  controller,
  snapshot,
}: {
  controller: ProjectTextController;
  snapshot: TextSnapshot;
}) {
  const recovery = snapshot.recovery,
    record = recovery.intent;
  if (
    recovery.phase === "disabled" ||
    (recovery.phase === "ready" && !recovery.error)
  )
    return null;
  return (
    <section className="detail-panel" aria-label="恢复上次文字操作">
      <div className="panel-heading">
        <h2>上次文字操作</h2>
      </div>
      {recovery.phase === "checking" && (
        <p className="detail-note" role="status">
          正在检查未完成的请求…
        </p>
      )}
      {recovery.error && (
        <p className="detail-note" role="alert">
          {recovery.error}
        </p>
      )}
      {record && (
        <p className="detail-note" role="status">
          {record.phase === "pending"
            ? "原请求已保留，结果尚未确认。重新执行只使用原内容和原请求，不创建另一份候选。"
            : record.phase === "accepted"
              ? "上次操作已保存。读取确切版本并确认后，可继续创作。"
              : "上次请求已确认未写入。原内容保留，确认后可继续编辑。"}
        </p>
      )}
      <div className="detail-actions">
        <button
          className="button secondary"
          disabled={
            snapshot.saving || snapshot.opening || recovery.acknowledging
          }
          onClick={() => void controller.refreshRecovery()}
        >
          {record?.phase === "accepted" ? "读取已保存结果" : "重新读取恢复记录"}
        </button>
        {record?.phase === "pending" && (
          <button
            className="button secondary"
            disabled={
              snapshot.saving ||
              snapshot.opening ||
              snapshot.failure !== "uncertain"
            }
            onClick={() => void controller.retry()}
          >
            用原请求重试
          </button>
        )}
        {record && record.phase !== "pending" && (
          <button
            className="button secondary"
            disabled={
              !controller.canAcknowledgeRecovery || recovery.acknowledging
            }
            onClick={() => void controller.acknowledgeRecovery()}
          >
            {recovery.acknowledging
              ? "正在确认…"
              : record.phase === "accepted"
                ? "确认已保存结果"
                : "保留草稿继续编辑"}
          </button>
        )}
      </div>
    </section>
  );
}
