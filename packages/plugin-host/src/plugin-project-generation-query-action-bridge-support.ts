import {
  CREWON_PROJECT_GENERATION_QUERIES_API_VERSION,
  CREWON_PROJECT_GENERATION_QUERIES_SERVICE,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import type { PluginUiActionContext } from "@crewon/application";
import type { PluginTaskAdmissionPin } from "@crewon/domain";
import {
  bridgeFailure,
  bridgeFields,
} from "./plugin-task-action-bridge-support.ts";

export function assertPluginProjectGenerationQuerySource(
  context: PluginUiActionContext,
  pin: PluginTaskAdmissionPin,
): void {
  if (
    !context.lease.descriptor.requires.some(
      (requirement) =>
        requirement.service === CREWON_PROJECT_GENERATION_QUERIES_SERVICE &&
        requirement.apiVersion ===
          CREWON_PROJECT_GENERATION_QUERIES_API_VERSION,
    ) ||
    !context.lease.descriptor.contributions.some(
      (contribution) =>
        contribution.id === pin.contributionId &&
        contribution.kind === "module" &&
        contribution.slot === "main.content",
    )
  )
    bridgeFailure("plugin_project_generation_query_source_unsupported");
}

/** Check the exact action on the actual execution package's service; never invent a target UI lease. */
export function assertPluginProjectGenerationQueryActionDeclaration(
  service: unknown,
  descriptor: PluginPackageDescriptor,
  target: Readonly<{ contributionId: string; action: string }>,
): void {
  const fields = bridgeFields(service, ["actions", "invoke"]);
  if (typeof fields.invoke !== "function")
    bridgeFailure("plugin_action_service_invalid");
  const declarations = fields.actions;
  if (
    !Array.isArray(declarations) ||
    Object.getPrototypeOf(declarations) !== Array.prototype
  )
    bridgeFailure("plugin_action_declarations_invalid");
  const length = Object.getOwnPropertyDescriptor(declarations, "length")?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 64 ||
    Reflect.ownKeys(declarations).length !== length + 1
  )
    bridgeFailure("plugin_action_declarations_invalid");
  const keys = new Set<string>();
  let found = false;
  for (let index = 0; index < length; index++) {
    const item = Object.getOwnPropertyDescriptor(declarations, String(index));
    if (!item?.enumerable || !Object.hasOwn(item, "value"))
      bridgeFailure("plugin_action_declarations_invalid");
    const declaration = bridgeFields(item.value, [
      "contributionId",
      "action",
      "kind",
    ]);
    if (
      typeof declaration.contributionId !== "string" ||
      !/^[a-z][a-z0-9._-]{0,127}$/u.test(declaration.contributionId) ||
      typeof declaration.action !== "string" ||
      !/^[a-z][a-z0-9._-]{0,127}$/u.test(declaration.action) ||
      (declaration.kind !== "read" &&
        declaration.kind !== "generateTask" &&
        declaration.kind !== "queryTask") ||
      !descriptor.contributions.some(
        (item) => item.id === declaration.contributionId,
      )
    )
      bridgeFailure("plugin_action_declarations_invalid");
    const key = `${declaration.contributionId}:${declaration.action}`;
    if (keys.has(key)) bridgeFailure("plugin_action_declarations_invalid");
    keys.add(key);
    if (
      declaration.contributionId === target.contributionId &&
      declaration.action === target.action
    ) {
      if (declaration.kind !== "queryTask")
        bridgeFailure("plugin_project_generation_action_invalid");
      found = true;
    }
  }
  if (!found) bridgeFailure("plugin_action_not_declared");
}
