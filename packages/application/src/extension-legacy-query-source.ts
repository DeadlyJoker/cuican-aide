import {
  parseExtensionRunBinding,
  type ExtensionRunBinding,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type {
  ExtensionTaskApplicationDependencies,
  ExtensionTaskIntent,
} from "./extension-task-application-service.ts";

/** Original legacy query validation; installed tasks retain their separate v1 provenance path. */
export async function loadExtensionLegacyQuerySource(
  dependencies: ExtensionTaskApplicationDependencies,
  actor: ActorContext,
  pluginId: string,
  intent: Extract<ExtensionTaskIntent, { kind: "query" }>,
): Promise<ExtensionRunBinding> {
  const run = await dependencies.store.loadRunInSpace({
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    runId: intent.sourceRunId,
  });
  if (run === null)
    throw new ApplicationError("notFound", "extension_query_source_not_found");
  const owner = Object.freeze({
    tenantId: run.tenantId,
    spaceId: run.spaceId,
    runId: run.runId,
    threadId: run.threadId,
    actorId: run.createdByActorId,
    agentVersionId: run.agentVersionId,
    authorityId: run.authorityId,
    runtimeGeneration: run.runtimeGeneration,
    policySnapshotId: run.policySnapshotId,
    workspaceBindingId: run.workspaceBindingId,
  });
  if (
    owner.tenantId !== actor.tenantId ||
    owner.spaceId !== actor.spaceId ||
    owner.runId !== intent.sourceRunId
  )
    throw new ApplicationError("internal", "extension_query_source_invalid");
  const permission = await dependencies.authorization.authorize({
    actor,
    action: "run:read",
    resource: {
      kind: "run",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId: owner.threadId,
      runId: owner.runId,
    },
  });
  if (permission.outcome !== "allow")
    throw new ApplicationError("authorization", "authorization_denied");
  const value = await dependencies.extensions.loadExtensionRunBinding({
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    runId: owner.runId,
  });
  if (value === null)
    throw new ApplicationError("notFound", "extension_query_source_not_found");
  const source = parseExtensionRunBinding(value, dependencies.digester);
  if (
    source.pluginId !== pluginId ||
    source.source !== null ||
    source.threadId !== owner.threadId
  )
    throw new ApplicationError("notFound", "extension_query_source_not_found");
  if (
    source.tenantId !== actor.tenantId ||
    source.spaceId !== actor.spaceId ||
    source.runId !== owner.runId ||
    source.actorId !== owner.actorId ||
    [
      "agentVersionId",
      "authorityId",
      "runtimeGeneration",
      "policySnapshotId",
      "workspaceBindingId",
    ].some(
      (key) =>
        source.target[key as keyof typeof source.target] !==
        owner[key as keyof typeof owner],
    )
  )
    throw new ApplicationError("internal", "extension_query_source_invalid");
  const operation = await dependencies.operations.loadExternalOperation({
    tenantId: actor.tenantId,
    runId: source.runId,
    bindingDigest: source.bindingDigest,
    operationId: intent.operationId,
  });
  if (operation === null)
    throw new ApplicationError("notFound", "extension_query_source_not_found");
  if (
    operation.tenantId !== actor.tenantId ||
    operation.runId !== source.runId ||
    operation.bindingDigest !== source.bindingDigest ||
    operation.operationId !== intent.operationId
  )
    throw new ApplicationError(
      "internal",
      "external_operation_identity_conflict",
    );
  return source;
}
