import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type {
  CreativeProjectOwnerScope,
  ProjectTextMutationResult,
} from "@crewon/application";
import type { CreativeProjectScope } from "@crewon/domain";
import type {
  CreativeProjectLegacyAccess,
  PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { readSqliteLegacyCreativeProject } from "./creative-project-sqlite-legacy-read.ts";
import { readPostgresLegacyCreativeProject } from "./creative-project-postgres-legacy-read.ts";
import type { TextRow } from "./project-text-store-support.ts";

export const textLegacyScope = (
  owner: Pick<CreativeProjectScope, "tenantId" | "spaceId">,
  projectId: string,
): CreativeProjectScope => ({
  tenantId: owner.tenantId,
  spaceId: owner.spaceId,
  projectId,
});
function hidden(error: unknown): boolean {
  return (
    error instanceof Error && error.message === "creative_project_not_found"
  );
}

/** Ordinary ports may hide protected records; schema corruption must still reject. */
export function readSqliteLegacyText<T>(
  database: DatabaseSync,
  scope: CreativeProjectScope,
  read: () => T,
  absent: T,
): T {
  return readSqliteLegacyCreativeProject(database, (access) => {
    try {
      access.assertProject(scope);
    } catch (error) {
      if (hidden(error)) return absent;
      throw error;
    }
    const result = read();
    access.assertProject(scope);
    return result;
  });
}
export async function readPostgresLegacyText<T>(
  context: Readonly<{ pool: Pool; schema: string; assertOpen(): void }>,
  scope: CreativeProjectScope,
  read: (client: PoolClient) => Promise<T>,
  absent: T,
): Promise<T> {
  return readPostgresLegacyCreativeProject(context, async (client, access) => {
    try {
      await access.assertProject(scope);
    } catch (error) {
      if (hidden(error)) return absent;
      throw error;
    }
    const result = await read(client);
    await access.assertProject(scope);
    return result;
  });
}

/** Check the saved SQL identity before decoding or request-digest comparison. */
export function assertSqliteLegacyTextReceipt(
  access: CreativeProjectLegacyAccess,
  owner: CreativeProjectOwnerScope,
  row: TextRow,
  mode: "read" | "mutation",
): boolean {
  if (row == null || typeof row.project_id !== "string") return true;
  try {
    access.assertProject(textLegacyScope(owner, row.project_id));
    return true;
  } catch (error) {
    if (mode === "read" && hidden(error)) return false;
    throw error;
  }
}
export async function assertPostgresLegacyTextReceipt(
  access: PostgresCreativeProjectLegacyAccess,
  owner: CreativeProjectOwnerScope,
  row: TextRow,
  mode: "read" | "mutation",
): Promise<boolean> {
  if (row == null || typeof row.project_id !== "string") return true;
  try {
    await access.assertProject(textLegacyScope(owner, row.project_id));
    return true;
  } catch (error) {
    if (mode === "read" && hidden(error)) return false;
    throw error;
  }
}
export function textLegacyResultScope(
  result: ProjectTextMutationResult | null | void,
): CreativeProjectScope | undefined {
  return result == null
    ? undefined
    : textLegacyScope(result.artifact, result.artifact.projectId);
}
