import {
  parsePluginUiRecoveryRequest,
  type PluginUiRecoveryHint,
  type PluginUiRecoveryRequest,
} from "@crewon/contracts";
import {
  parseProjectGenerationUiActionResponse,
  parseProjectGenerationQueryUiActionResponse,
  parseProjectGenerationSelectionUiActionResponse,
} from "@crewon/contracts/plugins";
import { extensionCanonicalJson, pluginUiIntentKind } from "@crewon/domain";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { PluginUiIntentPayloadVerifier } from "./plugin-ui-intent-journal-store.ts";
import { ApplicationError } from "./application-error.ts";

export function pluginUiRecoveryReceipt(
  request: PluginUiRecoveryRequest,
  input: unknown,
): NonNullable<PluginUiRecoveryHint["receipt"]> {
  switch (request.action) {
    case "crewon.project-generations.v1.generateConcept":
      return parseProjectGenerationUiActionResponse(request, input);
    case "crewon.project-generation-queries.v1.queryConceptGeneration":
      return parseProjectGenerationQueryUiActionResponse(request, input);
    case "crewon.project-generation-selections.v1.selectConceptImage":
      return parseProjectGenerationSelectionUiActionResponse(
        request,
        input,
      ) as NonNullable<PluginUiRecoveryHint["receipt"]>;
  }
}

/** Synchronous bounded protocol validation for the adapter's borrowed transaction connection. */
export function createPluginUiIntentPayloadVerifier(
  digester: ContentDigester,
): PluginUiIntentPayloadVerifier {
  const digest = digester.sha256.bind(digester);
  const request = (
    input: Parameters<PluginUiIntentPayloadVerifier["verifyRequest"]>[0],
  ) => {
    if (
      typeof input.requestJson !== "string" ||
      Buffer.byteLength(input.requestJson) > 24 * 1024
    )
      invalid();
    const parsed = parsePluginUiRecoveryRequest(JSON.parse(input.requestJson));
    if (
      parsed.action !== input.action ||
      pluginUiIntentKind(parsed.action) !== input.kind ||
      extensionCanonicalJson(parsed) !== input.requestJson
    )
      invalid();
    return parsed;
  };
  return Object.freeze({
    verifyRequest: (
      input: Parameters<PluginUiIntentPayloadVerifier["verifyRequest"]>[0],
    ) => {
      request(input);
    },
    verifyReceipt: (
      input: Parameters<PluginUiIntentPayloadVerifier["verifyReceipt"]>[0],
    ) => {
      const parsed = request(input);
      if (
        typeof input.receiptJson !== "string" ||
        Buffer.byteLength(input.receiptJson) > 24 * 1024
      )
        invalid();
      const receipt = pluginUiRecoveryReceipt(
        parsed,
        JSON.parse(input.receiptJson),
      );
      if (extensionCanonicalJson(receipt) !== input.receiptJson) invalid();
      const { disposition: _disposition, ...identity } = receipt;
      return Object.freeze({
        receiptIdentityDigest: digest(extensionCanonicalJson(identity)),
      });
    },
  });
}

function invalid(): never {
  throw new ApplicationError("internal", "plugin_ui_recovery_payload_invalid");
}
