import {
  ApplicationError,
  type ProjectGenerationImageResultVerifier,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  pluginInstallationDigest,
} from "@crewon/domain";

export type VerifiedComfyUiImage = Readonly<{
  filename: string;
  subfolder: string;
  type: "output";
  url: string;
  resultIndex: number;
}>;
export type ComfyUiResultIdentity = Readonly<{
  /** Omitted legacy identities authorize only the original Krea plugin. */
  pluginId?: "crewon.comfyui-krea2" | "crewon.short-drama";
  pluginVersion: string;
  manifestDigest: string;
  implementationDigest: string;
}>;

/** Original provider result decoder, shared by the unchanged v0 projection and explicit selection adapter. */
export function decodeComfyUiImages(
  input: Readonly<{
    resultJson: string | null;
    baseUrl: unknown;
    serviceProtocol?: unknown;
  }>,
): readonly VerifiedComfyUiImage[] {
  if (
    input.serviceProtocol !== undefined &&
    input.serviceProtocol !== "native" &&
    input.serviceProtocol !== "workflow-panel-v1" &&
    input.serviceProtocol !== "workflow-api-v1"
  )
    invalid();
  const viewPath =
    input.serviceProtocol === "workflow-panel-v1" ||
    input.serviceProtocol === "workflow-api-v1"
      ? "/api/comfy/view"
      : "/view";
  if (input.resultJson === null || Buffer.byteLength(input.resultJson) > 16_384)
    invalid();
  const result = record(JSON.parse(input.resultJson), ["images"]);
  if (!Array.isArray(result.images) || result.images.length > 16) invalid();
  const baseUrl = serviceUrl(input.baseUrl);
  return (result.images as unknown[]).map((entry, resultIndex) => {
    const image = record(entry, ["filename", "subfolder", "type", "url"]);
    if (
      typeof image.filename !== "string" ||
      !image.filename ||
      image.filename.length > 255 ||
      /[\\/\u0000-\u001f\u007f]/u.test(image.filename) ||
      image.filename === "." ||
      image.filename === ".." ||
      typeof image.subfolder !== "string" ||
      image.subfolder.length > 512 ||
      /[\\\u0000-\u001f\u007f]/u.test(image.subfolder) ||
      image.subfolder.startsWith("/") ||
      image.subfolder
        .split("/")
        .some((part) => part === "." || part === "..") ||
      image.type !== "output"
    )
      invalid();
    const expected = new URL(
      `${viewPath}?${new URLSearchParams({ filename: image.filename as string, subfolder: image.subfolder as string, type: "output" })}`,
      baseUrl,
    ).href;
    if (image.url !== expected || Buffer.byteLength(expected) > 2048) invalid();
    return Object.freeze({
      filename: image.filename as string,
      subfolder: image.subfolder as string,
      type: "output" as const,
      url: expected,
      resultIndex,
    });
  });
}

