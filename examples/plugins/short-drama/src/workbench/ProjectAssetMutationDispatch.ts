import type {
  PluginProjectAssetUiClient,
  ProjectAssetMutationResponse,
} from "../project-assets-v2-service";
import type { ProjectAssetV2AdoptionResponse } from "../project-assets-v2-types";
export type AssetMutationResult =
  | ProjectAssetMutationResponse
  | ProjectAssetV2AdoptionResponse;

import type { AssetIntent } from "./ProjectAssetController.types";

/** Dispatch the retained strict request unchanged, including its original idempotency key. */
export function dispatchAssetMutation(
  client: PluginProjectAssetUiClient,
  intent: AssetIntent,
  signal: AbortSignal,
): Promise<AssetMutationResult> {
  const options = { signal };
  switch (intent.action) {
    case "crewon.project-assets.v2.adoptMediaReference":
      return client.adoptMediaReference(intent.input, options);
    case "crewon.project-assets.v2.saveCandidate":
      return client.saveCandidate(intent.input, options);
    case "crewon.project-assets.v2.selectRevision":
      return client.selectRevision(intent.input, options);
    case "crewon.project-assets.v2.setLocked":
      return client.setLocked(intent.input, options);
    case "crewon.project-assets.v2.saveReferenceCandidate":
      return client.saveReferenceCandidate(intent.input, options);
    case "crewon.project-assets.v2.selectReference":
      return client.selectReference(intent.input, options);
  }
}
