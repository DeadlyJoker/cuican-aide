import {
  parsePluginUiJsonValue,
  parseProjectGenerationSelectionUiActionRequest,
  type ProjectGenerationSelectionUiInput,
} from "@crewon/contracts/plugins";
import {
  assertConceptSelectionResult,
  captureProjectConceptSelectionPublication,
  createOperationResultLink,
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectRevision,
  creativeProjectTimestamp,
  extensionCanonicalJson,
  parseCurrentConceptSelection,
  parseOperationResultLink,
  type OperationResultLink,
  type ProjectGenerationLink,
  type ExtensionConfiguration,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreativeProjectMutationReceipt } from "./creative-project-store-port.ts";
import type {
  CommitProjectConceptSelectionResult,
  CurrentConceptSelectionReadResult,
  ProjectConceptSelectionCommandSource,
} from "./project-concept-selection-store-port.ts";
import type { ExternalOperation } from "./external-operation-store-port.ts";
import type { VerifiedProjectGenerationImage } from "./project-generation-image-result-verifier.ts";
import {
  creativeInput,
  creativeStored,
} from "./creative-project-application-support.ts";
import { projectGenerationHostFields } from "./project-generation-execution-authority.ts";

export function captureConceptSelectionCommandSource(
  input: ProjectConceptSelectionCommandSource,
): ProjectConceptSelectionCommandSource {
  if (input === null || typeof input !== "object") invalid();
  const kind = Object.getOwnPropertyDescriptor(input, "kind");
  if (!kind?.enumerable || !Object.hasOwn(kind, "value")) invalid();
  if (kind.value === "authenticated-project-command") {
    projectGenerationHostFields(input, ["kind"]);
    return Object.freeze({ kind: "authenticated-project-command" });
  }
  if (kind.value !== "installed-plugin-ui") invalid();
  const value = projectGenerationHostFields(input, ["kind", "publication"]);
  return Object.freeze({
    kind: "installed-plugin-ui",
    publication: captureProjectConceptSelectionPublication(value.publication),
  });
}

export function selectionCommand(
  input: ProjectGenerationSelectionUiInput,
): ProjectGenerationSelectionUiInput {
  return creativeInput(() => {
    const request = parseProjectGenerationSelectionUiActionRequest({
      action: "crewon.project-generation-selections.v1.selectConceptImage",
      input,
    });
    if (
      request.action !==
      "crewon.project-generation-selections.v1.selectConceptImage"
    )
      invalid();
    return request.input;
  });
}

export function conceptSelectionReceipt(
  actor: ActorContext,
  command: ProjectGenerationSelectionUiInput,
  origin: ProjectConceptSelectionCommandSource,
  digester: ContentDigester,
): CreativeProjectMutationReceipt {
  const pin =
    origin.kind === "installed-plugin-ui" ? origin.publication.sourcePin : null;
  const source =
    pin === null
      ? Object.freeze({ kind: "authenticated-project-command" })
      : Object.freeze({
          kind: "installed-plugin-ui",
          tenantId: pin.tenantId,
          spaceId: pin.spaceId,
          profileId: pin.profileId,
          principalId: pin.principalId,
          actorId: pin.actorId,
          pluginId: pin.pluginId,
          packageDigest: pin.packageDigest,
          contributionId: pin.contributionId,
          action: pin.action,
        });
  return Object.freeze({
    idempotencyKey:
      "concept-selection:" +
      creativeProjectDigest(
        digester.sha256(
          extensionCanonicalJson({
            schemaVersion: "crewon.concept-selection-ui-intent.v1",
            source,
            idempotencyKey: command.idempotencyKey,
          }),
        ),
      ).slice(7),
    requestDigest: creativeProjectDigest(
      digester.sha256(
        extensionCanonicalJson({
          schemaVersion: "crewon.concept-selection-command.v1",
          actor,
          source,
          command,
        }),
      ),
    ),
  });
}

export function assertSelectionScope(
  actor: ActorContext,
  query: Readonly<{ projectId: string; assetId: string }>,
  result: Pick<CommitProjectConceptSelectionResult, "pointer" | "resultLink">,
): void {
  const { pointer, resultLink } = result;
  assertConceptSelectionResult(pointer, resultLink);
  if (
    pointer.tenantId !== actor.tenantId ||
    pointer.spaceId !== actor.spaceId ||
    pointer.ownerPrincipalId !== actor.principalId ||
    pointer.projectId !== query.projectId ||
    pointer.assetId !== query.assetId
  )
    invalid();
}

export function checkedConceptSelectionResult(
  input: unknown,
  actor: ActorContext,
  command: ProjectGenerationSelectionUiInput,
  digester: ContentDigester,
): CommitProjectConceptSelectionResult {
  return creativeStored(() => {
    const value = selectionData(input, [
      "disposition",
      "pointer",
      "resultLink",
    ]);
    if (value.disposition !== "committed" && value.disposition !== "replayed")
      invalid();
    const result = Object.freeze({
      disposition: value.disposition,
      pointer: parseCurrentConceptSelection(value.pointer, digester),
      resultLink: parseOperationResultLink(value.resultLink, digester),
    });
    assertSelectionScope(actor, command.reference, result);
    if (
      result.pointer.selectionRevision !==
        command.expectedSelectionRevision + 1 ||
      result.pointer.selectedByActorId !== actor.actorId ||
      result.resultLink.reference.assetRevision !==
        command.reference.assetRevision ||
      result.resultLink.operationId !== command.operationId ||
      result.resultLink.operationRevision !==
        command.expectedOperationRevision ||
      result.resultLink.image.resultIndex !== command.resultIndex
    )
      invalid();
    return result;
  });
}

