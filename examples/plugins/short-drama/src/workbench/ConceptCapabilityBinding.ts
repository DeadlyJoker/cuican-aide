import type { PublicCreativeProject } from "@crewon/plugin-sdk/contracts";
import type { ConceptSelection } from "./ConceptController.types";
import type { ConceptGenerationIntentController } from "./ConceptGenerationIntentController";
import type { ConceptQueryController } from "./ConceptQueryController";
import type { ConceptImageSelectionController } from "./ConceptImageSelectionController";

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
}) {
  const { selection, project, submissions, queries, images } = input;
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
  queries.bindSource(
    source,
    input.ready,
    input.blocked || submissions.locked || images.locked,
  );
  submissions.bindSource(
    reference,
    project?.state === "active" && !input.blocked && !images.locked,
    input.ready,
  );
  images.bindSource(
    reference,
    project?.state === "active",
    input.ready,
    input.blocked ||
      input.metadataPending ||
      submissions.locked ||
      queries.locked,
  );
}
