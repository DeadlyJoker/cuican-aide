import { parsePluginUiJsonValue } from "@crewon/contracts/plugins";
import {
  assertExtensionCreditAdmission,
  extensionCanonicalJson,
  extensionOpaqueId,
  extensionTimestamp,
  parseExtensionRunBinding,
  parsePluginTaskAdmissionPin,
  reduceRunLifecycleEvent,
  type PluginTaskAdmissionPin,
  type ExtensionCreditAdmission,
  type RunState,
  type PluginQueryTaskAdmission,
} from "@crewon/domain";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import type {
  CommitExtensionTurnResult,
  ExtensionMutationReceipt,
} from "./extension-store-port.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
import {
  uiActor,
  uiEpoch,
  uiInvokeCommand,
  uiPackage,
  uiProfile,
  uiPublicLease,
  uiRecord,
  uiSelection,
} from "./plugin-ui-application-support.ts";

/** Snapshot only the already captured invocation; no current authority or selection is consulted. */
export function committedTaskContext(input: PluginUiActionContext) {
  const value = uiRecord(input, [
    "actor",
    "scope",
    "selection",
    "package",
    "lease",
    "authorityEpoch",
    "action",
    "input",
  ]);
  const actor = uiActor(value.actor as PluginUiActionContext["actor"]);
  const scope = uiProfile(value.scope, actor);
  const lease = uiPublicLease(value.lease);
  const selection = uiSelection(
    value.selection,
    scope,
    lease.descriptor.pluginId,
  );
  const pkg = uiPackage(value.package, scope, selection);
  const command = uiInvokeCommand({
    mountRef: lease.mountRef,
    action: value.action,
    input: value.input,
  });
  const authorityEpoch = uiEpoch(value.authorityEpoch);
  if (
    selection.state !== "enabled" ||
    selection.revision !== lease.selectionRevision ||
    pkg.packageDigest !== lease.packageDigest ||
    pkg.version !== lease.descriptor.version ||
    pkg.publisherId !== lease.descriptor.publisherId
  )
    throw new Error("plugin_ui_committed_context_invalid");
  const context: PluginUiActionContext = Object.freeze({
    actor,
    scope,
    selection,
    package: pkg,
    lease,
    authorityEpoch,
    action: command.action,
    input: command.input,
  });
  const pin = parsePluginTaskAdmissionPin({
    ...actor,
    profileId: scope.profileId,
    pluginId: pkg.pluginId,
    publisherId: pkg.publisherId,
    version: pkg.version,
    packageDigest: pkg.packageDigest,
    selectionRevision: selection.revision,
    contributionId: lease.contributionId,
    action: command.action,
    authorityEpoch,
  });
  // The authoritative lease/JSON parsers bound this snapshot, including the descriptor inventory.
  return Object.freeze({ context, pin, fingerprint: JSON.stringify(context) });
}

export function committedTaskCommand(
  input: CreateExtensionTaskCommand,
  pin: PluginTaskAdmissionPin,
): CreateExtensionTaskCommand {
  const value = uiRecord(input, [
    "pluginId",
    "threadId",
    "expectedThreadRevision",
    "idempotencyKey",
    "intent",
  ]);
  const intent = uiRecord(value.intent, ["kind", "input"]);
  if (
    value.pluginId !== pin.pluginId ||
    intent.kind !== "generate" ||
    typeof value.expectedThreadRevision !== "number" ||
    !Number.isSafeInteger(value.expectedThreadRevision) ||
    value.expectedThreadRevision < 1 ||
    value.expectedThreadRevision >= Number.MAX_SAFE_INTEGER
  )
    throw new Error("plugin_ui_committed_command_invalid");
  const parameters = parsePluginUiJsonValue(intent.input, {
    maxBytes: 16 * 1024,
  });
  return Object.freeze({
    pluginId: pin.pluginId,
    threadId: extensionOpaqueId(value.threadId),
    expectedThreadRevision: value.expectedThreadRevision,
    idempotencyKey: extensionOpaqueId(value.idempotencyKey),
    intent: Object.freeze({ kind: "generate", input: parameters }),
  });
}

