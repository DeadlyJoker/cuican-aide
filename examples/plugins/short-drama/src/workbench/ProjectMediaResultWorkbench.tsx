import { useEffect, useSyncExternalStore } from "react";
import type { ProjectMediaResultController } from "./ProjectMediaResultController";
import { ProjectMediaResultAdoption } from "./ProjectMediaResultAdoption";
import type { ProjectAssetController } from "./ProjectAssetController";
import { mediaWorkflowNames } from "./ProjectMediaInputWorkbench";
/** Reuses the plugin's scoped forms and panels; no dialog, portal, global theme, or host navigation. */
export function ProjectMediaResultWorkbench({
  controller,
  assets,
  blocked = false,
  onAdopted,
}: {
  controller: ProjectMediaResultController;
  assets?: ProjectAssetController;
  blocked?: boolean;
  onAdopted?(projectId: string): void;
}) {
  const s = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    void controller.refresh();
    return () => controller.closePreview();
  }, [controller, s.projectId]);
  return (
    <section className="detail-panel media-results" aria-label="已保存生成结果">
      <div className="panel-heading">
        <h3>已保存结果</h3>
        <button
          className="text-button"
          disabled={!controller.canRead || s.phase === "loading"}
          onClick={() => void controller.refresh()}
        >
          刷新结果
        </button>
      </div>
      <p className="detail-note">
        查看已保存的参考图与分镜探索结果及其输入版本。
      </p>
      {s.phase === "loading" && (
        <p className="detail-note" role="status">
          正在读取结果…
        </p>
      )}
      {s.error && (
        <p className="detail-note" role="alert">
          {s.error}
        </p>
      )}
      {s.phase === "ready" && s.candidates.length === 0 && (
        <p className="detail-note">当前项目还没有已保存结果。</p>
      )}
      <div className="detail-actions" aria-label="生成结果列表">
        {s.candidates.map((c) => (
          <button
            key={c.candidateId}
            className="button secondary"
            aria-pressed={s.preview?.candidate.candidateId === c.candidateId}
            disabled={!controller.canRead || s.previewing === c.candidateId}
            onClick={() => void controller.preview(c.candidateId)}
          >
            {mediaWorkflowNames[c.workflowId]} · 输入 v{c.inputRevision} · 结果{" "}
            {c.resultIndex + 1}
          </button>
        ))}
      </div>
      {s.nextCandidateId !== null && s.candidates.length < 64 && (
        <button
          className="text-button"
          disabled={!controller.canRead || s.phase === "loading"}
          onClick={() => void controller.refresh(true)}
        >
          更多结果
        </button>
      )}
      {s.previewing && (
        <p className="detail-note" role="status">
          正在读取图片…
        </p>
      )}
      {s.preview && (
        <figure className="media-result-preview">
          <img
            src={s.preview.url}
            alt={`${mediaWorkflowNames[s.preview.candidate.workflowId]}生成结果 ${s.preview.candidate.resultIndex + 1}`}
          />
          <figcaption className="detail-note">
            输入 v{s.preview.candidate.inputRevision} ·{" "}
            {s.preview.candidate.media.width} ×{" "}
            {s.preview.candidate.media.height}
          </figcaption>
          {assets && (
            <ProjectMediaResultAdoption
              assets={assets}
              onAdopted={onAdopted}
              candidate={s.preview.candidate}
              blocked={blocked || !controller.canRead}
            />
          )}
          <button
            className="text-button"
            onClick={() => controller.closePreview()}
          >
            关闭预览
          </button>
        </figure>
      )}
    </section>
  );
}
