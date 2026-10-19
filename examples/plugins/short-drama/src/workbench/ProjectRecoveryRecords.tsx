import { ConceptRecoveryActions } from "./ConceptRecoveryActions";
import { ProjectAssetRecoveryActions } from "./ProjectAssetRecoveryActions";
import { ProjectTextRecoveryActions } from "./ProjectTextRecoveryActions";
import type { CreativeProjectController } from "./creative-project-controller";
import type { OtherProjectRecovery } from "./ProjectRecoveryProjection";
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
  onRestoreText,
  otherProjects = [],
  onOpenProject,
}: {
  projects: CreativeProjectController;
  assets?: ProjectAssetController;
  texts: ProjectTextController;
  textSnapshot: TextSnapshot;
  onRestoreAsset(): void;
  onRestoreText(): void;
  otherProjects?: readonly OtherProjectRecovery[];
  onOpenProject?(projectId: string): void;
}) {
  return (
    <>
      <p className="detail-note">
        核对尚未确认的保存结果。这里的操作不会自动开始创作。
      </p>
      {onOpenProject &&
        otherProjects.map((record) => (
          <section
            className="detail-panel"
            key={record.projectId}
            aria-label="其他项目原请求"
          >
            <p className="detail-note">
              其他项目的原请求已保留，进入原项目后查看或恢复。
            </p>
            <button
              type="button"
              className="button secondary"
              onClick={() => onOpenProject(record.projectId)}
            >
              查看原项目
              {projects
                .getSnapshot()
                .projects.find(
                  (project) => project.projectId === record.projectId,
                )?.title
                ? ` · ${projects.getSnapshot().projects.find((project) => project.projectId === record.projectId)!.title}`
                : ""}
            </button>
          </section>
        ))}
      {assets && (
        <ProjectAssetRecoveryActions
          assets={assets}
          projects={projects}
          onRestore={onRestoreAsset}
        />
      )}
      <ConceptRecoveryActions controller={projects} />
      <ProjectTextRecoveryActions
        controller={texts}
        snapshot={textSnapshot}
        onOpenResult={onRestoreText}
      />
    </>
  );
}
