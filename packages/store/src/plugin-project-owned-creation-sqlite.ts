import type { DatabaseSync } from "node:sqlite";
import { type CreateCreativeProjectResult } from "@crewon/application";
import {
  parsePluginProjectWorkspaceOwner,
  type CreativeProject,
  type ProjectBriefRevision,
} from "@crewon/domain";
import {
  decodeCreativeReceipt,
  decodeCreativeProject,
  decodeCreativeBrief,
  verifyCreativeMutation,
  creativeRecordJson,
} from "./creative-project-store-records.ts";
import {
  hasSqlitePluginProjectMetadataOwnerSchema,
  PLUGIN_PROJECT_METADATA_OWNER_TABLE,
} from "./plugin-project-metadata-owner-schema.ts";
import {
  decodePluginProjectMetadataOwnerRecord,
  parsePluginProjectMetadataOwnerRecord,
} from "./plugin-project-metadata-owner-records.ts";
import {
  admitSqlitePluginInstallationPin,
  assertSqlitePluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import { assertCreativeProjectPluginCommitSelection } from "./creative-project-plugin-commit-support.ts";

export { prepareOwnedCreativeCreation } from "./plugin-project-owned-creation-preparation.ts";
import { prepareOwnedCreativeCreation } from "./plugin-project-owned-creation-preparation.ts";
type Owned = Awaited<ReturnType<typeof prepareOwnedCreativeCreation>>;

function assertSource(db: DatabaseSync, owned: Owned): void {
  if (!db.isTransaction)
    throw new Error("plugin_project_owned_creation_transaction_required");
  if (!hasSqlitePluginProjectMetadataOwnerSchema(db))
    throw new Error("plugin_project_owned_creation_schema_required");
  assertSqlitePluginInstallationPinSchema(db);
  const actual = admitSqlitePluginInstallationPin(
    db,
    owned.source.transaction.pin,
  );
  assertCreativeProjectPluginCommitSelection(owned.source.transaction, actual);
  owned.source.assertActive();
}

export function readOwnedCreativeCreationReceipt(
  db: DatabaseSync,
  owned: Owned,
) {
  assertSource(db, owned);
  const id = owned.identity;
  const row = db
    .prepare(
      "SELECT * FROM creative_project_mutation_receipts WHERE tenant_id=? AND space_id=? AND principal_id=? AND actor_id=? AND kind=? AND idempotency_key=?",
    )
    .get(
      id.actor.tenantId,
      id.actor.spaceId,
      id.actor.principalId,
      id.actor.actorId,
      id.kind,
      id.receipt.idempotencyKey,
    );
  const result = decodeCreativeReceipt(row, id);
  if (result === null) return null;
  if (result.kind !== "create-project")
    throw new Error("creative_project_receipt_invalid");
  const projectId = result.project.projectId;
  const projectRow = db
    .prepare(
      "SELECT * FROM creative_projects WHERE tenant_id=? AND space_id=? AND project_id=?",
    )
    .get(id.owner.tenantId, id.owner.spaceId, projectId);
  const project = decodeCreativeProject(projectRow, id.owner);
  if (project === null)
    throw new Error("plugin_project_owned_creation_project_missing");
  const owner = parsePluginProjectWorkspaceOwner({
    ...owned.source.scope,
    projectId,
  });
  const record = decodePluginProjectMetadataOwnerRecord(
    db
      .prepare(
        `SELECT * FROM ${PLUGIN_PROJECT_METADATA_OWNER_TABLE} WHERE tenant_id=? AND space_id=? AND project_id=?`,
      )
      .get(owner.tenantId, owner.spaceId, projectId),
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
    db
      .prepare(
        "SELECT b.*,p.owner_principal_id FROM creative_project_briefs b JOIN creative_projects p ON p.tenant_id=b.tenant_id AND p.space_id=b.space_id AND p.project_id=b.project_id WHERE b.tenant_id=? AND b.space_id=? AND b.project_id=? AND b.brief_revision=?",
      )
      .get(
        owner.tenantId,
        owner.spaceId,
        projectId,
        result.brief.briefRevision,
      ),
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

function writeOwnedCreativeCreationOwner(
  db: DatabaseSync,
  owned: Owned,
  project: CreativeProject,
): void {
  assertSource(db, owned);
  const owner = parsePluginProjectWorkspaceOwner({
    ...owned.source.scope,
    projectId: project.projectId,
  });
  const record = parsePluginProjectMetadataOwnerRecord({
    schemaVersion: "crewon.plugin-project-metadata-owner.v1",
    owner,
    createdAt: project.createdAt,
  });
  db.prepare(
    `INSERT INTO ${PLUGIN_PROJECT_METADATA_OWNER_TABLE} (tenant_id,space_id,principal_id,actor_id,profile_id,plugin_id,publisher_id,project_id,created_at,record_json) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
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
  );
  owned.source.assertActive();
}

/** Writes through the original Store's own record writers inside its already-held transaction. */
export function commitOwnedCreativeCreationRecords(
  db: DatabaseSync,
  owned: Owned,
  writers: Readonly<{
    insertProject(project: CreativeProject): void;
    insertBrief(brief: ProjectBriefRevision): void;
    saveReceipt(
      identity: Owned["identity"],
      result: CreateCreativeProjectResult,
    ): void;
  }>,
) {
  const replay = readOwnedCreativeCreationReceipt(db, owned);
  if (replay !== null) return replay;
  const prepared = owned.prepared;
  if (prepared === null || prepared.kind !== "create-project")
    throw new Error("plugin_project_owned_creation_recipe_required");
  if (
    db
      .prepare(
        "SELECT 1 FROM creative_projects WHERE tenant_id=? AND space_id=? AND project_id=?",
      )
      .get(
        prepared.project.tenantId,
        prepared.project.spaceId,
        prepared.project.projectId,
      )
  )
    throw new Error("plugin_project_owned_creation_project_conflict");
  const result = verifyCreativeMutation(prepared, {
    project: null,
    brief: null,
    asset: null,
  });
  if (result.kind !== "create-project")
    throw new Error("creative_project_receipt_invalid");
  owned.source.assertActive();
  writers.insertProject(result.project);
  writers.insertBrief(result.brief);
  writeOwnedCreativeCreationOwner(db, owned, result.project);
  writers.saveReceipt(owned.identity, result);
  owned.source.assertActive();
  return result;
}
