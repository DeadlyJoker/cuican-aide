import {
  extensionCanonicalJson,
  extensionDigest,
  parsePluginTaskAdmissionPin,
  parseProjectGenerationReference,
  creativeProjectPrompt,
  type PluginTaskAdmissionPin,
  type ProjectGenerationReference,
} from "@crewon/domain";
import {
  parseProjectGenerationUiActionRequest,
  type ProjectGenerationUiInput,
} from "@crewon/contracts/plugins";
import { parseExtensionIdempotencyKey } from "@crewon/contracts";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import type { ExtensionMutationReceipt } from "./extension-store-port.ts";

/** Same receipt formula for task admission and acknowledgement; ordinary tasks remain unchanged. */
export function projectGenerationTaskReceipt(
  base: ExtensionMutationReceipt,
  input: ProjectGenerationReference,
  digester: ContentDigester,
): ExtensionMutationReceipt {
  const reference = parseProjectGenerationReference(input);
  return Object.freeze({
    ...base,
    requestDigest: extensionDigest(
      digester.sha256(
        extensionCanonicalJson({
          schemaVersion: "crewon.project-generation-command.v0",
          taskRequestDigest: base.requestDigest,
          reference,
        }),
      ),
    ),
  });
}

/** Business package intent namespace, independent of transient mounts/epochs and current execution state. */
export function projectGenerationUiTaskKey(
  input: Readonly<{
    sourcePin: PluginTaskAdmissionPin;
    idempotencyKey: string;
  }>,
  digester: ContentDigester,
): string {
  const pin = parsePluginTaskAdmissionPin(input.sourcePin);
  const key = parseExtensionIdempotencyKey(input.idempotencyKey);
  if (pin.action !== "crewon.project-generations.v1.generateConcept")
    throw new Error("project_generation_ui_source_action_invalid");
  return `project-ui:${extensionDigest(
    digester.sha256(
      extensionCanonicalJson({
        schemaVersion: "crewon.project-generation-ui-intent.v1",
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

/** Host-only assembly; prompt is loaded from the selected saved revision, never accepted in UI JSON. */
export function projectGenerationUiTaskCommand(
  input: Readonly<{
    sourcePin: PluginTaskAdmissionPin;
    executionPin: PluginTaskAdmissionPin;
    request: ProjectGenerationUiInput;
    prompt: string;
  }>,
  digester: ContentDigester,
): CreateExtensionTaskCommand {
  const request = parseProjectGenerationUiActionRequest({
    action: "crewon.project-generations.v1.generateConcept",
    input: input.request,
  }).input;
  const pin = parsePluginTaskAdmissionPin(input.executionPin);
  return Object.freeze({
    pluginId: pin.pluginId,
    threadId: request.threadId,
    expectedThreadRevision: request.expectedThreadRevision,
    idempotencyKey: projectGenerationUiTaskKey(
      { sourcePin: input.sourcePin, idempotencyKey: request.idempotencyKey },
      digester,
    ),
    intent: Object.freeze({
      kind: "generate",
      input: Object.freeze({ prompt: creativeProjectPrompt(input.prompt) }),
    }),
  });
}
