import type { DatabaseSync } from "node:sqlite";
import type { CreativeProjectScope } from "@crewon/domain";
import type { CreativeProjectMutationResult } from "@crewon/application";
import type { CreativeProjectLegacyAccess } from "./creative-project-legacy-access.ts";
import { captureSqliteOwnedProjectAccess } from "./plugin-project-owned-read-sqlite.ts";
import {
  assertSqlitePluginInstallationPinSchema,
  admitSqlitePluginInstallationPin,
} from "./plugin-installation-pin-store-support.ts";
import { assertCreativeProjectPluginCommitSelection } from "./creative-project-plugin-commit-support.ts";

export { prepareOwnedMetadataMutation as prepareSqliteOwnedMetadataMutation } from "./plugin-project-owned-mutation-preparation.ts";
import { prepareOwnedMetadataMutation as prepareSqliteOwnedMetadataMutation } from "./plugin-project-owned-mutation-preparation.ts";

type Owned = Awaited<ReturnType<typeof prepareSqliteOwnedMetadataMutation>>;
export function readSqliteOwnedMetadataReceipt(
  db: DatabaseSync,
  source: Owned,
  read: (
    access: CreativeProjectLegacyAccess,
  ) => CreativeProjectMutationResult | null,
) {
  assertSqlitePluginInstallationPinSchema(db);
  const installed = admitSqlitePluginInstallationPin(db, source.snapshot.pin);
  assertCreativeProjectPluginCommitSelection(
    source.snapshot.context,
    installed,
  );
  const access = captureSqliteOwnedProjectAccess(db, source);
  access.assertProject({
    tenantId: source.scope.tenantId,
    spaceId: source.scope.spaceId,
    projectId: source.projectId,
  });
  const replay = read(access);
  if (replay !== null && replay.project.projectId !== source.projectId)
    throw new Error("plugin_project_mutation_receipt_target_mismatch");
  return replay;
}

export function assertSqliteOwnedMetadataTarget(
  db: DatabaseSync,
  owned: Owned,
  project: CreativeProjectScope,
) {
  owned.assertActive();
  if (
    project.projectId !== owned.projectId ||
    project.tenantId !== owned.scope.tenantId ||
    project.spaceId !== owned.scope.spaceId
  )
    throw new Error("plugin_project_mutation_target_mismatch");
  captureSqliteOwnedProjectAccess(db, owned).assertProject(project);
}
