import type { PublicProjectAssetView } from "../project-assets-v2-service";
import type { ConceptDraft } from "./ConceptController.types";
import type { ProjectDetails } from "./creative-project-controller";
import { validConceptName, validConceptPrompt } from "./ConceptControllerState";

/** An explicit local copy for exploration, not a persisted dependency or execution authority. */
export function assetConceptDescription(
  view: PublicProjectAssetView | null,
  details: ProjectDetails | null,
): ConceptDraft | null {
  const source = view?.selectedContentRevision;
  if (
    !view ||
    !source ||
    !details ||
    details.project.state !== "active" ||
    view.dependencyState !== "current" ||
    view.asset.projectId !== details.project.projectId ||
    source.projectId !== details.project.projectId ||
    source.assetId !== view.asset.assetId ||
    source.kind !== view.asset.kind ||
    source.contentRevision !== view.asset.selectedContentRevision ||
    source.brief.briefRevision !== details.brief.briefRevision ||
    source.brief.contentDigest !== details.brief.contentDigest ||
    !validConceptName(source.content.name) ||
    !validConceptPrompt(source.content.visualPrompt)
  )
    return null;
  return Object.freeze({
    name: source.content.name,
    prompt: source.content.visualPrompt,
    source: Object.freeze({ ...details.brief }),
    copiedFromAsset: Object.freeze({
      assetId: source.assetId,
      kind: source.kind,
      name: source.content.name,
      contentRevision: source.contentRevision,
    }),
  });
}