export function committedQueryTaskCommand(
  input: CreateExtensionTaskCommand,
  pin: PluginTaskAdmissionPin,
): CreateExtensionTaskCommand {
  const value = uiRecord(input, [
      "pluginId",
      "threadId",
      "expectedThreadRevision",
      "idempotencyKey",
      "intent",
    ]),
    intent = uiRecord(value.intent, ["kind", "sourceRunId", "operationId"]);
  const operationId = extensionOpaqueId(intent.operationId);
  if (
    value.pluginId !== pin.pluginId ||
    intent.kind !== "query" ||
    typeof value.expectedThreadRevision !== "number" ||
    !Number.isSafeInteger(value.expectedThreadRevision) ||
    value.expectedThreadRevision < 1 ||
    value.expectedThreadRevision >= Number.MAX_SAFE_INTEGER ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      operationId,
    )
  )
    throw new Error("plugin_ui_committed_command_invalid");
  return Object.freeze({
    pluginId: pin.pluginId,
    threadId: extensionOpaqueId(value.threadId),
    expectedThreadRevision: value.expectedThreadRevision,
    idempotencyKey: extensionOpaqueId(value.idempotencyKey),
    intent: Object.freeze({
      kind: "query",
      sourceRunId: extensionOpaqueId(intent.sourceRunId),
      operationId,
    }),
  });
}

/** Bounded detached snapshot of the original transaction result, not a later task/history read. */
export function committedTaskResult(
  input: CommitExtensionTurnResult,
  command: CreateExtensionTaskCommand,
  pin: PluginTaskAdmissionPin,
  receipt: ExtensionMutationReceipt,
  digester: ContentDigester,
  query?: PluginQueryTaskAdmission,
) {
  const copied = parsePluginUiJsonValue(input);
  const value = uiRecord(
    copied,
    query === undefined
      ? ["schemaVersion", "turn", "run", "binding", "creditAdmission"]
      : ["schemaVersion", "turn", "run", "binding"],
  );
  const turn = uiRecord(value.turn, [
    "disposition",
    "threadState",
    "runState",
    "goalState",
    "threadEvents",
    "messages",
    "historyItems",
    "runEvents",
    "outbox",
    "workItems",
  ]);
  const run = uiRecord(value.run, [
    "disposition",
    "state",
    "events",
    "outbox",
    "workItems",
  ]);
  if (
    value.schemaVersion !== "crewon.extension-turn-admission.v0" ||
    (turn.disposition !== "committed" && turn.disposition !== "replayed") ||
    run.disposition !== turn.disposition
  )
    throw new Error("plugin_ui_committed_receipt_invalid");
  const binding = parseExtensionRunBinding(value.binding, digester);
  const credit =
    query === undefined
      ? assertExtensionCreditAdmission(
          {
            admission: value.creditAdmission as ExtensionCreditAdmission,
            binding,
            receipt,
          },
          digester,
        )
      : undefined;
  if (
    (query === undefined
      ? binding.source !== null
      : binding.source === null ||
        command.intent.kind !== "query" ||
        binding.source.runId !== command.intent.sourceRunId ||
        binding.source.operationId !== command.intent.operationId ||
        query.extensionBindingDigest !== binding.bindingDigest) ||
    binding.pluginId !== command.pluginId ||
    binding.threadId !== command.threadId ||
    binding.tenantId !== pin.tenantId ||
    binding.spaceId !== pin.spaceId ||
    binding.actorId !== pin.actorId ||
    (credit !== undefined &&
      credit.reservation.scope.principalId !== pin.principalId)
  )
    throw new Error("plugin_ui_committed_receipt_identity_invalid");
  const result = copied as unknown as CommitExtensionTurnResult;
  if (
    result.run.events.length !== 1 ||
    result.run.events[0]?.type !== "run.created"
  )
    throw new Error("plugin_ui_committed_run_invalid");
  const reduced = reduceRunLifecycleEvent(null, result.run.events[0]);
  assertCommittedRun(reduced, binding);
  if (
    extensionCanonicalJson(reduced) !==
      extensionCanonicalJson(result.run.state) ||
    extensionCanonicalJson(result.turn.runState) !==
      extensionCanonicalJson(result.run.state) ||
    extensionCanonicalJson(result.turn.runEvents) !==
      extensionCanonicalJson(result.run.events) ||
    extensionCanonicalJson(result.turn.outbox) !==
      extensionCanonicalJson(result.run.outbox) ||
    extensionCanonicalJson(result.turn.workItems) !==
      extensionCanonicalJson(result.run.workItems)
  )
    throw new Error("plugin_ui_committed_run_snapshot_invalid");
  const messages = result.turn.messages;
  if (
    messages.length !== 1 ||
    result.turn.threadEvents.length !== 1 ||
    result.turn.historyItems.length !== 1
  )
    throw new Error("plugin_ui_committed_message_invalid");
  const message = uiRecord(messages[0], [
    "messageId",
    "tenantId",
    "threadId",
    "sequence",
    "role",
    "content",
    "contentDigest",
    "createdAt",
    "origin",
    "proposedPlan",
  ]);
  const content = extensionCanonicalJson(
    command.intent.kind === "generate"
      ? command.intent.input
      : { kind: "query", operationId: command.intent.operationId },
  );
  const event = result.turn.threadEvents[0]!;
  const history = result.turn.historyItems[0]!;
  if (
    result.turn.threadState.tenantId !== pin.tenantId ||
    result.turn.threadState.spaceId !== pin.spaceId ||
    result.turn.threadState.threadId !== command.threadId ||
    result.turn.threadState.revision !== command.expectedThreadRevision + 1 ||
    message.tenantId !== pin.tenantId ||
    message.threadId !== command.threadId ||
    message.role !== "user" ||
    message.content !== content ||
    message.contentDigest !== digester.sha256(content) ||
    binding.inputDigest !== message.contentDigest ||
    message.origin !== null ||
    message.proposedPlan !== null ||
    message.sequence !== result.turn.threadState.lastMessageSequence ||
    event.type !== "thread.message.appended" ||
    event.identity.threadId !== command.threadId ||
    event.data.messageId !== message.messageId ||
    event.data.contentDigest !== message.contentDigest ||
    event.data.messageSequence !== message.sequence ||
    event.data.role !== "user" ||
    event.sequence !== result.turn.threadState.lastEventSequence ||
    event.occurredAt !== message.createdAt ||
    history.type !== "message" ||
    history.role !== "user" ||
    history.source !== "thread_message" ||
    history.tenantId !== pin.tenantId ||
    history.threadId !== command.threadId ||
    history.content !== content ||
    history.contentDigest !== message.contentDigest
  )
    throw new Error("plugin_ui_committed_message_identity_invalid");
  extensionOpaqueId(message.messageId);
  extensionTimestamp(message.createdAt);
  const fingerprint = extensionCanonicalJson({
    ...result,
    turn: { ...result.turn, disposition: "committed" },
    run: { ...result.run, disposition: "committed" },
  });
  return Object.freeze({ result, binding, fingerprint });
}

