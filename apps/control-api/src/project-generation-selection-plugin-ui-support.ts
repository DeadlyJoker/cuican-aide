import {
  ApplicationError,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION,
  CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE,
  parsePluginUiLease,
  parseProjectGenerationSelectionUiActionRequest,
} from "@crewon/contracts/plugins";
import {
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
} from "@crewon/domain";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";

export function selectionUiSnapshot(input: PluginUiActionContext) {
  const fields = pluginSecurityRecord(input, [
    "actor",
    "scope",
    "selection",
    "package",
    "lease",
    "authorityEpoch",
    "action",
    "input",
  ]);
  const actor = pluginSecurityActor(fields.actor);
  const scope = parsePluginProfileScope(fields.scope);
  const selection = parsePluginSelection(fields.selection);
  const pkg = parseInstalledPluginPackage(fields.package);
  const lease = parsePluginUiLease(fields.lease);
  const request = parseProjectGenerationSelectionUiActionRequest({
    action: fields.action,
    input: fields.input,
  });
  if (
    typeof fields.authorityEpoch !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(fields.authorityEpoch) ||
    scope.tenantId !== actor.tenantId ||
    scope.spaceId !== actor.spaceId ||
    selection.state !== "enabled" ||
    selection.revision !== lease.selectionRevision ||
    selection.selectedPackageDigest !== pkg.packageDigest ||
    pkg.packageDigest !== lease.packageDigest ||
    selection.pluginId !== pkg.pluginId ||
    selection.publisherId !== pkg.publisherId ||
    pkg.pluginId !== lease.descriptor.pluginId ||
    pkg.publisherId !== lease.descriptor.publisherId ||
    pkg.version !== lease.descriptor.version ||
    ["tenantId", "spaceId", "profileId"].some(
      (key) =>
        selection[key as keyof typeof scope] !==
          scope[key as keyof typeof scope] ||
        pkg[key as keyof typeof scope] !== scope[key as keyof typeof scope],
    ) ||
    !lease.descriptor.requires.some(
      (item) =>
        item.service === CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE &&
        item.apiVersion === CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION,
    ) ||
    !lease.descriptor.contributions.some(
      (item) =>
        item.id === lease.contributionId &&
        item.kind === "module" &&
        item.slot === "main.content",
    )
  )
    selectionUiUnavailable();
  const context: PluginUiActionContext = Object.freeze({
    actor,
    scope,
    selection,
    package: pkg,
    lease,
    authorityEpoch: fields.authorityEpoch,
    action: request.action,
    input: request.input,
  });
  return Object.freeze({
    context,
    request,
    fingerprint: JSON.stringify(context),
  });
}

export function selectionUiMethod<T extends object, K extends keyof T>(
  owner: T,
  key: K,
): T[K] {
  if (owner === null || typeof owner !== "object") selectionUiUnavailable();
  for (
    let target: object | null = owner, depth = 0;
    target !== null && depth < 16;
    target = Object.getPrototypeOf(target), depth++
  ) {
    const field = Object.getOwnPropertyDescriptor(target, key);
    if (field === undefined) continue;
    if (!Object.hasOwn(field, "value") || typeof field.value !== "function")
      selectionUiUnavailable();
    return Function.prototype.bind.call(field.value, owner) as T[K];
  }
  selectionUiUnavailable();
}

export function selectionUiUnavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_generation_selection_unavailable",
  );
}
