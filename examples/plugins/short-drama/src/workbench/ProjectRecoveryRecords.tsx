import { ConceptRecoveryActions } from "./ConceptRecoveryActions";
import { ProjectAssetRecoveryActions } from "./ProjectAssetRecoveryActions";
import { ProjectTextRecoveryActions } from "./ProjectTextRecoveryActions";
import type { CreativeProjectController } from "./creative-project-controller";
import type { ProjectAssetController } from "./ProjectAssetController";
import type {
  ProjectTextController,
  TextSnapshot,
} from "./ProjectTextController";

export function ProjectRecoveryRecords({
  projects,
  assets,
  texts,
  textSnapshot,
  onRestoreAsset,
}: {
  projects: CreativeProjectController;
  assets?: ProjectAssetController;
  texts: ProjectTextController;
  textSnapshot: TextSnapshot;
  onRestoreAsset(): void;
}) {
  return (
    <>
      <p className="detail-note">
        核对尚未确认的保存结果。这里的操作不会自动开始创作。
      </p>
      {assets && (
        <ProjectAssetRecoveryActions
          assets={assets}
          projects={projects}
          onRestore={onRestoreAsset}
        />
      )}
      <ConceptRecoveryActions controller={projects} />
      <ProjectTextRecoveryActions controller={texts} snapshot={textSnapshot} />
    </>
  );
}
