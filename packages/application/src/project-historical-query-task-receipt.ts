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
  parseProjectHistoricalQueryUiActionRequest,
  type ProjectHistoricalQueryUiInput,
} from "@crewon/contracts/plugins";
import { parseExtensionIdempotencyKey } from "@crewon/contracts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import type { ExtensionMutationReceipt } from "./extension-store-port.ts";

/** Query intents have a separate stable namespace; transient mounts and epochs are excluded. */
export function projectHistoricalQueryUiTaskKey(
  input: Readonly<{
    sourcePin: PluginTaskAdmissionPin;
    idempotencyKey: string;
  }>,
  digester: ContentDigester,
): string {
  const pin = parsePluginTaskAdmissionPin(input.sourcePin);
  const key = parseExtensionIdempotencyKey(input.idempotencyKey);
  if (
    pin.action !== "crewon.project-historical-queries.v1.queryConceptGeneration"
  )
    throw new Error("project_historical_query_ui_source_action_invalid");
  return `project-historical-query-ui:${extensionDigest(
    digester.sha256(
      extensionCanonicalJson({
        schemaVersion: "crewon.project-historical-query-ui-intent.v1",
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
export function projectHistoricalQueryUiTaskCommand(
  input: Readonly<{
    sourcePin: PluginTaskAdmissionPin;
    executionPin: PluginTaskAdmissionPin;
    request: ProjectHistoricalQueryUiInput;
    sourceRunId: string;
  }>,
  digester: ContentDigester,
): CreateExtensionTaskCommand {
  const request = parseProjectHistoricalQueryUiActionRequest({
    action: "crewon.project-historical-queries.v1.queryConceptGeneration",
    input: input.request,
  }).input;
  const pin = parsePluginTaskAdmissionPin(input.executionPin);
  return Object.freeze({
    pluginId: pin.pluginId,
    threadId: request.threadId,
    expectedThreadRevision: request.expectedThreadRevision,
    idempotencyKey: projectHistoricalQueryUiTaskKey(
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
