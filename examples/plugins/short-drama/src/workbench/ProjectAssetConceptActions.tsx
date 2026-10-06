import { useSyncExternalStore } from "react";
import type { ProjectAssetController } from "./ProjectAssetController";
import type { ConceptController } from "./ConceptController";
import type { ProjectDetails } from "./creative-project-controller";
import { assetConceptDescription } from "./AssetConceptDescription";

export function ProjectAssetConceptActions({
  assets,
  concepts,
  details,
  blocked,
  onOpen,
}: Readonly<{
  assets: ProjectAssetController;
  concepts: ConceptController;
  details: ProjectDetails;
  blocked: boolean;
  onOpen(): void;
}>) {
  const state = useSyncExternalStore(
    assets.subscribe,
    assets.getSnapshot,
    assets.getSnapshot,
  );
  useSyncExternalStore(
    concepts.subscribe,
    concepts.getSnapshot,
    concepts.getSnapshot,
  );
  const selected = state.view?.selectedContentRevision;
  if (!selected) return null;
  const copy = assetConceptDescription(state.view, details);
  const ready =
    !blocked &&
    assets.canRead &&
    !state.dirty &&
    !state.opening &&
    copy !== null &&
    concepts.canStartDescriptionDraft;
  return (
    <div className="version-card" aria-label="设定与概念图">
      <strong>
        已选设定 v{selected.contentRevision} · {selected.content.name}
      </strong>
      <p className="detail-note">
        将这版画面描述带到概念图，先检查或编辑，再保存并生成候选。
      </p>
      <button
        className="button secondary"
        disabled={!ready}
        onClick={() => {
          const current = assets.getSnapshot();
          if (blocked || !assets.canRead || current.dirty || current.opening)
            return;
          if (concepts.startFromAssetDescription(current.view)) onOpen();
        }}
      >
        用这版设定探索概念图
      </button>
      {state.dirty ? (
        <p className="detail-note">请先处理未保存的设定修改。</p>
      ) : !copy ? (
        <p className="detail-note">
          需要来源有效且包含画面描述的已选设定，请刷新并确认版本。
        </p>
      ) : !concepts.canStartDescriptionDraft ? (
        <p className="detail-note">
          概念图仍有未保存输入或正在处理的操作，请先到概念图完成处理。
        </p>
      ) : null}
    </div>
  );
}
