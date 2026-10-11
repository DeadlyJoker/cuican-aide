import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { CreativeProjectScope } from "@crewon/domain";
import {
  captureSqliteCreativeProjectLegacyAccess,
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
} from "./creative-project-legacy-access.ts";

/** Private negative checks on the original executor connection; never a grant. */
export type AssetLegacyInstruction = Readonly<{
  assetLegacyAccess:
    | Readonly<{ kind: "schema" }>
    | Readonly<{ kind: "project"; scope: CreativeProjectScope }>;
}>;

export function executeSqliteAssetLegacyInstruction(
  database: DatabaseSync,
  instruction: AssetLegacyInstruction,
): readonly Record<string, unknown>[] {
  if (!database.isTransaction)
    throw new Error("creative_project_legacy_transaction_required");
  const access = captureSqliteCreativeProjectLegacyAccess(database);
  if (instruction.assetLegacyAccess.kind === "project")
    access.assertProject(instruction.assetLegacyAccess.scope);
  return [];
}

export async function executePostgresAssetLegacyInstruction(
  client: PoolClient,
  schema: string,
  instruction: AssetLegacyInstruction,
): Promise<readonly Record<string, unknown>[]> {
  await lockPostgresCreativeProjectLegacySchema(client, schema);
  const access = await capturePostgresCreativeProjectLegacyAccess(
    client,
    schema,
  );
  if (instruction.assetLegacyAccess.kind === "project")
    await access.assertProject(instruction.assetLegacyAccess.scope);
  return [];
}

export function captureSqliteAssetLegacyExecution(database: DatabaseSync) {
  const scopes = new Map<string, CreativeProjectScope>();
  let received = false;
  return {
    execute(instruction: AssetLegacyInstruction) {
      received = true;
      if (instruction.assetLegacyAccess.kind === "project") {
        const scope = instruction.assetLegacyAccess.scope;
        scopes.set(JSON.stringify(scope), scope);
      }
      return executeSqliteAssetLegacyInstruction(database, instruction);
    },
    assertCurrent() {
      if (!received) return;
      const access = captureSqliteCreativeProjectLegacyAccess(database);
      for (const scope of scopes.values()) access.assertProject(scope);
    },
  };
}

export function capturePostgresAssetLegacyExecution(
  client: PoolClient,
  schema: string,
) {
  const scopes = new Map<string, CreativeProjectScope>();
  let received = false;
  return {
    async execute(instruction: AssetLegacyInstruction) {
      received = true;
      if (instruction.assetLegacyAccess.kind === "project") {
        const scope = instruction.assetLegacyAccess.scope;
        scopes.set(JSON.stringify(scope), scope);
      }
      return executePostgresAssetLegacyInstruction(client, schema, instruction);
    },
    async assertCurrent() {
      if (!received) return;
      await lockPostgresCreativeProjectLegacySchema(client, schema);
      const access = await capturePostgresCreativeProjectLegacyAccess(
        client,
        schema,
      );
      for (const scope of scopes.values()) await access.assertProject(scope);
    },
  };
}
