import {
  extensionCanonicalJson,
  extensionDigest,
  extensionOpaqueId,
  parsePluginTaskAdmissionPin,
  parseProjectQueryReference,
  type PluginTaskAdmissionPin,
  type ProjectQueryReference,
} from "@crewon/domain";
import {
  parseProjectGenerationQueryUiActionRequest,
  type ProjectGenerationQueryUiInput,
} from "@crewon/contracts/plugins";
import { parseExtensionIdempotencyKey } from "@crewon/contracts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import type { ExtensionMutationReceipt } from "./extension-store-port.ts";

export function projectQueryTaskReceipt(
  base: ExtensionMutationReceipt,
  input: Readonly<{
    reference: ProjectQueryReference;
    generationLinkDigest: string;
  }>,
  digester: ContentDigester,
): ExtensionMutationReceipt {
  return Object.freeze({
    ...base,
    requestDigest: extensionDigest(
      digester.sha256(
        extensionCanonicalJson({
          schemaVersion: "crewon.project-query-command.v1",
          taskRequestDigest: base.requestDigest,
          reference: parseProjectQueryReference(input.reference),
          generationLinkDigest: extensionDigest(input.generationLinkDigest),
        }),
      ),
    ),
  });
}

/** Query intents have a separate stable namespace; transient mounts and epochs are excluded. */
export function projectGenerationQueryUiTaskKey(
  input: Readonly<{
    sourcePin: PluginTaskAdmissionPin;
    idempotencyKey: string;
  }>,
  digester: ContentDigester,
): string {
  const pin = parsePluginTaskAdmissionPin(input.sourcePin);
  const key = parseExtensionIdempotencyKey(input.idempotencyKey);
  if (
    pin.action !== "crewon.project-generation-queries.v1.queryConceptGeneration"
  )
    throw new Error("project_query_ui_source_action_invalid");
  return `project-query-ui:${extensionDigest(
    digester.sha256(
      extensionCanonicalJson({
        schemaVersion: "crewon.project-query-ui-intent.v1",
        source: {
          tenantId: pin.tenantId,
          spaceId: pin.spaceId,
          profileId: pin.profileId,
          principalId: pin.principalId,
          actorId: pin.actorId,
          pluginId: pin.pluginId,
          packageDigest: pin.packageDigest,
          contributionId: pin.contributionId,
          action: pin.action,
        },
        idempotencyKey: key,
      }),
    ),
  ).slice(7)}`;
}

/** Source Run is loaded by the Host from the authorized immutable project link. */
export function projectGenerationQueryUiTaskCommand(
  input: Readonly<{
    sourcePin: PluginTaskAdmissionPin;
    executionPin: PluginTaskAdmissionPin;
    request: ProjectGenerationQueryUiInput;
    sourceRunId: string;
  }>,
  digester: ContentDigester,
): CreateExtensionTaskCommand {
  const request = parseProjectGenerationQueryUiActionRequest({
    action: "crewon.project-generation-queries.v1.queryConceptGeneration",
    input: input.request,
  }).input;
  const pin = parsePluginTaskAdmissionPin(input.executionPin);
  return Object.freeze({
    pluginId: pin.pluginId,
    threadId: request.threadId,
    expectedThreadRevision: request.expectedThreadRevision,
    idempotencyKey: projectGenerationQueryUiTaskKey(
      {
        sourcePin: input.sourcePin,
        idempotencyKey: request.idempotencyKey,
      },
      digester,
    ),
    intent: Object.freeze({
      kind: "query",
      sourceRunId: extensionOpaqueId(input.sourceRunId),
      operationId: request.operationId,
    }),
  });
}
