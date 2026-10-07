import { useSyncExternalStore } from "react";
import type { ProjectMediaResultSummary } from "../project-media-results-service";
import type { ProjectAssetController } from "./ProjectAssetController";

/** Preview and target review are read-only. Only this explicit action adopts the saved image. */
export function ProjectMediaResultAdoption({
  assets,
  candidate,
  blocked,
  onAdopted,
}: {
  assets: ProjectAssetController;
  candidate: ProjectMediaResultSummary;
  blocked: boolean;
  onAdopted?(projectId: string): void;
}) {
  const state = useSyncExternalStore(
    assets.subscribe,
    assets.getSnapshot,
    assets.getSnapshot,
  );
  const recovery = useSyncExternalStore(
    assets.recovery.subscribe,
    assets.recovery.getSnapshot,
    assets.recovery.getSnapshot,
  );
  if (
    candidate.workflowId !== "krea2-reference-four-view" ||
    candidate.item.kind !== "character-reference"
  )
    return null;
  const view = state.view;
  const target =
    state.projectId === candidate.projectId &&
    view?.asset.assetId === candidate.item.assetId
      ? view
      : null;
  const selected = target?.selectedReferenceRevision;
  const adopted =
    selected?.source.kind === "media-result" &&
    selected.source.candidateId === candidate.candidateId;
  const busy =
    blocked ||
    state.saving ||
    state.opening ||
    recovery.acknowledging ||
    recovery.cancelling;
  return (
    <div aria-label="采纳角色参考图">
      <p className="detail-note">
        {target?.selectedContentRevision
          ? `对应角色：${target.selectedContentRevision.content.name} · 内容 v${target.selectedContentRevision.contentRevision}`
          : "先查看对应角色，再决定是否将这张图片用作角色参考图。"}
      </p>
      <div className="detail-actions">
        <button
          className="button secondary"
          disabled={busy || state.dirty || state.pending !== null}
          onClick={() => void assets.reviewMediaReference(candidate)}
        >
          查看对应角色
        </button>
        <button
          className="button secondary"
          disabled={
            busy || adopted || !assets.canAdoptMediaReference(candidate)
          }
          onClick={() =>
            void (async () => {
              await assets.adoptMediaReference(candidate);
              const current =
                assets.getSnapshot().view?.selectedReferenceRevision;
              if (
                current?.projectId === candidate.projectId &&
                current.source.kind === "media-result" &&
                current.source.candidateId === candidate.candidateId
              )
                onAdopted?.(candidate.projectId);
            })()
          }
        >
          {adopted ? "已选为角色参考图" : "采纳为角色参考图"}
        </button>
      </div>
      {state.dirty && <p className="detail-note">请先处理未保存的角色编辑。</p>}
      {target?.asset.locked && (
        <p className="detail-note">角色已锁定，请先在角色页解锁。</p>
      )}
      {target && !target.selectedContentRevision && (
        <p className="detail-note">请先在角色页选用一个内容版本。</p>
      )}
      {state.error && (
        <p className="detail-note" role="alert">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p className="detail-note" role="status">
          {state.notice}
        </p>
      )}
    </div>
  );
}
