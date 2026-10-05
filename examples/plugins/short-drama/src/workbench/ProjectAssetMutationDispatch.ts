import type {
  PluginProjectAssetUiClient,
  ProjectAssetMutationResponse,
} from "../project-assets-service";
import type { AssetIntent } from "./ProjectAssetController.types";

/** Dispatch the retained strict request unchanged, including its original idempotency key. */
export function dispatchAssetMutation(
  client: PluginProjectAssetUiClient,
  intent: AssetIntent,
  signal: AbortSignal,
): Promise<ProjectAssetMutationResponse> {
  const options = { signal };
  switch (intent.action) {
    case "crewon.project-assets.v1.saveCandidate":
      return client.saveCandidate(intent.input, options);
    case "crewon.project-assets.v1.selectRevision":
      return client.selectRevision(intent.input, options);
    case "crewon.project-assets.v1.setLocked":
      return client.setLocked(intent.input, options);
    case "crewon.project-assets.v1.saveReferenceCandidate":
      return client.saveReferenceCandidate(intent.input, options);
    case "crewon.project-assets.v1.selectReference":
      return client.selectReference(intent.input, options);
  }
}
