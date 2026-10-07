import { useSyncExternalStore } from "react";
import type { CreativeProjectController } from "./creative-project-controller";
import type { ConceptRecoveryLane } from "./ConceptRecoveryCoordinator";

const labels: Record<ConceptRecoveryLane, string> = {
  generation: "原生成请求",
  query: "原查询请求",
  historicalQuery: "原历史查询请求",
  selection: "原选用请求",
};

/** Viewing a saved input and replaying its original command are separate user actions. */
export function ConceptRecoveryActions({
  controller,
  onShowProject,
}: {
  controller: CreativeProjectController;
  onShowProject?(): void;
}) {
  const project = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const { submissions, queries, historicalQueries, images } =
    controller.concepts;
  useSyncExternalStore(
    submissions.subscribe,
    submissions.getSnapshot,
    submissions.getSnapshot,
  );
  useSyncExternalStore(
    queries.subscribe,
    queries.getSnapshot,
    queries.getSnapshot,
  );
  useSyncExternalStore(
    images.subscribe,
    images.getSnapshot,
    images.getSnapshot,
  );
  useSyncExternalStore(
    historicalQueries.subscribe,
    historicalQueries.getSnapshot,
    historicalQueries.getSnapshot,
  );
  if (!project.recoveryConflict) return null;
  const lanes = {
    generation: submissions,
    query: queries,
    historicalQuery: historicalQueries,
    selection: images,
  };
  return (
    <section className="detail-panel" aria-label="未确认原请求">
      <p className="detail-note" role="alert">
        有多个来自不同输入的未确认请求。原请求已保留，请逐条查看原输入，再明确重试。
      </p>
      {controller.recoveryChoices.map((choice) => (
        <section
          className="detail-panel"
          aria-label={labels[choice.lane]}
          key={choice.lane}
        >
          <h2>{labels[choice.lane]}</h2>
          <p className="detail-note">项目：{choice.reference.projectId}</p>
          <p className="detail-note">
            概念图：{choice.reference.assetId} · 第{" "}
            {choice.reference.assetRevision} 版
          </p>
          <p className="detail-note" role="status">
            {choice.phase === "pending"
              ? "请求正在处理中，请稍候"
              : "结果尚未确认"}
          </p>
          <button
            type="button"
            className="button secondary"
            aria-pressed={choice.selected}
            disabled={!controller.canChooseRecoveryRequest(choice.lane)}
            onClick={() =>
              void (async () => {
                await controller.selectRecoveryRequest(choice.lane);
                if (controller.getSnapshot().details) onShowProject?.();
              })()
            }
          >
            查看原输入
          </button>
          {choice.selected && (
            <button
              type="button"
              className="button secondary"
              disabled={
                !controller.canChooseRecoveryRequest(choice.lane) ||
                !lanes[choice.lane].canRetry
              }
              onClick={() => void controller.retryRecoveryRequest(choice.lane)}
            >
              重试这条原请求
            </button>
          )}
          {!choice.retryable && (
            <p className="detail-note">当前不能重试，原请求仍保留。</p>
          )}
          {choice.selected &&
            lanes[choice.lane].getSnapshot().recovery === "unavailable" && (
              <p className="detail-note" role="alert">
                原输入暂时无法读取，请重新查看；其他原请求仍保留。
              </p>
            )}
        </section>
      ))}
    </section>
  );
}
