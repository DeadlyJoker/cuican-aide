import { useSyncExternalStore } from "react";
import type { ConceptQueryController } from "./ConceptQueryController";
export function ConceptQueryOperationButton({
  controller,
  operationId,
}: {
  controller: ConceptQueryController;
  operationId: string;
}) {
  useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  if (!controller.hasHostContext || !controller.supportsRecord) return null;
  return (
    <button
      className="button secondary"
      disabled={!controller.canQuery(operationId)}
      onClick={() => void controller.query(operationId)}
    >
      {controller.lane === "historical" ? "查询历史任务" : "查询原任务"}
    </button>
  );
}
export function ConceptQueryActions({
  controller,
}: {
  controller: ConceptQueryController;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  if (!state.request) return null;
  return (
    <section
      className="detail-panel"
      aria-label={
        controller.lane === "historical" ? "历史任务查询" : "原任务查询"
      }
      data-query-run-id={state.receipt?.runId}
    >
      <h2>
        {controller.lane === "historical" ? "历史任务查询" : "原任务查询"}
      </h2>
      {state.intentPhase === "pending" && (
        <p className="detail-note" role="status">
          正在提交查询，请稍候…
        </p>
      )}
      {state.intentPhase === "uncertain" && (
        <>
          <p className="detail-note" role="status">
            查询尚未确认，原查询已保留。
          </p>
          <button
            className="button secondary"
            disabled={!controller.canRetry}
            onClick={() => void controller.retry()}
          >
            {controller.lane === "historical" ? "重试原历史查询" : "重试原查询"}
          </button>
        </>
      )}
      {state.intentPhase === "accepted" && (
        <p className="detail-note" role="status">
          查询任务已受理，可刷新任务记录查看结果。
        </p>
      )}
      {state.intentPhase === "refused" && (
        <>
          <p className="detail-note" role="status">
            本次查询尚未发送，请重新确认会话。
          </p>
          <button
            className="button secondary"
            disabled={state.recovery === "loading"}
            onClick={() => void controller.refreshRefused()}
          >
            {controller.lane === "historical"
              ? "重新确认历史查询准备状态"
              : "重新确认查询准备状态"}
          </button>
        </>
      )}
      {state.recovery === "loading" && (
        <p className="detail-note" role="status">
          正在恢复原查询的已保存输入…
        </p>
      )}
      {state.recovery === "unavailable" && (
        <>
          <p className="detail-note" role="alert">
            原查询输入暂时无法读取，请重试。
          </p>
          <button
            className="button secondary"
            onClick={() => void controller.restoreSource()}
          >
            {controller.lane === "historical"
              ? "重新读取原历史查询输入"
              : "重新读取原查询输入"}
          </button>
        </>
      )}
      {controller.lane === "historical" && (
        <p className="detail-note">
          历史查询原请求仅在当前会话保留；重新启动后请先读取已保存的任务记录。
        </p>
      )}
      {state.reason && (
        <p className="detail-note" role="status">
          {state.reason}
        </p>
      )}
    </section>
  );
}