/** Pure deployment-approved provider adapter. No Node borrowing, supplier calls or database access. */
export function createComfyUiProjectGenerationImageResultVerifier(
  input: Readonly<{ identities: readonly ComfyUiResultIdentity[] }>,
): ProjectGenerationImageResultVerifier {
  const value = pluginSecurityRecord(input, ["identities"]);
  const list = value.identities;
  if (
    !Array.isArray(list) ||
    Object.getPrototypeOf(list) !== Array.prototype ||
    list.length < 1 ||
    list.length > 32 ||
    Reflect.ownKeys(list).length !== list.length + 1
  )
    invalidConfiguration();
  const identities = Array.from({ length: list.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(list, String(index));
    if (!entry?.enumerable || !Object.hasOwn(entry, "value"))
      invalidConfiguration();
    const hasPluginId =
      entry.value !== null &&
      typeof entry.value === "object" &&
      Object.hasOwn(entry.value, "pluginId");
    const fields = pluginSecurityRecord(entry.value, [
      ...(hasPluginId ? ["pluginId"] : []),
      "pluginVersion",
      "manifestDigest",
      "implementationDigest",
    ]);
    if (
      (hasPluginId &&
        fields.pluginId !== "crewon.comfyui-krea2" &&
        fields.pluginId !== "crewon.short-drama") ||
      typeof fields.pluginVersion !== "string" ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(
        fields.pluginVersion,
      ) ||
      fields.pluginVersion.length > 32
    )
      invalidConfiguration();
    return Object.freeze({
      pluginId: hasPluginId
        ? (fields.pluginId as "crewon.comfyui-krea2" | "crewon.short-drama")
        : "crewon.comfyui-krea2",
      pluginVersion: fields.pluginVersion as string,
      manifestDigest: pluginInstallationDigest(fields.manifestDigest),
      implementationDigest: pluginInstallationDigest(
        fields.implementationDigest,
      ),
    });
  });
  if (
    new Set(identities.map((identity) => extensionCanonicalJson(identity)))
      .size !== identities.length
  )
    invalidConfiguration();
  return Object.freeze({
    verifyImage({
      generationLink,
      configuration,
      operation,
      resultIndex,
    }: Parameters<ProjectGenerationImageResultVerifier["verifyImage"]>[0]) {
      const binding = generationLink.binding;
      if (
        (binding.pluginId !== "crewon.comfyui-krea2" &&
          binding.pluginId !== "crewon.short-drama") ||
        binding.source !== null ||
        configuration.pluginId !== binding.pluginId ||
        configuration.tenantId !== binding.tenantId ||
        configuration.spaceId !== binding.spaceId ||
        configuration.revision !== binding.configurationRevision ||
        configuration.contentDigest !== binding.configurationDigest ||
        !identities.some(
          (identity) =>
            identity.pluginId === binding.pluginId &&
            identity.pluginVersion === configuration.pluginVersion &&
            identity.manifestDigest === configuration.manifestDigest &&
            identity.implementationDigest ===
              configuration.implementationDigest,
        ) ||
        operation.tenantId !== binding.tenantId ||
        operation.runId !== binding.runId ||
        operation.bindingDigest !== binding.bindingDigest ||
        operation.status !== "succeeded" ||
        !Number.isSafeInteger(resultIndex) ||
        resultIndex < 0 ||
        resultIndex > 15
      )
        unavailable();
      const images = decodeComfyUiImages({
        resultJson: operation.resultJson,
        baseUrl: configuration.parameters.baseUrl,
        serviceProtocol: configuration.parameters.serviceProtocol,
      });
      const image = images[resultIndex];
      if (image === undefined) unavailable();
      return Object.freeze({
        filename: image.filename,
        url: image.url,
        resultIndex,
        providerReferenceJson: extensionCanonicalJson({
          filename: image.filename,
          subfolder: image.subfolder,
          type: image.type,
        }),
      });
    },
  });
}

function serviceUrl(input: unknown): URL {
  if (typeof input !== "string") invalid();
  let url: URL;
  try {
    url = new URL(input as string);
  } catch {
    invalid();
  }
  if (
    url!.protocol !== "https:" ||
    url!.username ||
    url!.password ||
    url!.search ||
    url!.hash ||
    url!.pathname !== "/"
  )
    invalid();
  return url!;
}
function record(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("\0") !== [...keys].sort().join("\0")
  )
    invalid();
  return input as Record<string, unknown>;
}
function invalid(): never {
  throw new ApplicationError("internal", "extension_result_invalid");
}
function unavailable(): never {
  throw new ApplicationError(
    "conflict",
    "project_generation_selection_result_unavailable",
  );
}
function invalidConfiguration(): never {
  throw new Error("comfyui_result_verifier_configuration_invalid");
}

/** Flat authority DTO snapshots: no getters, inherited fields, unknown fields or serialization hooks. */
function pluginSecurityRecord(input: unknown, fields: readonly string[]) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("plugin_security_object_invalid");
  const prototype = Object.getPrototypeOf(input);
  const keys = Reflect.ownKeys(input);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new Error("plugin_security_fields_invalid");
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        )
          throw new Error("plugin_security_fields_invalid");
        return [field, descriptor.value] as const;
      }),
    ),
  );
}
