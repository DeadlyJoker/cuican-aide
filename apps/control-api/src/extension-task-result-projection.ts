import type { ExtensionReadApplicationService } from "@crewon/application";
import { decodeComfyUiImages } from "./comfyui-image-result-verifier.ts";

type Task = Awaited<ReturnType<ExtensionReadApplicationService["getTask"]>>;

export type VerifiedExtensionTaskImage = Readonly<{
  url: string;
  filename: string;
  /** Index in the original verified provider result, before any HTTP budget trimming. */
  resultIndex: number;
}>;

/** Shared by the unchanged task v0 view and the saved-input generation view. */
export function verifiedExtensionTaskImages(
  value: Pick<Task, "binding" | "configuration">,
  operation: Task["operations"][number],
): readonly VerifiedExtensionTaskImage[] {
  if (
    operation.status !== "succeeded" ||
    (value.binding.pluginId !== "crewon.comfyui-krea2" &&
      value.binding.pluginId !== "crewon.short-drama")
  )
    return [];
  return decodeComfyUiImages({
    resultJson: operation.resultJson,
    baseUrl: value.configuration.parameters.baseUrl,
    serviceProtocol: value.configuration.parameters.serviceProtocol,
  }).map(({ url, filename, resultIndex }) => ({ url, filename, resultIndex }));
}
