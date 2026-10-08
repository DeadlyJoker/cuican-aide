import {
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
} from "@crewon/domain";
import { uiRecord } from "./plugin-ui-application-support.ts";
import type {
  PluginProjectFoundationActionPublication,
  PluginProjectFoundationActionAuthorizationPort,
} from "./plugin-project-foundation-action-owner.ts";
export function captureFoundationPublications(
  input: unknown,
): readonly PluginProjectFoundationActionPublication[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length < 1 ||
    input.length > 32 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    throw new Error("plugin_project_foundation_publications_invalid");
  const seen = new Set<string>();
  return Object.freeze(
    Array.from({ length: input.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error("plugin_project_foundation_publications_invalid");
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
        throw new Error("plugin_project_foundation_publication_duplicate");
      seen.add(key);
      return result;
    }),
  );
}
export function captureFoundationAuthorization(
  input: unknown,
): PluginProjectFoundationActionAuthorizationPort["authorize"] {
  return captureAuthorizationMethod(input, "authorize", true)!;
}
export function captureFoundationActiveAuthorization(
  input: unknown,
): PluginProjectFoundationActionAuthorizationPort["assertActive"] {
  return captureAuthorizationMethod(
    input,
    "assertActive",
    false,
  ) as PluginProjectFoundationActionAuthorizationPort["assertActive"];
}
function captureAuthorizationMethod(
  input: unknown,
  method: "authorize" | "assertActive",
  required: boolean,
): PluginProjectFoundationActionAuthorizationPort["authorize"] | undefined {
  if (input === null || typeof input !== "object")
    throw new Error("plugin_project_foundation_authorization_invalid");
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
      throw new Error("plugin_project_foundation_authorization_invalid");
    return descriptor.value.bind(
      input,
    ) as PluginProjectFoundationActionAuthorizationPort["authorize"];
  }
  if (!required) return undefined;
  throw new Error("plugin_project_foundation_authorization_invalid");
}
