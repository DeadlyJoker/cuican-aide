import {
  extensionCanonicalJson,
  type ExtensionContentDigester,
} from "./extension-configuration.ts";
import {
  parseOperationResultLink,
  type OperationResultLink,
} from "./operation-result-link.ts";
import {
  parseProjectQueryReference,
  type ProjectQueryReference,
} from "./project-query-link.ts";
import {
  creativeProjectDigest,
  creativeProjectFailure,
  creativeProjectNextRevision,
  creativeProjectOpaqueId,
  creativeProjectRecord,
  creativeProjectRevision,
  creativeProjectScopeFields,
  creativeProjectTimestamp,
  validateCreativeProjectActor,
} from "./creative-project-validation.ts";
import type {
  CreativeProjectActor,
  CreativeProjectScope,
} from "./creative-project.ts";
export type CurrentConceptSelection = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.current-concept-selection.v1";
    ownerPrincipalId: string;
    assetId: string;
    selectionRevision: number;
    reference: ProjectQueryReference;
    resultLinkDigest: string;
    selectedByActorId: string;
    selectedAt: string;
    contentDigest: string;
  }>;
export function parseCurrentConceptSelection(
  input: unknown,
  digester: ExtensionContentDigester,
): CurrentConceptSelection {
  const value = creativeProjectRecord(input, [
    "schemaVersion",
    "tenantId",
    "spaceId",
    "projectId",
    "ownerPrincipalId",
    "assetId",
    "selectionRevision",
    "reference",
    "resultLinkDigest",
    "selectedByActorId",
    "selectedAt",
    "contentDigest",
  ]);
  if (value.schemaVersion !== "crewon.current-concept-selection.v1")
    creativeProjectFailure("concept_selection_version_unsupported");
  const body = {
      schemaVersion: "crewon.current-concept-selection.v1" as const,
      ...creativeProjectScopeFields(value),
      ownerPrincipalId: creativeProjectOpaqueId(value.ownerPrincipalId),
      assetId: creativeProjectOpaqueId(value.assetId),
      selectionRevision: creativeProjectRevision(value.selectionRevision),
      reference: parseProjectQueryReference(value.reference),
      resultLinkDigest: creativeProjectDigest(value.resultLinkDigest),
      selectedByActorId: creativeProjectOpaqueId(value.selectedByActorId),
      selectedAt: creativeProjectTimestamp(value.selectedAt),
    },
    contentDigest = creativeProjectDigest(value.contentDigest);
  if (
    body.reference.projectId !== body.projectId ||
    body.reference.assetId !== body.assetId ||
    digester.sha256(extensionCanonicalJson(body)) !== contentDigest ||
    Buffer.byteLength(extensionCanonicalJson({ ...body, contentDigest })) > 8192
  )
    creativeProjectFailure("concept_selection_record_invalid");
  return Object.freeze({ ...body, contentDigest });
}
export function assertConceptSelectionResult(
  pointer: CurrentConceptSelection,
  link: OperationResultLink,
): void {
  if (
    pointer.tenantId !== link.tenantId ||
    pointer.spaceId !== link.spaceId ||
    pointer.projectId !== link.projectId ||
    pointer.ownerPrincipalId !== link.ownerPrincipalId ||
    pointer.resultLinkDigest !== link.contentDigest ||
    extensionCanonicalJson(pointer.reference) !==
      extensionCanonicalJson(link.reference)
  )
    creativeProjectFailure("concept_selection_result_mismatch");
}
export function createCurrentConceptSelection(
  input: Readonly<{
    actor: CreativeProjectActor;
    resultLink: OperationResultLink;
    previous: CurrentConceptSelection | null;
    expectedSelectionRevision: number;
    at: string;
  }>,
  digester: ExtensionContentDigester,
): CurrentConceptSelection {
  const value = creativeProjectRecord(input, [
      "actor",
      "resultLink",
      "previous",
      "expectedSelectionRevision",
      "at",
    ]),
    actor = validateCreativeProjectActor(value.actor),
    link = parseOperationResultLink(value.resultLink, digester),
    previous =
      value.previous === null
        ? null
        : parseCurrentConceptSelection(value.previous, digester),
    expected = creativeProjectRevision(value.expectedSelectionRevision, {
      minimum: 0,
    }),
    at = creativeProjectTimestamp(value.at);
  if (
    actor.tenantId !== link.tenantId ||
    actor.spaceId !== link.spaceId ||
    actor.principalId !== link.ownerPrincipalId ||
    (previous &&
      (previous.tenantId !== link.tenantId ||
        previous.spaceId !== link.spaceId ||
        previous.projectId !== link.projectId ||
        previous.assetId !== link.reference.assetId ||
        previous.ownerPrincipalId !== link.ownerPrincipalId))
  )
    creativeProjectFailure("concept_selection_owner_mismatch");
  if ((previous?.selectionRevision ?? 0) !== expected)
    creativeProjectFailure("concept_selection_revision_conflict");
  const body = {
    schemaVersion: "crewon.current-concept-selection.v1" as const,
    tenantId: link.tenantId,
    spaceId: link.spaceId,
    projectId: link.projectId,
    ownerPrincipalId: link.ownerPrincipalId,
    assetId: link.reference.assetId,
    selectionRevision: creativeProjectNextRevision(expected),
    reference: link.reference,
    resultLinkDigest: link.contentDigest,
    selectedByActorId: actor.actorId,
    selectedAt: at,
  };
  return parseCurrentConceptSelection(
    { ...body, contentDigest: digester.sha256(extensionCanonicalJson(body)) },
    digester,
  );
}
