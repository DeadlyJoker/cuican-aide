import {
  parsePluginUiJsonValue,
  parsePluginUiLease,
  type PluginUiJsonValue,
} from "@crewon/contracts/plugins";
import {
  extensionOpaqueId,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
  type PluginTaskAdmissionPin,
  type PluginSelection,
} from "@crewon/domain";
import {
  ApplicationError,
  type CommitExtensionTurnResult,
  type PluginUiActionContext,
} from "@crewon/application";
import type {
  PluginActionDeclaration,
  PluginTaskRequest,
} from "@crewon/plugin-sdk/node";

export function bridgeFailure(code: string): never {
  throw new ApplicationError("authorization", code);
}

export function bridgeFields(input: unknown, keys: readonly string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    bridgeFailure("plugin_action_input_invalid");
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    bridgeFailure("plugin_action_input_invalid");
  const actual = Reflect.ownKeys(input);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key as string))
  )
    bridgeFailure("plugin_action_input_invalid");
  const fields: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable)
      bridgeFailure("plugin_action_input_invalid");
    fields[key] = field.value;
  }
  return fields;
}

export function bridgePin(
  context: PluginUiActionContext,
): PluginTaskAdmissionPin {
  const scope = parsePluginProfileScope(context.scope);
  const selected = parsePluginSelection(context.selection);
  const installed = parseInstalledPluginPackage(context.package);
  const lease = parsePluginUiLease(context.lease);
  const pin = parsePluginTaskAdmissionPin({
    ...scope,
    actorId: context.actor.actorId,
    principalId: context.actor.principalId,
    pluginId: installed.pluginId,
    publisherId: installed.publisherId,
    version: installed.version,
    packageDigest: installed.packageDigest,
    selectionRevision: selected.revision,
    contributionId: lease.contributionId,
    action: context.action,
    authorityEpoch: context.authorityEpoch,
  });
  if (
    scope.tenantId !== context.actor.tenantId ||
    scope.spaceId !== context.actor.spaceId ||
    !bridgeSameSelection(selected, pin) ||
    ["tenantId", "spaceId", "profileId"].some(
      (key) =>
        installed[key as keyof typeof scope] !==
        scope[key as keyof typeof scope],
    ) ||
    installed.packageDigest !== lease.packageDigest ||
    selected.revision !== lease.selectionRevision ||
    installed.pluginId !== lease.descriptor.pluginId ||
    installed.publisherId !== lease.descriptor.publisherId ||
    installed.version !== lease.descriptor.version
  )
    bridgeFailure("plugin_action_context_mismatch");
  return pin;
}

export function bridgeSameSelection(
  selected: PluginSelection | null,
  pin: PluginTaskAdmissionPin,
): boolean {
  return (
    selected !== null &&
    selected.state === "enabled" &&
    selected.tenantId === pin.tenantId &&
    selected.spaceId === pin.spaceId &&
    selected.profileId === pin.profileId &&
    selected.pluginId === pin.pluginId &&
    selected.publisherId === pin.publisherId &&
    selected.revision === pin.selectionRevision &&
    selected.selectedPackageDigest === pin.packageDigest
  );
}

export function bridgeAction(
  declarations: unknown,
  context: PluginUiActionContext,
): PluginActionDeclaration {
  if (
    !Array.isArray(declarations) ||
    Object.getPrototypeOf(declarations) !== Array.prototype
  )
    bridgeFailure("plugin_action_declarations_invalid");
  const length = Object.getOwnPropertyDescriptor(declarations, "length")
    ?.value as unknown;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 64
  )
    bridgeFailure("plugin_action_declarations_invalid");
  const keys = Reflect.ownKeys(declarations);
  if (
    keys.length !== length + 1 ||
    keys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= length),
    )
  )
    bridgeFailure("plugin_action_declarations_invalid");
  const captured: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const field = Object.getOwnPropertyDescriptor(declarations, String(index));
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable)
      bridgeFailure("plugin_action_declarations_invalid");
    captured.push(field.value);
  }
  const found = new Map<string, PluginActionDeclaration>();
  for (const raw of captured) {
    const fields = bridgeFields(raw, ["contributionId", "action", "kind"]);
    if (
      typeof fields.contributionId !== "string" ||
      !/^[a-z][a-z0-9._-]{0,127}$/u.test(fields.contributionId) ||
      typeof fields.action !== "string" ||
      !/^[a-z][a-z0-9._-]{0,127}$/u.test(fields.action) ||
      (fields.kind !== "read" && fields.kind !== "generateTask") ||
      !context.lease.descriptor.contributions.some(
        (item) => item.id === fields.contributionId,
      )
    )
      bridgeFailure("plugin_action_declarations_invalid");
    const key = `${fields.contributionId}:${fields.action}`;
    if (found.has(key)) bridgeFailure("plugin_action_declarations_invalid");
    found.set(
      key,
      Object.freeze({
        contributionId: fields.contributionId,
        action: fields.action,
        kind: fields.kind,
      }),
    );
  }
  const action = found.get(`${context.lease.contributionId}:${context.action}`);
  if (!action) bridgeFailure("plugin_action_not_declared");
  return action;
}

export function bridgeTaskRequest(input: unknown): PluginTaskRequest {
  const fields = bridgeFields(input, [
    "invocationRef",
    "threadId",
    "expectedThreadRevision",
    "idempotencyKey",
    "input",
  ]);
  if (
    typeof fields.invocationRef !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(fields.invocationRef) ||
    typeof fields.threadId !== "string" ||
    typeof fields.idempotencyKey !== "string" ||
    typeof fields.expectedThreadRevision !== "number" ||
    !Number.isSafeInteger(fields.expectedThreadRevision) ||
    fields.expectedThreadRevision < 1
  )
    bridgeFailure("plugin_task_request_invalid");
  let threadId: string;
  let idempotencyKey: string;
  try {
    threadId = extensionOpaqueId(fields.threadId);
    idempotencyKey = extensionOpaqueId(fields.idempotencyKey);
  } catch {
    bridgeFailure("plugin_task_request_invalid");
  }
  return Object.freeze({
    invocationRef: fields.invocationRef,
    threadId,
    idempotencyKey,
    expectedThreadRevision: fields.expectedThreadRevision,
    input: parsePluginUiJsonValue(fields.input),
  });
}

export function bridgeTaskOutput(
  result: CommitExtensionTurnResult,
): PluginUiJsonValue {
  const message = result.turn.messages[0];
  if (!message || result.turn.messages.length !== 1)
    bridgeFailure("plugin_task_receipt_invalid");
  return parsePluginUiJsonValue({
    disposition: result.turn.disposition,
    threadId: result.binding.threadId,
    threadRevision: result.turn.threadState.revision,
    runId: result.binding.runId,
    messageId: message.messageId,
    configurationRevision: result.binding.configurationRevision,
  });
}
