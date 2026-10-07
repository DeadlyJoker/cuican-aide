import { useEffect, useSyncExternalStore } from "react";
import type { ProjectMediaOutputController } from "./ProjectMediaOutputController";
import type { ProjectMediaResultController } from "./ProjectMediaResultController";
/** Local panel inside the existing content slot, reusing its controls and theme. */
export function ProjectMediaOutputWorkbench({
  controller,
  results,
  blocked,
}: {
  controller: ProjectMediaOutputController;
  results?: ProjectMediaResultController;
  blocked: boolean;
}) {
  const s = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    void controller.refresh();
  }, [controller, s.source, s.available]);
  if (!s.source) return null;
  return (
    <section className="detail-panel" aria-label="原任务生成产出">
      <div className="panel-heading">
        <h3>本次生成产出</h3>
        <span className="version-chip">输入 v{s.source.inputRevision}</span>
      </div>
      <p className="detail-note">
        读取原任务已记录的产出，逐张保存为项目候选。任务仍在执行时，可以稍后刷新。
      </p>
      {s.phase === "loading" && (
        <p className="detail-note" role="status">
          正在读取原任务产出…
        </p>
      )}
      {s.saving !== null && (
        <p className="detail-note" role="status">
          正在保存结果 {s.saving + 1}…
        </p>
      )}
      {s.notice && (
        <p className="detail-note" role="status">
          {s.notice}
        </p>
      )}
      {s.error && (
        <p className="detail-note" role="alert">
          {s.error}
        </p>
      )}
      <div className="detail-actions">
        <button
          className="text-button"
          disabled={!controller.canRead}
          onClick={() => void controller.refresh()}
        >
          刷新产出
        </button>
        {s.saving !== null && (
          <button
            className="button secondary"
            onClick={() => controller.cancel()}
          >
            停止等待保存
          </button>
        )}
        {s.uncertain !== null && s.saving === null && (
          <button
            className="button secondary"
            disabled={blocked || !controller.canRetry}
            onClick={() => void controller.retry()}
          >
            重试原位置保存
          </button>
        )}
      </div>
      {s.outputs.length > 0 && (
        <div className="detail-actions" aria-label="可保存产出列表">
          {s.outputs.map((o) =>
            o.candidate ? (
              <button
                key={o.resultIndex}
                className="button secondary"
                disabled={!results?.canRead}
                onClick={() => {
                  if (o.candidate) void results?.previewCandidate(o.candidate);
                }}
              >
                预览已保存结果 {o.resultIndex + 1}
              </button>
            ) : (
              <button
                key={o.resultIndex}
                className="button secondary"
                disabled={blocked || !controller.canSave(o.resultIndex)}
                onClick={() => void controller.save(o.resultIndex)}
              >
                保存结果 {o.resultIndex + 1}
              </button>
            ),
          )}
        </div>
      )}
    </section>
  );
}