/** The Worker may already have advanced status. Only immutable Run authority is checked here. */
export function assertCommittedRun(
  input: RunState,
  binding: CommitExtensionTurnResult["binding"],
): void {
  const expected = {
    runId: binding.runId,
    threadId: binding.threadId,
    tenantId: binding.tenantId,
    spaceId: binding.spaceId,
    createdByActorId: binding.actorId,
    authorityId: binding.target.authorityId,
    runtimeGeneration: binding.target.runtimeGeneration,
    agentVersionId: binding.target.agentVersionId,
    policySnapshotId: binding.target.policySnapshotId,
    workspaceBindingId: binding.target.workspaceBindingId,
    goalBinding: null,
  };
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("plugin_ui_committed_run_unavailable");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("plugin_ui_committed_run_invalid");
  for (const [field, value] of Object.entries(expected)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.value !== value
    )
      throw new Error("plugin_ui_committed_run_identity_invalid");
  }
  const purpose = Object.getOwnPropertyDescriptor(input, "purpose");
  if (
    purpose !== undefined &&
    (!purpose.enumerable ||
      !Object.hasOwn(purpose, "value") ||
      purpose.value !== "turn")
  )
    throw new Error("plugin_ui_committed_run_identity_invalid");
}

export function committedTaskProjection(result: CommitExtensionTurnResult) {
  return parsePluginUiJsonValue({
    disposition: result.turn.disposition,
    threadId: result.binding.threadId,
    threadRevision: result.turn.threadState.revision,
    runId: result.binding.runId,
    messageId: result.turn.messages[0]!.messageId,
    configurationRevision: result.binding.configurationRevision,
  });
}
