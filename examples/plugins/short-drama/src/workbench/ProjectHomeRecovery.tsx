import { ChevronDown, History } from "lucide-react";
import type { CreativeProjectController } from "./creative-project-controller";
import type { ProjectAssetController } from "./ProjectAssetController";
import { ConceptGenerationActions } from "./ConceptGenerationActions";
import { ConceptQueryActions } from "./ConceptQueryActions";
import { ConceptImageSelectionActions } from "./ConceptImageSelectionActions";
import { ConceptRecoveryActions } from "./ConceptRecoveryActions";
import { ProjectAssetRecoveryActions } from "./ProjectAssetRecoveryActions";

/** Keep recovery reachable without letting background restoration choose the landing page. */
export function ProjectHomeRecovery({
  controller,
  assets,
  onShowProject,
  onRestoreAsset,
}: {
  controller: CreativeProjectController;
  assets?: ProjectAssetController;
  onShowProject(): void;
  onRestoreAsset(): void;
}) {
  const { submissions, queries, historicalQueries, images } =
    controller.concepts;
  const project = controller.getSnapshot().details;
  return (
    <details className="drama-plan-disclosure drama-recovery-disclosure">
      <summary>
        <History size={16} />
        <strong>待处理记录</strong>
        <span>查看之前的保存与生成任务</span>
        <ChevronDown size={16} />
      </summary>
      {project && (
        <section className="detail-panel">
          <div className="panel-heading">
            <h2>{project.project.title}</h2>
            <button className="button secondary" onClick={onShowProject}>
              查看待处理项目
            </button>
          </div>
        </section>
      )}
      <ConceptRecoveryActions
        controller={controller}
        onShowProject={onShowProject}
      />
      {assets && (
        <ProjectAssetRecoveryActions
          assets={assets}
          projects={controller}
          onRestore={onRestoreAsset}
        />
      )}
      {submissions.getSnapshot().request && (
        <ConceptGenerationActions controller={submissions} />
      )}
      {queries.getSnapshot().request && (
        <ConceptQueryActions controller={queries} />
      )}
      {historicalQueries.getSnapshot().request && (
        <ConceptQueryActions controller={historicalQueries} />
      )}
      {images.getSnapshot().request && (
        <ConceptImageSelectionActions controller={images} />
      )}
    </details>
  );
}
