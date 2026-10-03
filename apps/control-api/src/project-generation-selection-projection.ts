import type { ProjectConceptSelectionApplicationService } from "@crewon/application";
import {
  parseGetConceptSelectionResponse,
  parseSelectConceptImageResponse,
  type GetConceptSelectionResponse,
  type SelectConceptImageResponse,
} from "@crewon/contracts";

type Read = Awaited<
  ReturnType<ProjectConceptSelectionApplicationService["getConceptSelection"]>
>;
type Mutation = Awaited<
  ReturnType<ProjectConceptSelectionApplicationService["selectConceptImage"]>
>;
type Selected = NonNullable<Read["current"]>;

/** The immutable receipt and the current pointer deliberately have separate projections. */
export function projectConceptImageSelection(
  result: Mutation,
): SelectConceptImageResponse {
  return parseSelectConceptImageResponse({
    disposition: result.disposition,
    selectionRevision: result.pointer.selectionRevision,
    selection: projectSelection(result),
  });
}

export function projectConceptSelection(
  result: Read,
): GetConceptSelectionResponse {
  return parseGetConceptSelectionResponse({
    selectionRevision: result.selectionRevision,
    current:
      result.current === null
        ? null
        : {
            ...projectSelection(result.current),
            requiresConfirmation: result.current.requiresConfirmation,
          },
  });
}

function projectSelection(value: Pick<Selected, "pointer" | "resultLink">) {
  const { pointer, resultLink } = value;
  return {
    reference: pointer.reference,
    operationId: resultLink.operationId,
    operationRevision: resultLink.operationRevision,
    resultIndex: resultLink.image.resultIndex,
    filename: resultLink.image.filename,
    url: resultLink.image.url,
    selectedAt: pointer.selectedAt,
  };
}
