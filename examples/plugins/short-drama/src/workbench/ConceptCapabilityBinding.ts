import type { PublicCreativeProject } from "@crewon/plugin-sdk/contracts";
import type { ConceptSelection } from "./ConceptController.types";
import type { ConceptGenerationIntentController } from "./ConceptGenerationIntentController";
import type { ConceptQueryController } from "./ConceptQueryController";
import type { ConceptImageSelectionController } from "./ConceptImageSelectionController";
import type { ConceptRecoveryCoordinator } from "./ConceptRecoveryCoordinator";

/** Keep saved-source derivation and cross-capability write locks in one bounded module. */
export function bindConceptCapabilities(input: {
  selection: ConceptSelection | null;
  project: PublicCreativeProject | undefined;
  editing: boolean;
  ready: boolean;
  blocked: boolean;
  metadataPending: boolean;
  submissions: ConceptGenerationIntentController;
  queries: ConceptQueryController;
  images: ConceptImageSelectionController;
  recovery: ConceptRecoveryCoordinator;
}) {
  const { selection, project, submissions, queries, images } = input;
  const blocked = input.blocked || input.recovery.conflict;
  const source =
    selection && !input.editing
      ? {
          projectId: selection.asset.projectId,
          assetId: selection.asset.assetId,
          assetRevision: selection.revision.assetRevision,
        }
      : null;
  const reference =
    source && project && selection
      ? {
          ...source,
          expectedProjectRevision: project.revision,
          expectedAssetMetadataRevision: selection.asset.revision,
        }
      : null;
  const retryPolicy = {
    originalRetryBlocked: () =>
      input.blocked ||
      input.recovery.conflict ||
      input.metadataPending ||
      input.editing ||
      !input.ready ||
      submissions.blocksOriginalRetry(source) ||
      queries.blocksOriginalRetry(source) ||
      images.blocksOriginalRetry(source),
  };
  queries.bindSource(
    input.recovery.preservesHistory("query") ? null : source,
    input.ready,
    blocked || submissions.locked || images.locked,
    retryPolicy,
  );
  submissions.bindSource(
    input.recovery.preservesHistory("generation") ? null : reference,
    project?.state === "active" && !blocked && !images.locked,
    input.ready,
    retryPolicy,
  );
  images.bindSource(
    input.recovery.preservesHistory("selection") ? null : reference,
    project?.state === "active",
    input.ready,
    blocked || input.metadataPending || submissions.locked || queries.locked,
    retryPolicy,
  );
}