export function checkedCurrentConceptSelection(
  input: unknown,
  actor: ActorContext,
  query: Readonly<{ projectId: string; assetId: string }>,
  digester: ContentDigester,
): CurrentConceptSelectionReadResult {
  return creativeStored(() => {
    const value = selectionData(input, ["selectionRevision", "current"]);
    const selectionRevision = creativeProjectRevision(value.selectionRevision, {
      minimum: 0,
    });
    if (value.current === null) {
      if (selectionRevision !== 0) invalid();
      return Object.freeze({ selectionRevision, current: null });
    }
    const current = selectionData(value.current, ["pointer", "resultLink"]);
    const result = Object.freeze({
      pointer: parseCurrentConceptSelection(current.pointer, digester),
      resultLink: parseOperationResultLink(current.resultLink, digester),
    });
    assertSelectionScope(actor, query, result);
    if (selectionRevision !== result.pointer.selectionRevision) invalid();
    return Object.freeze({ selectionRevision, current: result });
  });
}

/** No provider format is parsed here. This only captures the actual terminal operation and its original owner. */
export function checkedSelectionOperation(
  input: unknown,
  link: ProjectGenerationLink,
  operationId: string,
  expectedRevision: number,
): ExternalOperation {
  if (input === null)
    throw new ApplicationError(
      "notFound",
      "concept_selection_operation_not_found",
    );
  return operationIntegrity(() => {
    const value = selectionData(input, [
      "schemaVersion",
      "tenantId",
      "runId",
      "bindingDigest",
      "status",
      "resultJson",
      "operationId",
      "executionId",
      "idempotencyKey",
      "actionDigest",
      "requestDigest",
      "correlationId",
      "providerOperationId",
      "revision",
      "createdAt",
      "updatedAt",
    ]);
    if (
      value.schemaVersion !== "crewon.external-operation.v0" ||
      value.tenantId !== link.tenantId ||
      value.runId !== link.binding.runId ||
      value.bindingDigest !== link.binding.bindingDigest ||
      value.operationId !== operationId
    )
      invalid();
    if (value.status !== "succeeded")
      throw new ApplicationError(
        "conflict",
        "concept_selection_operation_not_succeeded",
      );
    if (creativeProjectRevision(value.revision) !== expectedRevision)
      throw new ApplicationError(
        "conflict",
        "concept_selection_operation_revision_conflict",
      );
    if (
      typeof value.resultJson !== "string" ||
      Buffer.byteLength(value.resultJson, "utf8") > 16_384
    )
      invalid();
    for (const field of ["executionId", "idempotencyKey", "correlationId"])
      creativeProjectOpaqueId(value[field]);
    for (const field of ["actionDigest", "requestDigest"])
      creativeProjectDigest(value[field]);
    if (value.providerOperationId !== null)
      creativeProjectOpaqueId(value.providerOperationId);
    if (
      creativeProjectTimestamp(value.updatedAt) <
      creativeProjectTimestamp(value.createdAt)
    )
      invalid();
    return Object.freeze(value) as unknown as ExternalOperation;
  });
}

function operationIntegrity<T>(verify: () => T): T {
  try {
    return verify();
  } catch (cause) {
    if (cause instanceof ApplicationError) throw cause;
    throw new ApplicationError(
      "internal",
      "concept_selection_store_result_invalid",
      { cause },
    );
  }
}

export function conceptOperationResultLink(
  input: Readonly<{
    actor: ActorContext;
    generationLink: ProjectGenerationLink;
    configuration: ExtensionConfiguration;
    packageDigest: string;
    operation: ExternalOperation;
    image: VerifiedProjectGenerationImage;
  }>,
  digester: ContentDigester,
): OperationResultLink {
  return createOperationResultLink(
    {
      actor: input.actor,
      generationLink: input.generationLink,
      configuration: input.configuration,
      packageDigest: input.packageDigest,
      operation: {
        operationId: input.operation.operationId,
        operationRevision: input.operation.revision,
        operationDigest: digester.sha256(
          extensionCanonicalJson(input.operation),
        ),
        rawResultDigest: digester.sha256(input.operation.resultJson!),
        observedAt: input.operation.updatedAt,
      },
      image: input.image,
    },
    digester,
  );
}

export function selectionData(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  const detached = parsePluginUiJsonValue(input, { maxBytes: 65536 });
  if (
    detached === null ||
    typeof detached !== "object" ||
    Array.isArray(detached) ||
    Object.keys(detached).sort().join("\0") !== [...fields].sort().join("\0")
  )
    invalid();
  return detached as Readonly<Record<string, unknown>>;
}

export function selectionMethod<T extends (...args: never[]) => unknown>(
  receiver: unknown,
  key: string,
): T {
  if (
    receiver === null ||
    (typeof receiver !== "object" && typeof receiver !== "function")
  )
    invalid();
  for (
    let current: object | null = receiver as object;
    current !== null;
    current = Object.getPrototypeOf(current)
  ) {
    const field = Object.getOwnPropertyDescriptor(current, key);
    if (field === undefined) continue;
    if (!Object.hasOwn(field, "value") || typeof field.value !== "function")
      invalid();
    return Function.prototype.bind.call(field.value, receiver) as T;
  }
  return invalid();
}

function invalid(): never {
  throw new ApplicationError(
    "internal",
    "concept_selection_store_result_invalid",
  );
}
