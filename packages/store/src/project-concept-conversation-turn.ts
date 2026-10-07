import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type {
  ActorContext,
  CommitExtensionTurnInput,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  validateThreadState,
  type PluginTaskAdmissionPin,
  type ThreadState,
} from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  assertSqliteConversationSchema,
  assertPostgresConversationSchema,
} from "./project-conversation-schema.ts";
import {
  conversationFail,
  decodeConversation,
} from "./project-conversation-store-support.ts";
import { advisoryLock } from "./postgres-thread-lock.ts";

/** Comes only from the captured generation/query publication, never the public task body. */
export type ProjectConceptConversationTurn = Readonly<{
  actor: ActorContext;
  reference: Readonly<{ projectId: string }>;
  publication?: Readonly<{ sourcePin: PluginTaskAdmissionPin }>;
}>;
type Check = Readonly<{
  marker: string;
  operation: ProjectConceptConversationTurn | null;
  input: CommitExtensionTurnInput;
  newTurn: boolean;
}>;
function source(check: Check) {
  const pin = check.operation?.publication?.sourcePin;
  if (!pin || !check.operation)
    conversationFail("project_stage_admission_required");
  return { pin, operation: check.operation };
}
function verify(
  check: Check,
  bindingRow: Record<string, unknown> | undefined,
  threadRow: Record<string, unknown> | undefined,
) {
  const { pin, operation } = source(check);
  const b = decodeConversation(bindingRow, {
    actor: operation.actor,
    profileId: pin.profileId,
  });
  if (!b || !threadRow)
    conversationFail("project_concept_conversation_mismatch");
  const t = (
    typeof threadRow.state_json === "string"
      ? JSON.parse(threadRow.state_json)
      : threadRow.state_json
  ) as ThreadState;
  validateThreadState(t);
  const installation = b.currentInstallation;
  if (
    b.bindingId !== check.marker ||
    b.projectId !== operation.reference.projectId ||
    b.threadId !== check.input.binding.threadId ||
    extensionCanonicalJson(b.owner) !==
      extensionCanonicalJson(operation.actor) ||
    pin.tenantId !== operation.actor.tenantId ||
    pin.spaceId !== operation.actor.spaceId ||
    pin.principalId !== operation.actor.principalId ||
    pin.actorId !== operation.actor.actorId ||
    installation.pluginId !== pin.pluginId ||
    installation.publisherId !== pin.publisherId ||
    t.threadId !== b.threadId ||
    t.tenantId !== operation.actor.tenantId ||
    t.spaceId !== operation.actor.spaceId ||
    t.createdByActorId !== operation.actor.actorId ||
    (t.workspaceId ?? null) !== b.workspaceId ||
    threadRow.project_conversation_binding_id !== b.bindingId ||
    threadRow.tenant_id !== t.tenantId ||
    threadRow.space_id !== t.spaceId ||
    threadRow.thread_id !== t.threadId ||
    threadRow.created_by_actor_id !== t.createdByActorId ||
    threadRow.status !== t.status ||
    String(threadRow.revision) !== String(t.revision)
  )
    conversationFail("project_concept_conversation_mismatch");
  // A committed receipt remains readable after a source update or revocation; it cannot create another Run.
  if (
    check.newTurn &&
    (b.state !== "active" ||
      t.status !== "active" ||
      installation.version !== pin.version ||
      installation.packageDigest !== pin.packageDigest ||
      installation.selectionRevision !== pin.selectionRevision)
  )
    conversationFail("project_concept_conversation_source_changed");
}
export function assertSqliteProjectConceptConversation(
  db: DatabaseSync,
  check: Check,
): void {
  const { pin, operation } = source(check);
  assertSqliteConversationSchema(db);
  verify(
    check,
    db
      .prepare(
        "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
      )
      .get(operation.actor.tenantId, operation.actor.spaceId, check.marker),
    db
      .prepare("SELECT * FROM threads WHERE tenant_id=? AND thread_id=?")
      .get(pin.tenantId, check.input.binding.threadId!),
  );
}
export async function assertPostgresProjectConceptConversation(
  client: PoolClient,
  schema: string,
  check: Check,
): Promise<void> {
  const { pin, operation } = source(check),
    prefix = creativeProjectSchemaName(schema) + ".";
  await assertPostgresConversationSchema(client, schema);
  for (const key of [
    `idempotency:${check.input.turn.idempotency.scope}:${check.input.turn.idempotency.key}`,
    `run:${pin.tenantId}:${check.input.binding.runId}`,
    `thread:${pin.tenantId}:${check.input.binding.threadId}`,
  ])
    await advisoryLock(client, key);
  await advisoryLock(
    client,
    JSON.stringify([
      "creative-project-project",
      schema,
      pin.tenantId,
      pin.spaceId,
      operation.reference.projectId,
    ]),
  );
  const binding = (
    await client.query(
      `SELECT * FROM ${prefix}project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3 FOR SHARE`,
      [operation.actor.tenantId, operation.actor.spaceId, check.marker],
    )
  ).rows[0];
  const thread = (
    await client.query(
      `SELECT * FROM ${prefix}threads WHERE tenant_id=$1 AND thread_id=$2 FOR UPDATE`,
      [pin.tenantId, check.input.binding.threadId],
    )
  ).rows[0];
  verify(check, binding, thread);
}
