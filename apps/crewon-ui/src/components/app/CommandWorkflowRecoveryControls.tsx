import { useState, useEffect, useRef } from "react";
import type { useControlWorkflowRecords } from "./useControlWorkflowRecords";
import { workflowGateResolutionErrorText } from "./CommandWorkflowPresentation";

/** Recovery requires an explicit click on the original record, never a new Run. */
export function CommandWorkflowRecoveryControls({
  state,
  room,
  onOpen,
}: {
  state: Pick<
    ReturnType<typeof useControlWorkflowRecords>,
    | "pending"
    | "records"
    | "busy"
    | "mode"
    | "notice"
    | "previous"
    | "nextCursor"
    | "browse"
    | "next"
    | "previousPage"
    | "reload"
    | "recover"
  >;
  room: boolean;
  onOpen: (workflowId: string) => void;
}) {
  const [recovering, setRecovering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  if (room && !state.pending.length && !state.notice && !error) return null;
  return (
    <section className="workflow-control-tools" aria-label="协作流同步与恢复">
      {!room ? (
        <div className="workflow-control-actions">
          <button
            className="button compact"
            type="button"
            disabled={state.busy || recovering !== null}
            onClick={() =>
              void state.browse(state.mode === "catalog" ? "legacy" : "catalog")
            }
          >
            {state.mode === "catalog" ? "查看旧版记录" : "返回协作流目录"}
          </button>
          <button
            className="button compact"
            type="button"
            disabled={!state.previous.length || state.busy}
            onClick={() => void state.previousPage()}
          >
            上一页
          </button>
          <button
            className="button compact"
            type="button"
            disabled={!state.nextCursor || state.busy}
            onClick={() => void state.next()}
          >
            下一页
          </button>
          <button
            className="button compact"
            type="button"
            disabled={state.busy}
            onClick={() => void state.reload()}
          >
            重新同步
          </button>
        </div>
      ) : null}
      {state.mode === "legacy" ? (
        <p>旧版记录仅供查看，不会自动继续或重新发送。</p>
      ) : null}
      {state.notice ? (
        <p role="status">
          {state.notice === "身份或执行配置已变化，请重新读取目录"
            ? state.notice
            : "状态同步暂不可用，已读取的记录保留。可以重新同步。"}
        </p>
      ) : null}
      {state.pending.length ? (
        <div aria-label="待恢复的原请求">
          <strong>有 {state.pending.length} 个请求尚未确认结果</strong>
          {state.pending.map((intent) => (
            <div className="workflow-control-actions" key={intent.id}>
              <span>
                {intent.command.kind === "start"
                  ? "运行协作流"
                  : intent.command.kind === "review"
                    ? "提交审批"
                    : "取消运行"}{" "}
                ·{" "}
                {state.records.find(
                  (record) =>
                    record.control?.workflowVersionId ===
                    intent.workflowVersionId,
                )?.config.name ?? intent.workflowVersionId}{" "}
                · {intent.createdAt}
              </span>
              <button
                className="button compact"
                type="button"
                disabled={recovering !== null}
                aria-label={`恢复原请求 ${intent.id}`}
                onClick={async () => {
                  setRecovering(intent.id);
                  setError(null);
                  try {
                    const record = await state.recover(intent);
                    if (live.current) onOpen(record.config.workflowId);
                  } catch (error) {
                    if (live.current)
                      setError(
                        error instanceof Error
                          ? workflowGateResolutionErrorText(error.message)
                          : "暂时无法恢复原请求",
                      );
                  } finally {
                    if (live.current) setRecovering(null);
                  }
                }}
              >
                {recovering === intent.id ? "正在恢复…" : "恢复原请求"}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
