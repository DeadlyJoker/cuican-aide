import { captureProjectConversationAuthority } from "@crewon/application";
import type {
  CommitThreadInput,
  ProjectConversationCommitAuthority,
  ProjectConversationMutation,
  ProjectConversationOwner,
  ProjectConversationReceipt,
  ProjectConversationStore,
} from "@crewon/application";
import {
  assertProjectConversationBindingChange,
  creativeProjectOpaqueId,
  projectTextRecord,
  creativeProjectRevision,
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginSelection,
  parsePluginTaskAdmissionPin,
  parseProjectConversationBinding,
  parseProjectConversationInstallation,
  parseProjectStageRunAdmission,
  validateCreativeProjectActor,
  type ProjectConversationBinding,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";

export const bindingColumns =
  "tenant_id,space_id,principal_id,actor_id,profile_id,binding_id,project_id,thread_id,revision,state,record_json";
export const ownerWhere =
  "tenant_id=? AND space_id=? AND principal_id=? AND actor_id=? AND profile_id=?";
export function conversationFail(
  code = "project_conversation_store_result_invalid",
): never {
  throw new Error(code);
}
export function conversationOwner(input: unknown): ProjectConversationOwner {
  const v = projectTextRecord(input, ["actor", "profileId"]);
  return Object.freeze({
    actor: validateCreativeProjectActor(v.actor),
    profileId: creativeProjectOpaqueId(v.profileId),
  });
}
export function ownerValues(
  o: ProjectConversationOwner,
): [string, string, string, string, string] {
  return [
    o.actor.tenantId,
    o.actor.spaceId,
    o.actor.principalId,
    o.actor.actorId,
    o.profileId,
  ];
}
export function bindingOwner(
  b: ProjectConversationBinding,
): ProjectConversationOwner {
  return { actor: b.owner, profileId: b.profileId };
}
export function bindingValues(
  b: ProjectConversationBinding,
): readonly (string | number)[] {
  return [
    ...ownerValues(bindingOwner(b)),
    b.bindingId,
    b.projectId,
    b.threadId,
    b.revision,
    b.state,
    JSON.stringify(b),
  ];
}
export function conversationReceipt(
  input: unknown,
): ProjectConversationReceipt {
  const v = projectTextRecord(input, [
    "actor",
    "idempotencyKey",
    "requestDigest",
  ]);
  if (
    typeof v.requestDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(v.requestDigest)
  )
    conversationFail();
  return Object.freeze({
    actor: validateCreativeProjectActor(v.actor),
    idempotencyKey: creativeProjectOpaqueId(v.idempotencyKey),
    requestDigest: v.requestDigest,
  });
}
export function decodeConversation(
  row: Record<string, unknown> | undefined | null,
  owner?: ProjectConversationOwner,
): ProjectConversationBinding | null {
  if (row == null) return null;
  const b = parseProjectConversationBinding(
    json(row.record_json),
    creativeStoreDigester,
  );
  if (
    [
      ...ownerValues(bindingOwner(b)),
      b.bindingId,
      b.projectId,
      b.threadId,
      String(b.revision),
      b.state,
    ].some((v, i) => String(row[bindingColumns.split(",")[i]!]) !== v)
  )
    conversationFail();
  if (
    owner &&
    extensionCanonicalJson(bindingOwner(b)) !== extensionCanonicalJson(owner)
  )
    conversationFail();
  return b;
}
export function decodeConversationReceipt(
  row: Record<string, unknown> | undefined | null,
  owner: ProjectConversationOwner,
  receipt: ProjectConversationReceipt,
): ProjectConversationMutation | null {
  if (row == null) return null;
  if (row.request_digest !== receipt.requestDigest)
    conversationFail("project_conversation_idempotency_conflict");
  const v = projectTextRecord(json(row.result_json), [
    "kind",
    "disposition",
    "binding",
  ]);
  const b = parseProjectConversationBinding(v.binding, creativeStoreDigester);
  if (
    (v.kind !== "create" &&
      v.kind !== "refresh-source" &&
      v.kind !== "set-state") ||
    v.disposition !== "committed" ||
    v.kind !== row.kind ||
    b.bindingId !== row.binding_id ||
    extensionCanonicalJson(bindingOwner(b)) !== extensionCanonicalJson(owner) ||
    ownerValues(owner).some(
      (n, i) => row[ownerWhere.split(" AND ")[i]!.split("=")[0]!] !== n,
    ) ||
    row.idempotency_key !== receipt.idempotencyKey
  )
    conversationFail();
  return Object.freeze({ kind: v.kind, disposition: "replayed", binding: b });
}
export function decodeStageAdmission(
  row: Record<string, unknown> | undefined | null,
): ProjectStageRunAdmission | null {
  if (row == null) return null;
  const s = parseProjectStageRunAdmission(
    json(row.record_json),
    creativeStoreDigester,
  );
  if (
    row.tenant_id !== s.actor.tenantId ||
    row.space_id !== s.actor.spaceId ||
    row.run_id !== s.runId ||
    row.thread_id !== s.threadId ||
    row.binding_id !== s.bindingId ||
    String(row.binding_revision) !== String(s.bindingRevision)
  )
    conversationFail();
  return s;
}
export const captureConversationAuthority = captureProjectConversationAuthority;
export function captureConversationMutation(
  input: Parameters<ProjectConversationStore["commitBinding"]>[0],
  options: Parameters<ProjectConversationStore["commitBinding"]>[1],
) {
  const value = projectTextRecord(
    input,
    Object.hasOwn(input, "thread")
      ? ["kind", "binding", "expectedRevision", "receipt", "thread"]
      : ["kind", "binding", "expectedRevision", "receipt"],
  );
  const opts = Object.getOwnPropertyDescriptors(options ?? {});
  if (
    Reflect.ownKeys(options ?? {}).length !== 1 ||
    !opts.authority?.enumerable ||
    !Object.hasOwn(opts.authority, "value")
  )
    conversationFail("project_conversation_authority_required");
  const q = captureConversationAuthority(opts.authority.value),
    binding = parseProjectConversationBinding(
      value.binding,
      creativeStoreDigester,
    ),
    receipt = conversationReceipt(value.receipt),
    expectedRevision = creativeProjectRevision(value.expectedRevision, {
      minimum: 0,
    });
  if (
    value.kind !== "create" &&
    value.kind !== "refresh-source" &&
    value.kind !== "set-state"
  )
    conversationFail();
  if (
    extensionCanonicalJson(binding.owner) !== extensionCanonicalJson(q.actor) ||
    extensionCanonicalJson(receipt.actor) !== extensionCanonicalJson(q.actor) ||
    extensionCanonicalJson(binding.currentInstallation) !==
      extensionCanonicalJson(q.installation) ||
    binding.revision !== expectedRevision + 1 ||
    (value.kind === "create"
      ? expectedRevision !== 0 || binding.state !== "active"
      : expectedRevision === 0)
  )
    conversationFail();
  const thread = value.thread as CommitThreadInput | undefined;
  if (
    thread !== undefined &&
    (value.kind !== "create" ||
      thread.tenantId !== binding.owner.tenantId ||
      thread.expectedRevision !== 0 ||
      thread.events.length !== 1 ||
      thread.events[0]?.type !== "thread.created" ||
      thread.events[0].identity.threadId !== binding.threadId ||
      thread.events[0].data.spaceId !== binding.owner.spaceId ||
      thread.events[0].data.createdByActorId !== binding.owner.actorId ||
      (thread.events[0].data.workspaceId ?? null) !== binding.workspaceId ||
      thread.messages.length !== 0 ||
      thread.history.items.length !== 0 ||
      thread.officeBinding !== undefined ||
      thread.sourceFence !== undefined ||
      thread.tombstone !== undefined)
  )
    conversationFail();
  return Object.freeze({
    kind: value.kind,
    binding,
    receipt,
    expectedRevision,
    thread,
    q,
  });
}
export function assertConversationChange(
  kind: ProjectConversationMutation["kind"],
  previous: ProjectConversationBinding | null,
  next: ProjectConversationBinding,
  expected: number,
): void {
  if (kind === "create") {
    if (previous !== null)
      conversationFail("project_conversation_binding_conflict");
    return;
  }
  if (previous === null) conversationFail("project_conversation_not_found");
  if (previous.revision !== expected)
    conversationFail("project_conversation_revision_conflict");
  assertProjectConversationBindingChange(previous, next);
  if (
    kind === "refresh-source"
      ? next.state !== previous.state
      : extensionCanonicalJson(previous.currentInstallation) !==
        extensionCanonicalJson(next.currentInstallation)
  )
    conversationFail();
}
function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
