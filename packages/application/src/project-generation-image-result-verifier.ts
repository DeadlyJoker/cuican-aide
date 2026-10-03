import {
  parseOperationResultImage,
  type ExtensionConfiguration,
  type ProjectGenerationLink,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ExternalOperation } from "./external-operation-store-port.ts";

export type VerifiedProjectGenerationImage = Readonly<{
  filename: string;
  url: string;
  resultIndex: number;
  /** Provider-owned reference, detached canonical JSON; never a client-supplied destination. */
  providerReferenceJson: string;
}>;
export type VerifyProjectGenerationImageInput = Readonly<{
  generationLink: ProjectGenerationLink;
  configuration: ExtensionConfiguration;
  operation: ExternalOperation;
  resultIndex: number;
}>;

/** Trusted pure adapter. Historical provider identity and image format are verified by its implementation. */
export interface ProjectGenerationImageResultVerifier {
  verifyImage(
    input: VerifyProjectGenerationImageInput,
  ): VerifiedProjectGenerationImage;
}

/** Capture the actual callback before any await; accessors and asynchronous adapters are not verifier authority. */
export function captureProjectGenerationImageResultVerifier(
  input: ProjectGenerationImageResultVerifier,
): ProjectGenerationImageResultVerifier {
  if (input === null || typeof input !== "object") invalid();
  for (
    let owner: object | null = input;
    owner !== null;
    owner = Object.getPrototypeOf(owner)
  ) {
    const field = Object.getOwnPropertyDescriptor(owner, "verifyImage");
    if (field === undefined) continue;
    if (!Object.hasOwn(field, "value") || typeof field.value !== "function")
      invalid();
    const callback = field.value.bind(
      input,
    ) as ProjectGenerationImageResultVerifier["verifyImage"];
    return Object.freeze({ verifyImage: callback });
  }
  return invalid();
}

/** Shared by preflight and the Store's borrowed transaction. This function performs no I/O. */
export function verifyProjectGenerationImage(
  verifier: ProjectGenerationImageResultVerifier,
  input: VerifyProjectGenerationImageInput,
): VerifiedProjectGenerationImage {
  const { generationLink: link, configuration, operation, resultIndex } = input;
  if (
    !Number.isSafeInteger(resultIndex) ||
    resultIndex < 0 ||
    resultIndex > 15 ||
    link.binding.source !== null ||
    configuration.tenantId !== link.tenantId ||
    configuration.spaceId !== link.spaceId ||
    configuration.pluginId !== link.binding.pluginId ||
    configuration.revision !== link.binding.configurationRevision ||
    configuration.contentDigest !== link.binding.configurationDigest ||
    operation.tenantId !== link.tenantId ||
    operation.runId !== link.binding.runId ||
    operation.bindingDigest !== link.binding.bindingDigest ||
    operation.status !== "succeeded" ||
    typeof operation.resultJson !== "string" ||
    Buffer.byteLength(operation.resultJson, "utf8") > 16_384
  )
    invalid();
  const raw: unknown = verifier.verifyImage(input);
  // Observe a native Promise rejection without reading arbitrary thenable properties.
  if (raw !== null && (typeof raw === "object" || typeof raw === "function")) {
    try {
      void Promise.prototype.then.call(
        raw,
        () => undefined,
        () => undefined,
      );
    } catch {
      /* Non-Promise objects are inspected as data below. */
    }
  }
  try {
    const image = parseOperationResultImage(raw);
    if (image.resultIndex !== resultIndex) invalid();
    return image;
  } catch (cause) {
    if (cause instanceof ApplicationError) throw cause;
    throw new ApplicationError(
      "internal",
      "project_generation_image_result_invalid",
      { cause },
    );
  }
}

function invalid(): never {
  throw new ApplicationError(
    "internal",
    "project_generation_image_result_invalid",
  );
}
