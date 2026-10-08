import {
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
} from "@crewon/domain";
import { uiRecord } from "./plugin-ui-application-support.ts";
import type {
  PluginProjectSourceUploadActionAuthorizationPort,
  PluginProjectSourceUploadActionPublication,
} from "./plugin-project-source-upload-action-owner.ts";

export function captureSourceUploadPublications(
  input: unknown,
): readonly PluginProjectSourceUploadActionPublication[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length < 1 ||
    input.length > 32 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    throw new Error("plugin_project_source_upload_publications_invalid");
  const seen = new Set<string>();
  return Object.freeze(
    Array.from({ length: input.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error("plugin_project_source_upload_publications_invalid");
      const value = uiRecord(descriptor.value, [
        "pluginId",
        "packageDigest",
        "contributionId",
      ]);
      const result = Object.freeze({
        pluginId: pluginInstallationNamespaceId(value.pluginId),
        packageDigest: pluginInstallationDigest(value.packageDigest),
        contributionId: pluginInstallationNamespaceId(value.contributionId),
      });
      const key = JSON.stringify(result);
      if (seen.has(key))
        throw new Error("plugin_project_source_upload_publication_duplicate");
      seen.add(key);
      return result;
    }),
  );
}
export function captureSourceUploadAuthorization(
  input: unknown,
): PluginProjectSourceUploadActionAuthorizationPort["authorize"] {
  return captureAuthorizationMethod(input, "authorize", true)!;
}
export function captureSourceUploadPartAuthorization(
  input: unknown,
): PluginProjectSourceUploadActionAuthorizationPort["authorizePart"] {
  return captureAuthorizationMethod(
    input,
    "authorizePart",
    false,
  ) as PluginProjectSourceUploadActionAuthorizationPort["authorizePart"];
}
function captureAuthorizationMethod(
  input: unknown,
  method: "authorize" | "authorizePart",
  required: boolean,
): PluginProjectSourceUploadActionAuthorizationPort["authorize"] | undefined {
  if (input === null || typeof input !== "object")
    throw new Error("plugin_project_source_upload_authorization_invalid");
  let target: object | null = input;
  for (
    let depth = 0;
    target !== null && depth < 16;
    depth++, target = Object.getPrototypeOf(target)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(target, method);
    if (descriptor === undefined) continue;
    if (
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      throw new Error("plugin_project_source_upload_authorization_invalid");
    return descriptor.value.bind(
      input,
    ) as PluginProjectSourceUploadActionAuthorizationPort["authorize"];
  }
  if (!required) return undefined;
  throw new Error("plugin_project_source_upload_authorization_invalid");
}
