import { validateThreadState, type ThreadState } from "@crewon/domain";
import {
  mediaInputSame as same,
  mediaGenerationFail as fail,
  type CommitExtensionTurnInput,
} from "@crewon/application";
import type { CapturedProjectMediaGenerationTurn } from "./project-media-generation-turn.ts";
import type { ProjectMediaInputPlan } from "./project-media-input-plan.ts";
import {
  assetQuery,
  assetLock,
  assetProject,
  assetOwner,
  type AssetDialect,
} from "./project-asset-store-support.ts";
import { decodeConversation } from "./project-conversation-store-support.ts";

/** Project media uses the existing Thread transaction, never a second connection or an ordinary-turn bypass. */
export function* assertProjectMediaConversationTurn(
  d: AssetDialect,
  media: CapturedProjectMediaGenerationTurn,
  input: CommitExtensionTurnInput,
): ProjectMediaInputPlan<void> {
  const b = media.authority.conversation;
  if (b === undefined) return;
  const a = media.authority.actor;
  if (
    !same(b.owner, a) ||
    b.state !== "active" ||
    b.projectId !== media.reference.projectId ||
    b.threadId !== input.binding.threadId ||
    b.profileId !== media.admission.profileId ||
    b.currentInstallation.pluginId !== media.admission.pluginId
  )
    fail("conversation_mismatch");
  // Use the same lock order as the original project-stage Turn and binding writer.
  if (d.postgres) {
    for (const key of [
      `idempotency:${input.turn.idempotency.scope}:${input.turn.idempotency.key}`,
      `run:${input.binding.tenantId}:${input.binding.runId}`,
      `thread:${input.binding.tenantId}:${input.binding.threadId}`,
    ])
      yield* assetQuery(
        d,
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [key],
      );
  }
  yield* assetLock(d, [
    "creative-project-project",
    d.schema,
    a.tenantId,
    a.spaceId,
    b.projectId,
  ]);
  yield* assetProject(d, assetOwner(a), b.projectId);
  const bindings = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3${d.postgres ? " FOR SHARE" : ""}`,
    [a.tenantId, a.spaceId, b.bindingId],
  );
  const current = decodeConversation(bindings[0], {
    actor: a,
    profileId: b.profileId,
  });
  if (!same(current, b)) fail("conversation_changed");
  const rows = yield* assetQuery(
    d,
    `SELECT * FROM ${d.prefix}threads WHERE tenant_id=$1 AND thread_id=$2${d.postgres ? " FOR UPDATE" : ""}`,
    [a.tenantId, b.threadId],
  );
  const row = rows[0];
  if (!row) fail("conversation_mismatch");
  const t = (
    typeof row.state_json === "string"
      ? JSON.parse(row.state_json)
      : row.state_json
  ) as ThreadState;
  validateThreadState(t);
  if (
    t.tenantId !== a.tenantId ||
    t.spaceId !== a.spaceId ||
    t.threadId !== b.threadId ||
    t.createdByActorId !== a.actorId ||
    t.status !== "active" ||
    (t.workspaceId ?? null) !== b.workspaceId ||
    row.tenant_id !== t.tenantId ||
    row.space_id !== t.spaceId ||
    row.thread_id !== t.threadId ||
    row.created_by_actor_id !== t.createdByActorId ||
    row.status !== t.status ||
    String(row.revision) !== String(t.revision) ||
    row.project_conversation_binding_id !== b.bindingId
  )
    fail("conversation_mismatch");
}
