import { useSyncExternalStore } from "react";
import type { ConceptImageSelectionController } from "./ConceptImageSelectionController";
import type { ConceptImageChoice } from "./ConceptImageSelectionController.types";

export function ConceptImageSelectionButton({
  controller,
  choice,
}: {
  controller: ConceptImageSelectionController;
  choice: ConceptImageChoice;
}) {
  useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  if (!controller.hasHostContext) return null;
  const selected = controller.isCurrent(choice);
  return (
    <button
      className="button secondary"
      disabled={!controller.canSelect(choice)}
      onClick={() => void controller.select(choice)}
    >
      {selected ? "再次选用这张图" : "选用这张图"}
    </button>
  );
}

/** A committed receipt is historical; only the separate read identifies the current selection. */
export function ConceptImageSelectionActions({
  controller,
}: {
  controller: ConceptImageSelectionController;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  if ((!controller.hasHostContext || state.phase === "idle") && !state.request)
    return null;
  const selected = state.phase === "ready" ? state.current?.current : null;
  return (
    <section
      className="detail-panel"
      aria-label="概念图选用"
      data-selection-revision={state.current?.selectionRevision}
    >
      <div className="panel-heading">
        <h2>概念图选用</h2>
        {controller.hasHostContext && (
          <button
            className="text-button"
            disabled={state.phase === "loading"}
            onClick={() => void controller.refresh()}
          >
            刷新当前选用
          </button>
        )}
      </div>
      {state.phase === "loading" && (
        <p className="detail-note" role="status">
          正在读取当前选用…
        </p>
      )}
      {state.phase === "unavailable" && (
        <p className="detail-note" role="alert">
          当前选用暂时无法读取，请刷新后再选用。
        </p>
      )}
      {state.phase === "ready" && state.current?.current === null && (
        <p className="detail-note">这个概念还没有选用图片。</p>
      )}
      {selected && (
        <div
          className="version-card"
          data-selected-result-index={selected.resultIndex}
        >
          <strong>
            当前选用 · 输入 v{selected.reference.assetRevision} · 结果{" "}
            {selected.resultIndex + 1}
          </strong>
          <div className="concept-art">
            <img
              src={selected.url}
              loading="lazy"
              alt={`当前选用 · 输入 v${selected.reference.assetRevision} · 结果 ${selected.resultIndex + 1}`}
            />
          </div>
          <p className="detail-note">{selected.filename}</p>
          {selected.requiresConfirmation && (
            <p className="detail-note" role="status">
              需重新确认：这张图来自旧输入或旧需求，请核对当前需求和画面后再选择。
            </p>
          )}
        </div>
      )}
      {state.intentPhase === "pending" && (
        <p className="detail-note" role="status">
          正在提交选用，请稍候…
        </p>
      )}
      {state.intentPhase === "uncertain" && (
        <>
          <p className="detail-note" role="status">
            选用回复丢失或尚未确认，原选用已保留。确认前不能保存、切换或重新选图。
          </p>
          <button
            className="button secondary"
            disabled={!controller.canRetry}
            onClick={() => void controller.retry()}
          >
            重试原选用
          </button>
        </>
      )}
      {state.intentPhase === "accepted" && (
        <p className="detail-note" role="status">
          原选用请求已确认；当前选用以重新读取的结果为准。
        </p>
      )}
      {state.intentPhase === "refused" && (
        <>
          <p className="detail-note" role="status">
            本次选用未保存。请重新读取当前版本，再明确选择图片。
          </p>
          <button
            className="button secondary"
            disabled={state.recovery === "loading"}
            onClick={() => void controller.refreshRefused()}
          >
            重新读取选用准备状态
          </button>
        </>
      )}
      {state.recovery === "loading" && (
        <p className="detail-note" role="status">
          正在恢复原选用的已保存输入…
        </p>
      )}
      {state.recovery === "unavailable" && (
        <>
          <p className="detail-note" role="alert">
            原选用输入暂时无法读取，请重试。
          </p>
          <button
            className="button secondary"
            onClick={() => void controller.restoreSource()}
          >
            重新读取原选用输入
          </button>
        </>
      )}
      {state.reason && (
        <p className="detail-note" role="status">
          {state.reason}
        </p>
      )}
    </section>
  );
}
