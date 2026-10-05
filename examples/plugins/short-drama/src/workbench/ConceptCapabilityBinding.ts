import type { PublicCreativeProject } from "@crewon/plugin-sdk/contracts";
import type { ConceptSelection } from "./ConceptController.types";
import type { ConceptGenerationIntentController } from "./ConceptGenerationIntentController";
import type { ConceptQueryController } from "./ConceptQueryController";
import type { ConceptImageSelectionController } from "./ConceptImageSelectionController";
import type {
  ConceptRecoveryCoordinator,
  ConceptRecoveryLane,
} from "./ConceptRecoveryCoordinator";

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
  historicalQueries: ConceptQueryController;
  images: ConceptImageSelectionController;
  recovery: ConceptRecoveryCoordinator;
}) {
  const {
    selection,
    project,
    submissions,
    queries,
    historicalQueries,
    images,
  } = input;
  const blocked =
    input.blocked || input.recovery.conflict || input.recovery.manualHandling;
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
  const controllers = {
    generation: submissions,
    query: queries,
    historicalQuery: historicalQueries,
    selection: images,
  };
  const retryPolicy = (lane: ConceptRecoveryLane) => ({
    originalRetryBlocked: () => {
      if (
        input.blocked ||
        input.metadataPending ||
        input.editing ||
        !input.ready ||
        submissions.originalRequestBusy ||
        queries.originalRequestBusy ||
        historicalQueries.originalRequestBusy ||
        images.originalRequestBusy
      )
        return true;
      if (input.recovery.manualHandling)
        return (
          !input.recovery.allowsOriginalRetry(lane, source) ||
          controllers[lane].blocksOriginalRetry(source)
        );
      return (
        input.recovery.conflict ||
        submissions.blocksOriginalRetry(source) ||
        queries.blocksOriginalRetry(source) ||
        historicalQueries.blocksOriginalRetry(source) ||
        images.blocksOriginalRetry(source)
      );
    },
  });
  const preserveLane = (lane: ConceptRecoveryLane) =>
    input.recovery.preservesHistory(lane) ||
    (input.recovery.manualHandling && input.recovery.selectedLane !== lane);
  queries.bindSource(
    preserveLane("query") ? null : source,
    input.ready,
    blocked || submissions.locked || historicalQueries.locked || images.locked,
    retryPolicy("query"),
  );
  historicalQueries.bindSource(
    preserveLane("historicalQuery") ? null : source,
    input.ready,
    blocked || submissions.locked || queries.locked || images.locked,
    retryPolicy("historicalQuery"),
  );
  submissions.bindSource(
    preserveLane("generation") ? null : reference,
    project?.state === "active" &&
      !blocked &&
      !queries.locked &&
      !historicalQueries.locked &&
      !images.locked,
    input.ready,
    retryPolicy("generation"),
  );
  images.bindSource(
    preserveLane("selection") ? null : reference,
    project?.state === "active",
    input.ready,
    blocked ||
      input.metadataPending ||
      submissions.locked ||
      queries.locked ||
      historicalQueries.locked,
    retryPolicy("selection"),
  );
}
