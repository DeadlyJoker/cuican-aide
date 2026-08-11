import { createHash } from "node:crypto";

import {
  RunStoreError,
  canonicalWorkspaceListAction,
  canonicalWorkspaceListDispatchCommand,
  validateWorkspaceOperationRecord,
  type WorkspaceOperationRecord,
} from "@crewon/application";

export function validateWorkspaceOperationDigestAuthority(
  input: WorkspaceOperationRecord,
): WorkspaceOperationRecord {
  const operation = validateWorkspaceOperationRecord(input);
  const actionDigest = sha256(
    canonicalWorkspaceListAction({
      idempotencyKey: operation.idempotencyKey,
      command: operation.command,
    }),
  );
  const commandDigest = sha256(
    canonicalWorkspaceListDispatchCommand({
      tenantId: operation.tenantId,
      spaceId: operation.spaceId,
      threadId: operation.threadId,
      expectedThreadRevision: operation.expectedThreadRevision,
      principalId: operation.principalId,
      actorId: operation.actorId,
      idempotencyKey: operation.idempotencyKey,
      command: { ...operation.command, actionDigest },
    }),
  );
  if (
    operation.command.actionDigest !== actionDigest ||
    operation.command.commandDigest !== commandDigest
  ) {
    throw new RunStoreError("workspace_operation_digest_authority_invalid");
  }
  return operation;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
