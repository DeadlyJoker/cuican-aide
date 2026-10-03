import {
  ApplicationError,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION,
  CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE,
  parsePluginUiLease,
  parseProjectGenerationContextUiActionRequest,
} from "@crewon/contracts/plugins";
import {
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  pluginInstallationOpaqueId,
} from "@crewon/domain";
import {
  bridgeFields,
  bridgePin,
} from "./plugin-task-action-bridge-support.ts";

export function contextBridgeFailure(
  code = "plugin_project_generation_context_unavailable",
): never {
  throw new ApplicationError("authorization", code);
}

/** Capture only after proving membership in the actual registered invocation. */
export function captureProjectGenerationContext(input: PluginUiActionContext) {
  const fields = bridgeFields(input, [
    "actor",
    "scope",
    "selection",
    "package",
    "lease",
    "authorityEpoch",
    "action",
    "input",
  ]);
  const rawActor = bridgeFields(fields.actor, [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
  ]);
  const actor = Object.freeze({
    principalId: pluginInstallationOpaqueId(rawActor.principalId),
    actorId: pluginInstallationOpaqueId(rawActor.actorId),
    tenantId: pluginInstallationOpaqueId(rawActor.tenantId),
    spaceId: pluginInstallationOpaqueId(rawActor.spaceId),
  });
  const scope = parsePluginProfileScope(fields.scope);
  const selection = parsePluginSelection(fields.selection);
  const pkg = parseInstalledPluginPackage(fields.package);
  const lease = parsePluginUiLease(fields.lease);
  const request = parseProjectGenerationContextUiActionRequest({
    action: fields.action,
    input: fields.input,
  });
  if (
    typeof fields.authorityEpoch !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(fields.authorityEpoch) ||
    !lease.descriptor.requires.some(
      (item) =>
        item.service === CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE &&
        item.apiVersion === CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION,
    ) ||
    !lease.descriptor.contributions.some(
      (item) =>
        item.id === lease.contributionId &&
        item.kind === "module" &&
        item.slot === "main.content",
    )
  )
    contextBridgeFailure("plugin_project_generation_context_invalid");
  const context = Object.freeze({
    actor,
    scope,
    selection,
    package: pkg,
    lease,
    authorityEpoch: fields.authorityEpoch,
    action: request.action,
    input: request.input,
  });
  // Reuse the original pin validation with this read action; never impersonate generateConcept.
  const sourcePin = bridgePin(context);
  return Object.freeze({
    context,
    request,
    sourcePin,
    fingerprint: JSON.stringify(context),
  });
}

/** Capture the trusted receiver without getters or an unbounded prototype walk. */
export function contextBridgeMethod<T extends object, K extends keyof T>(
  owner: T,
  key: K,
): T[K] {
  if (owner === null || typeof owner !== "object")
    contextBridgeFailure("plugin_project_generation_context_adapter_invalid");
  for (
    let target: object | null = owner, depth = 0;
    target !== null && depth < 16;
    target = Object.getPrototypeOf(target), depth++
  ) {
    const field = Object.getOwnPropertyDescriptor(target, key);
    if (field === undefined) continue;
    if (!Object.hasOwn(field, "value") || typeof field.value !== "function")
      contextBridgeFailure("plugin_project_generation_context_adapter_invalid");
    return Function.prototype.bind.call(field.value, owner) as T[K];
  }
  contextBridgeFailure("plugin_project_generation_context_adapter_invalid");
}
