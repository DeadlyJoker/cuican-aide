import type { AppServerClient } from "../app-server/appServer";
import type { OfficeConfig } from "../domain/crewonDomain";

type OfficeCanonicalReadClient = Pick<AppServerClient, "readOfficeConfig">;

export type CanonicalOfficeConfigRecord = {
  config: OfficeConfig;
  filePath: string;
};

export async function readCanonicalOfficeConfigForMutation(params: {
  client: OfficeCanonicalReadClient;
  cwd: string;
  reference: OfficeConfig;
}): Promise<CanonicalOfficeConfigRecord> {
  const expectedThreadId = requiredIdentityValue(
    params.reference.workspace.threadId,
    "workspace.threadId",
  );
  const expectedRecordId = optionalIdentityValue(
    params.reference.workspace.recordId,
    "workspace.recordId",
  );
  const response = await params.client.readOfficeConfig(params.cwd, {
    threadId: expectedThreadId,
    title: null,
  });
  const record = response.record;
  if (!record) {
    throw new Error(
      `Unable to resolve canonical Office record for thread ${expectedThreadId}`,
    );
  }

  const canonicalThreadId = requiredIdentityValue(
    record.config.workspace.threadId,
    "canonical workspace.threadId",
  );
  if (canonicalThreadId !== expectedThreadId) {
    throw new Error("Canonical Office thread identity does not match the target");
  }
  if (expectedRecordId) {
    const canonicalRecordId = requiredIdentityValue(
      record.config.workspace.recordId,
      "canonical workspace.recordId",
    );
    if (canonicalRecordId !== expectedRecordId) {
      throw new Error("Canonical Office recordId does not match the target");
    }
  }

  return {
    config: record.config,
    filePath: record.filePath,
  };
}

function optionalIdentityValue(
  value: string | undefined,
  field: string,
): string | null {
  if (value === undefined) {
    return null;
  }
  return requiredIdentityValue(value, field);
}

function requiredIdentityValue(
  value: string | undefined,
  field: string,
): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    throw new Error(
      `Cannot safely resolve canonical Office config without ${field}`,
    );
  }
  return normalized;
}
