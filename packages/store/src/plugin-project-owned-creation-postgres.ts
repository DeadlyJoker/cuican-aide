import type { PoolClient } from "pg";
import type { CreateCreativeProjectResult } from "@crewon/application";
import {
  parsePluginProjectWorkspaceOwner,
  type CreativeProject,
  type ProjectBriefRevision,
} from "@crewon/domain";
import { prepareOwnedCreativeCreation } from "./plugin-project-owned-creation-preparation.ts";
import {
  creativeOwnerValues,
  decodeCreativeReceipt,
  decodeCreativeProject,
  decodeCreativeBrief,
  creativeRecordJson,
  verifyCreativeMutation,
} from "./creative-project-store-records.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import {
  hasPostgresPluginProjectMetadataOwnerSchema,
  PLUGIN_PROJECT_METADATA_OWNER_TABLE,
} from "./plugin-project-metadata-owner-schema.ts";
import {
  decodePluginProjectMetadataOwnerRecord,
  parsePluginProjectMetadataOwnerRecord,
} from "./plugin-project-metadata-owner-records.ts";
import {
  admitPostgresPluginInstallationPin,
  assertPostgresPluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import { assertCreativeProjectPluginCommitSelection } from "./creative-project-plugin-commit-support.ts";

type Owned = Awaited<ReturnType<typeof prepareOwnedCreativeCreation>>;
async function assertSource(c: PoolClient, schema: string, owned: Owned) {
  if (!(await hasPostgresPluginProjectMetadataOwnerSchema(c, schema)))
    throw new Error("plugin_project_owned_creation_schema_required");
  await assertPostgresPluginInstallationPinSchema(c, schema);
  const actual = await admitPostgresPluginInstallationPin(
    c,
    schema,
    owned.source.transaction.pin,
  );
  assertCreativeProjectPluginCommitSelection(owned.source.transaction, actual);
  owned.source.assertActive();
}
/** Original caller transaction, original receipt/project locks, no independent pool or metadata adoption. */
export async function readPostgresOwnedCreativeCreationReceipt(
  c: PoolClient,
  schema: string,
  owned: Owned,
) {
  await assertSource(c, schema, owned);
  const id = owned.identity,
    p = `${creativeProjectSchemaName(schema)}.`;
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([
      "creative-project-receipt",
      schema,
      ...creativeOwnerValues(id.owner),
      id.actor.actorId,
      id.kind,
      id.receipt.idempotencyKey,
    ]),
  ]);
  const row = (
    await c.query(
      `SELECT * FROM ${p}creative_project_mutation_receipts WHERE tenant_id=$1 AND space_id=$2 AND principal_id=$3 AND actor_id=$4 AND kind=$5 AND idempotency_key=$6`,
      [
        ...creativeOwnerValues(id.owner),
        id.actor.actorId,
        id.kind,
        id.receipt.idempotencyKey,
      ],
    )
  ).rows[0];
  const result = decodeCreativeReceipt(row, id);
  if (result === null) return null;
  if (result.kind !== "create-project")
    throw new Error("creative_project_receipt_invalid");
  const projectId = result.project.projectId;
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([
      "creative-project-project",
      schema,
      id.owner.tenantId,
      id.owner.spaceId,
      projectId,
    ]),
  ]);
  const values = [id.owner.tenantId, id.owner.spaceId, projectId];
  const project = decodeCreativeProject(
    (
      await c.query(
        `SELECT * FROM ${p}creative_projects WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 FOR SHARE`,
        values,
      )
    ).rows[0],
    id.owner,
  );
  if (project === null)
    throw new Error("plugin_project_owned_creation_project_missing");
  const owner = parsePluginProjectWorkspaceOwner({
    ...owned.source.scope,
    projectId,
  });
  const record = decodePluginProjectMetadataOwnerRecord(
    (
      await c.query(
        `SELECT * FROM ${p}${PLUGIN_PROJECT_METADATA_OWNER_TABLE} WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3 FOR SHARE`,
        values,
      )
    ).rows[0],
    {
      expectedOwner: owner,
      storedProjectPrincipalId: project.ownerPrincipalId,
    },
  );
  if (record === null || record.createdAt !== result.project.createdAt)
    throw new Error("plugin_project_owned_creation_owner_missing");
  if (
    project.createdAt !== record.createdAt ||
    project.createdByActorId !== owner.actorId ||
    result.project.createdByActorId !== owner.actorId ||
    result.brief.createdByActorId !== owner.actorId ||
    result.brief.createdAt !== record.createdAt
  )
    throw new Error("plugin_project_owned_creation_origin_mismatch");
  const brief = decodeCreativeBrief(
    (
      await c.query(
        `SELECT b.*,p.owner_principal_id FROM ${p}creative_project_briefs b JOIN ${p}creative_projects p ON p.tenant_id=b.tenant_id AND p.space_id=b.space_id AND p.project_id=b.project_id WHERE b.tenant_id=$1 AND b.space_id=$2 AND b.project_id=$3 AND b.brief_revision=$4`,
        [...values, result.brief.briefRevision],
      )
    ).rows[0],
    id.owner,
    projectId,
  );
  if (
    brief === null ||
    creativeRecordJson(brief) !== creativeRecordJson(result.brief)
  )
    throw new Error("plugin_project_owned_creation_brief_mismatch");
  owned.source.assertActive();
  return result;
}
export async function commitPostgresOwnedCreativeCreationRecords(
  c: PoolClient,
  schema: string,
  owned: Owned,
  writers: Readonly<{
    insertProject(project: CreativeProject): Promise<void>;
    insertBrief(brief: ProjectBriefRevision): Promise<void>;
    saveReceipt(
      identity: Owned["identity"],
      result: CreateCreativeProjectResult,
    ): Promise<void>;
  }>,
) {
  const replay = await readPostgresOwnedCreativeCreationReceipt(
    c,
    schema,
    owned,
  );
  if (replay !== null) return replay;
  const prepared = owned.prepared;
  if (prepared === null || prepared.kind !== "create-project")
    throw new Error("plugin_project_owned_creation_recipe_required");
  const p = `${creativeProjectSchemaName(schema)}.`;
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify([
      "creative-project-project",
      schema,
      prepared.project.tenantId,
      prepared.project.spaceId,
      prepared.project.projectId,
    ]),
  ]);
  if (
    (
      await c.query(
        `SELECT 1 FROM ${p}creative_projects WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3`,
        [
          prepared.project.tenantId,
          prepared.project.spaceId,
          prepared.project.projectId,
        ],
      )
    ).rowCount
  )
    throw new Error("plugin_project_owned_creation_project_conflict");
  const result = verifyCreativeMutation(prepared, {
    project: null,
    brief: null,
    asset: null,
  });
  if (result.kind !== "create-project")
    throw new Error("creative_project_receipt_invalid");
  const owner = parsePluginProjectWorkspaceOwner({
    ...owned.source.scope,
    projectId: result.project.projectId,
  });
  const record = parsePluginProjectMetadataOwnerRecord({
    schemaVersion: "crewon.plugin-project-metadata-owner.v1",
    owner,
    createdAt: result.project.createdAt,
  });
  owned.source.assertActive();
  await writers.insertProject(result.project);
  await writers.insertBrief(result.brief);
  await assertSource(c, schema, owned);
  await c.query(
    `INSERT INTO ${p}${PLUGIN_PROJECT_METADATA_OWNER_TABLE}(tenant_id,space_id,principal_id,actor_id,profile_id,plugin_id,publisher_id,project_id,created_at,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      owner.tenantId,
      owner.spaceId,
      owner.principalId,
      owner.actorId,
      owner.profileId,
      owner.pluginId,
      owner.publisherId,
      owner.projectId,
      record.createdAt,
      JSON.stringify(record),
    ],
  );
  await writers.saveReceipt(owned.identity, result);
  owned.source.assertActive();
  return result;
}

import type {
  CreativeProjectCommitAuthority,
  CreativeProjectCommitOptions,
  OwnedCreativeProjectCreationInput,
  OwnedCreativeProjectCreationReceiptInput,
} from "@crewon/application";
import type { PostgresCreativeProjectLegacyRead } from "./creative-project-postgres-legacy-read.ts";
import type { PostgresCreativeProjectLegacyAccess } from "./creative-project-legacy-access.ts";
export type PostgresOwnedCreationPorts = Readonly<{
  schema: string;
  transact<T>(
    body: PostgresCreativeProjectLegacyRead<T>,
    authority: CreativeProjectCommitAuthority | undefined,
    final: (client: PoolClient) => Promise<void>,
  ): Promise<T>;
  insertProject(
    client: PoolClient,
    project: CreativeProject,
    prepared: NonNullable<Owned["prepared"]>,
    access: PostgresCreativeProjectLegacyAccess,
  ): Promise<void>;
  insertBrief(client: PoolClient, brief: ProjectBriefRevision): Promise<void>;
  saveReceipt(
    client: PoolClient,
    identity: Owned["identity"],
    result: CreateCreativeProjectResult,
  ): Promise<void>;
}>;
export function runPostgresOwnedCreation(
  ports: PostgresOwnedCreationPorts,
  input: OwnedCreativeProjectCreationInput,
  options: CreativeProjectCommitOptions | undefined,
  operation: "commit",
): Promise<CreateCreativeProjectResult>;
export function runPostgresOwnedCreation(
  ports: PostgresOwnedCreationPorts,
  input: OwnedCreativeProjectCreationReceiptInput,
  options: CreativeProjectCommitOptions | undefined,
  operation: "read",
): Promise<CreateCreativeProjectResult | null>;
export async function runPostgresOwnedCreation(
  ports: PostgresOwnedCreationPorts,
  input:
    | OwnedCreativeProjectCreationInput
    | OwnedCreativeProjectCreationReceiptInput,
  options: CreativeProjectCommitOptions | undefined,
  operation: "read" | "commit",
) {
  const owned = await prepareOwnedCreativeCreation(input, options, operation);
  return ports.transact(
    async (client, access) =>
      operation === "read"
        ? readPostgresOwnedCreativeCreationReceipt(client, ports.schema, owned)
        : commitPostgresOwnedCreativeCreationRecords(
            client,
            ports.schema,
            owned,
            {
              insertProject: (project) =>
                ports.insertProject(client, project, owned.prepared!, access),
              insertBrief: (brief) => ports.insertBrief(client, brief),
              saveReceipt: (identity, result) =>
                ports.saveReceipt(client, identity, result),
            },
          ),
    owned.authority,
    async (client) => {
      await readPostgresOwnedCreativeCreationReceipt(
        client,
        ports.schema,
        owned,
      );
      owned.source.assertActive();
    },
  );
}
