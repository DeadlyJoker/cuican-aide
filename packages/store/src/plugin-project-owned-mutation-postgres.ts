import type { PoolClient } from "pg";
import type { CreativeProjectMutationResult } from "@crewon/application";
import type { CreativeProjectScope } from "@crewon/domain";
import type { OwnedMetadataMutation } from "./plugin-project-owned-mutation-preparation.ts";
import type { PostgresCreativeProjectLegacyAccess } from "./creative-project-legacy-access.ts";
import { capturePostgresOwnedProjectAccess } from "./plugin-project-owned-read-postgres.ts";
import {
  assertPostgresPluginInstallationPinSchema,
  admitPostgresPluginInstallationPin,
} from "./plugin-installation-pin-store-support.ts";
import { assertCreativeProjectPluginCommitSelection } from "./creative-project-plugin-commit-support.ts";

/** Project advisory lock precedes the owner's project SHARE, so concurrent CAS never upgrades mutually held SHARE locks. */
export async function postgresOwnedMetadataAccess(
  c: PoolClient,
  schema: string,
  source: OwnedMetadataMutation,
) {
  source.assertActive();
  await assertPostgresPluginInstallationPinSchema(c, schema);
  const installed = await admitPostgresPluginInstallationPin(
    c,
    schema,
    source.snapshot.pin,
  );
  assertCreativeProjectPluginCommitSelection(
    source.snapshot.context,
    installed,
  );
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([
      "creative-project-project",
      schema,
      source.scope.tenantId,
      source.scope.spaceId,
      source.projectId,
    ]),
  ]);
  const access = await capturePostgresOwnedProjectAccess(c, schema, source);
  await access.assertProject({ projectId: source.projectId });
  source.assertActive();
  return access;
}
export async function assertPostgresOwnedMetadataTarget(
  c: PoolClient,
  schema: string,
  source: OwnedMetadataMutation,
  project: CreativeProjectScope,
) {
  if (
    project.projectId !== source.projectId ||
    project.tenantId !== source.scope.tenantId ||
    project.spaceId !== source.scope.spaceId
  )
    throw new Error("plugin_project_mutation_target_mismatch");
  return postgresOwnedMetadataAccess(c, schema, source);
}
export async function readPostgresOwnedMetadataReceipt(
  c: PoolClient,
  schema: string,
  source: OwnedMetadataMutation,
  read: (
    access: PostgresCreativeProjectLegacyAccess,
  ) => Promise<CreativeProjectMutationResult | null>,
) {
  const access = await postgresOwnedMetadataAccess(c, schema, source);
  const replay = await read(access);
  if (replay !== null && replay.project.projectId !== source.projectId)
    throw new Error("plugin_project_mutation_receipt_target_mismatch");
  source.assertActive();
  return replay;
}
