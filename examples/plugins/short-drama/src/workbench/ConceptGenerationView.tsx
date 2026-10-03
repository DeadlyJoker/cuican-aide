import { useSyncExternalStore } from "react";
import type {
  ConceptGenerationTaskView,
  ConceptGenerationOperation,
} from "@crewon/plugin-sdk/contracts";
import type { ConceptQueryController } from "./ConceptQueryController";
import { ConceptQueryOperationButton } from "./ConceptQueryActions";
import type { ConceptGenerationController } from "./ConceptGenerationController";

const runLabels: Record<ConceptGenerationTaskView["runStatus"], string> = {
  queued: "排队中",
  running: "运行中",
  waitingApproval: "等待确认",
  suspended: "已暂停",
  reconciling: "核对中",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
};
const operationLabels: Record<ConceptGenerationOperation["status"], string> = {
  submitting: "提交中",
  submitted: "已提交",
  queued: "排队中",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  unknownOutcome: "结果待确认",
};

/** Read-only results remain attached to the selected saved revision and original result indices. */
export function ConceptGenerationView({
  controller,
  queries,
  name,
  blocked,
  unconfirmed = false,
}: {
  controller: ConceptGenerationController;
  queries: ConceptQueryController;
  name: string;
  blocked: boolean;
  unconfirmed?: boolean;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const { generation } = snapshot;
  if (snapshot.source === null) return null;
  return (
    <section
      className="detail-panel"
      aria-label="已保存输入的生成记录"
      data-run-id={generation?.task.runId}
    >
      <div className="panel-heading">
        <h2>输入 v{snapshot.source.assetRevision} 的生成记录</h2>
        <button
          className="text-button"
          disabled={blocked || snapshot.phase === "loading"}
          onClick={() => void controller.refresh()}
        >
          刷新任务记录
        </button>
      </div>
      {snapshot.phase === "loading" && (
        <p className="detail-note" role="status">
          正在读取任务记录…
        </p>
      )}
      {snapshot.phase === "unavailable" && (
        <p className="detail-note" role="alert">
          任务记录暂时无法读取，请重试。
        </p>
      )}
      {snapshot.phase === "ready" && generation === null && (
        <p className="detail-note" role="status">
          {unconfirmed
            ? "原请求仍待确认，暂无可确认的任务记录。"
            : "这个已保存版本还没有生成任务。"}
        </p>
      )}
      {generation && (
        <>
          <p className="detail-note">
            任务状态：{runLabels[generation.task.runStatus]}
          </p>
          {generation.task.operations.length === 0 && (
            <p className="detail-note">还没有可展示的执行记录。</p>
          )}
          {generation.task.operations.map((operation) => (
            <div
              className="version-card"
              key={operation.operationId}
              data-operation-id={operation.operationId}
              data-operation-revision={operation.operationRevision}
            >
              <strong>执行记录：{operationLabels[operation.status]}</strong>
              <ConceptQueryOperationButton
                controller={queries}
                operationId={operation.operationId}
              />
              <p className="detail-note">
                更新于{" "}
                <time dateTime={operation.observedAt}>
                  {new Date(operation.observedAt).toLocaleString("zh-CN", {
                    hour12: false,
                  })}
                </time>
              </p>
              {operation.images.map((image) => (
                <div
                  key={image.resultIndex}
                  data-result-index={image.resultIndex}
                >
                  <div className="concept-art">
                    <img
                      src={image.url}
                      loading="lazy"
                      alt={`${name} · 输入 v${generation.assetRevision} · 结果 ${image.resultIndex + 1}`}
                    />
                  </div>
                  <p className="detail-note">
                    结果 {image.resultIndex + 1} · {image.filename}
                  </p>
                </div>
              ))}
            </div>
          ))}
          {generation.task.truncated && (
            <p className="detail-note" role="status">
              部分记录或图片未展示。
            </p>
          )}
        </>
      )}
      <p className="detail-note">
        刷新只读取已保存的任务记录，不查询生图服务。
      </p>
    </section>
  );
}
