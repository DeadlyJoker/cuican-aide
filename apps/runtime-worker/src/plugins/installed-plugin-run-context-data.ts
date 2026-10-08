import { createHash } from "node:crypto";
import type { CommitExtensionTurnResult } from "@crewon/application";
import {
  assertPluginTaskFunding,
  extensionCanonicalJson,
  parseExtensionRunBinding,
  reduceRunLifecycleEvent,
  type ExtensionRunBinding,
  type PluginTaskAdmission,
  type PluginQueryTaskAdmission,
  type RunState,
} from "@crewon/domain";

const digester = {
  sha256: (input: string) =>
    `sha256:${createHash("sha256").update(input).digest("hex")}`,
};

export function validateReceipt(
  input: CommitExtensionTurnResult,
  binding: ExtensionRunBinding,
  admission: PluginTaskAdmission,
  receipt: { actorId: string; idempotencyKey: string; requestDigest: string },
  query: PluginQueryTaskAdmission | null,
  fail: (code: string) => never,
): RunState {
  // The same bounded, accessor-free Domain JSON capture used by v0 config/binding parsing.
  const saved = JSON.parse(
    extensionCanonicalJson(input),
  ) as CommitExtensionTurnResult;
  if (
    saved.schemaVersion !== "crewon.extension-turn-admission.v0" ||
    !saved.turn ||
    !saved.run ||
    saved.run.events.length !== 1 ||
    saved.run.events[0]?.type !== "run.created"
  )
    fail("installed_plugin_task_receipt_invalid");
  if (
    extensionCanonicalJson(
      parseExtensionRunBinding(saved.binding, digester),
    ) !== extensionCanonicalJson(binding)
  )
    fail("installed_plugin_task_receipt_mismatch");
  const original = reduceRunLifecycleEvent(null, saved.run.events[0]);
  assertRun(original, binding, original, fail);
  if (
    extensionCanonicalJson(original) !==
      extensionCanonicalJson(saved.run.state) ||
    extensionCanonicalJson(original) !==
      extensionCanonicalJson(saved.turn.runState) ||
    extensionCanonicalJson(saved.run.events) !==
      extensionCanonicalJson(saved.turn.runEvents)
  )
    fail("installed_plugin_task_receipt_mismatch");
  if (query === null)
    assertPluginTaskFunding(
      {
        ...(saved.creditAdmission === undefined
          ? {}
          : { creditAdmission: saved.creditAdmission }),
        ...(saved.unmeteredAdmission === undefined
          ? {}
          : { unmeteredAdmission: saved.unmeteredAdmission }),
        binding,
        receipt,
        principalId: admission.principalId,
        task: admission,
      },
      digester,
    );
  else if (
    saved.creditAdmission !== undefined ||
    saved.unmeteredAdmission !== undefined
  )
    fail("installed_plugin_task_receipt_owner_mismatch");
  const messages = saved.turn.messages;
  if (
    messages.length !== 1 ||
    messages[0]?.tenantId !== binding.tenantId ||
    messages[0]?.threadId !== binding.threadId ||
    messages[0]?.role !== "user" ||
    messages[0].contentDigest !== binding.inputDigest ||
    digester.sha256(messages[0].content) !== binding.inputDigest ||
    saved.turn.threadState.tenantId !== binding.tenantId ||
    saved.turn.threadState.spaceId !== binding.spaceId ||
    saved.turn.threadState.threadId !== binding.threadId
  )
    fail("installed_plugin_task_receipt_mismatch");
  return original;
}

export function assertRun(
  input: RunState,
  binding: ExtensionRunBinding,
  original: RunState,
  fail: (code: string) => never,
): void {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    fail("installed_plugin_run_authority_mismatch");
  const expected = {
    tenantId: binding.tenantId,
    spaceId: binding.spaceId,
    runId: binding.runId,
    threadId: binding.threadId,
    createdByActorId: binding.actorId,
    agentVersionId: binding.target.agentVersionId,
    authorityId: binding.target.authorityId,
    runtimeGeneration: binding.target.runtimeGeneration,
    policySnapshotId: binding.target.policySnapshotId,
    workspaceBindingId: binding.target.workspaceBindingId,
    origin: null,
    goalBinding: null,
    collaborationMode: original.collaborationMode,
    createdAt: original.createdAt,
  };
  for (const [field, value] of Object.entries(expected)) {
    const item = Object.getOwnPropertyDescriptor(input, field);
    if (
      !item?.enumerable ||
      !Object.hasOwn(item, "value") ||
      item.value !== value
    )
      fail("installed_plugin_run_authority_mismatch");
  }
  for (const field of [
    "purpose",
    "workflowVersionBinding",
    "toolPermissionMode",
    "goalContinuationMode",
  ] as const) {
    const item = Object.getOwnPropertyDescriptor(input, field);
    const reference = Object.getOwnPropertyDescriptor(original, field);
    // Original Turn admission still omits purpose. Preserve that exact immutable shape,
    // with the Domain's default-turn meaning, rather than fabricating a new snapshot field.
    if (
      field === "purpose" &&
      reference !== undefined &&
      reference.value !== "turn"
    )
      fail("installed_plugin_run_authority_mismatch");
    if (field === "workflowVersionBinding" && reference !== undefined)
      fail("installed_plugin_run_authority_mismatch");
    if (
      (item === undefined) !== (reference === undefined) ||
      (item !== undefined &&
        (!item.enumerable ||
          !Object.hasOwn(item, "value") ||
          item.value !== reference?.value))
    )
      fail("installed_plugin_run_authority_mismatch");
  }
}
