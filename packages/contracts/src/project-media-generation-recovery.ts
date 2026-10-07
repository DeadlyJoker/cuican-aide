import { parsePluginUiJsonValue, pluginUiFields } from "./plugin-ui-json.ts";
import { ContractValidationError } from "./contract-validation-error.ts";
import { assetContractId } from "./project-asset-contract-support.ts";
import {
  parsePluginUiRecoveryHint,
  type PluginUiRecoveryHint,
} from "./plugin-ui-recovery-contract.ts";
import {
  PROJECT_MEDIA_GENERATE_UI_ACTION,
  parseProjectMediaGenerationUiRequest,
  type GenerateProjectMediaResponse,
} from "./project-media-generations.ts";
export function parseProjectMediaGenerationRecoveryRequest(input: unknown) {
  const fields = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 1024 }),
    ["projectId", "threadId"],
  );
  return Object.freeze({
    projectId: assetContractId(fields.projectId),
    threadId: assetContractId(fields.threadId),
  });
}
export type ProjectMediaGenerationRecoveryHint = Omit<
  PluginUiRecoveryHint,
  "request" | "receipt"
> &
  Readonly<{
    request: ReturnType<typeof parseProjectMediaGenerationUiRequest>;
    receipt: GenerateProjectMediaResponse | null;
  }>;
export function parseProjectMediaGenerationRecoveryResponse(
  input: unknown,
): Readonly<{ intent: ProjectMediaGenerationRecoveryHint | null }> {
  const value = pluginUiFields(
    parsePluginUiJsonValue(input, { maxBytes: 4096 }),
    ["intent"],
  );
  if (value.intent === null) return Object.freeze({ intent: null });
  const intent = parsePluginUiRecoveryHint(value.intent);
  if (intent.request.action !== PROJECT_MEDIA_GENERATE_UI_ACTION)
    throw new ContractValidationError(
      "project_media_generation_recovery_invalid",
    );
  return Object.freeze({
    intent: intent as ProjectMediaGenerationRecoveryHint,
  });
}
