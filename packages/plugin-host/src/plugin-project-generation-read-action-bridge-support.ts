import {
  ApplicationError,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  CREWON_PROJECT_GENERATION_READS_API_VERSION,
  CREWON_PROJECT_GENERATION_READS_SERVICE,
  parsePluginUiLease,
  parseProjectGenerationReadUiActionRequest,
} from "@crewon/contracts/plugins";
import {
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  pluginInstallationOpaqueId,
} from "@crewon/domain";
import { bridgeFields } from "./plugin-task-action-bridge-support.ts";

export type PluginProjectGenerationReadPublication = Readonly<{
  pluginId: string;
  packageDigest: string;
  contributionId: string;
}>;

export function readBridgeFailure(
  code = "plugin_project_generation_read_unavailable",
): never {
  throw new ApplicationError("authorization", code);
}

export function captureProjectGenerationReadPublications(
  input: unknown,
): readonly PluginProjectGenerationReadPublication[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length < 1 ||
    input.length > 32 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    readBridgeFailure("plugin_project_generation_read_publications_invalid");
  const seen = new Set<string>();
  return Object.freeze(
    Array.from({ length: input.length }, (_, index) => {
      const property = Object.getOwnPropertyDescriptor(input, String(index));
      if (!property?.enumerable || !Object.hasOwn(property, "value"))
        readBridgeFailure(
          "plugin_project_generation_read_publications_invalid",
        );
      const fields = bridgeFields(property.value, [
        "pluginId",
        "packageDigest",
        "contributionId",
      ]);
      const publication = Object.freeze({
        pluginId: pluginInstallationNamespaceId(fields.pluginId),
        packageDigest: pluginInstallationDigest(fields.packageDigest),
        contributionId: pluginInstallationNamespaceId(fields.contributionId),
      });
      const identity = JSON.stringify(publication);
      if (seen.has(identity))
        readBridgeFailure(
          "plugin_project_generation_read_publication_duplicate",
        );
      seen.add(identity);
      return publication;
    }),
  );
}

/** Actual invocation membership is checked before this detached source snapshot is read. */
export function captureProjectGenerationReadContext(
  input: PluginUiActionContext,
) {
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
  const selected = parsePluginSelection(fields.selection);
  const pkg = parseInstalledPluginPackage(fields.package);
  const lease = parsePluginUiLease(fields.lease);
  const request = parseProjectGenerationReadUiActionRequest({
    action: fields.action,
    input: fields.input,
  });
  if (
    typeof fields.authorityEpoch !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(fields.authorityEpoch) ||
    scope.tenantId !== actor.tenantId ||
    scope.spaceId !== actor.spaceId ||
    selected.state !== "enabled" ||
    selected.revision !== lease.selectionRevision ||
    pkg.packageDigest !== lease.packageDigest ||
    selected.selectedPackageDigest !== pkg.packageDigest ||
    selected.pluginId !== pkg.pluginId ||
    selected.publisherId !== pkg.publisherId ||
    pkg.pluginId !== lease.descriptor.pluginId ||
    pkg.publisherId !== lease.descriptor.publisherId ||
    pkg.version !== lease.descriptor.version ||
    ["tenantId", "spaceId", "profileId"].some(
      (key) =>
        selected[key as keyof typeof scope] !==
          scope[key as keyof typeof scope] ||
        pkg[key as keyof typeof scope] !== scope[key as keyof typeof scope],
    ) ||
    !lease.descriptor.requires.some(
      (item) =>
        item.service === CREWON_PROJECT_GENERATION_READS_SERVICE &&
        item.apiVersion === CREWON_PROJECT_GENERATION_READS_API_VERSION,
    ) ||
    !lease.descriptor.contributions.some(
      (item) =>
        item.id === lease.contributionId &&
        item.kind === "module" &&
        item.slot === "main.content",
    )
  )
    readBridgeFailure("plugin_project_generation_read_context_invalid");
  const context = Object.freeze({
    actor,
    scope,
    selection: selected,
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

/** Bind once without evaluating accessors or walking an unbounded prototype chain. */
export function readBridgeMethod<T extends object, K extends keyof T>(
  owner: T,
  key: K,
): T[K] {
  if (owner === null || typeof owner !== "object")
    readBridgeFailure("plugin_project_generation_read_adapter_invalid");
  for (
    let target: object | null = owner, depth = 0;
    target !== null && depth < 16;
    target = Object.getPrototypeOf(target), depth++
  ) {
    const field = Object.getOwnPropertyDescriptor(target, key);
    if (field === undefined) continue;
    if (!Object.hasOwn(field, "value") || typeof field.value !== "function")
      readBridgeFailure("plugin_project_generation_read_adapter_invalid");
    return Function.prototype.bind.call(field.value, owner) as T[K];
  }
  readBridgeFailure("plugin_project_generation_read_adapter_invalid");
}
