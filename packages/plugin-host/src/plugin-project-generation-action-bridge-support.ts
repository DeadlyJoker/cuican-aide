import {
  CREWON_PROJECT_GENERATIONS_API_VERSION,
  CREWON_PROJECT_GENERATIONS_SERVICE,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import type { PluginUiActionContext } from "@crewon/application";
import type { PluginTaskAdmissionPin } from "@crewon/domain";
import {
  bridgeFailure,
  bridgeFields,
} from "./plugin-task-action-bridge-support.ts";

export function assertPluginProjectGenerationSource(
  context: PluginUiActionContext,
  pin: PluginTaskAdmissionPin,
): void {
  if (
    !context.lease.descriptor.requires.some(
      (requirement) =>
        requirement.service === CREWON_PROJECT_GENERATIONS_SERVICE &&
        requirement.apiVersion === CREWON_PROJECT_GENERATIONS_API_VERSION,
    ) ||
    !context.lease.descriptor.contributions.some(
      (contribution) =>
        contribution.id === pin.contributionId &&
        contribution.kind === "module" &&
        contribution.slot === "main.content",
    )
  )
    bridgeFailure("plugin_project_generation_source_unsupported");
}

export function projectGenerationSynchronousAvailable(
  answer: unknown,
): boolean {
  if (answer === true) return true;
  if (
    (answer !== null && typeof answer === "object") ||
    typeof answer === "function"
  )
    try {
      Promise.prototype.then.call(
        answer,
        () => undefined,
        () => undefined,
      );
    } catch {
      // Thenable getters do not participate in a synchronous publication fence.
    }
  return false;
}

/** Capture a trusted adapter's receiver without executing a getter or accepting an unbounded prototype chain. */
export function projectGenerationBridgeMethod<
  T extends object,
  K extends keyof T,
>(owner: T, key: K): T[K] {
  if (owner === null || typeof owner !== "object")
    bridgeFailure("plugin_project_generation_adapter_invalid");
  for (
    let target: object | null = owner, depth = 0;
    target !== null && depth < 16;
    target = Object.getPrototypeOf(target), depth++
  ) {
    const field = Object.getOwnPropertyDescriptor(target, key);
    if (field === undefined) continue;
    if (!Object.hasOwn(field, "value") || typeof field.value !== "function")
      bridgeFailure("plugin_project_generation_adapter_invalid");
    return Function.prototype.bind.call(field.value, owner) as T[K];
  }
  bridgeFailure("plugin_project_generation_adapter_invalid");
}

/** Check the exact action on the actual execution package's service; never invent a target UI lease. */
export function assertPluginProjectGenerationActionDeclaration(
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
      if (declaration.kind !== "generateTask")
        bridgeFailure("plugin_project_generation_action_invalid");
      found = true;
    }
  }
  if (!found) bridgeFailure("plugin_action_not_declared");
}
