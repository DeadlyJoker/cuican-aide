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
import { extensionCanonicalJson } from "@crewon/domain";
import {
  qualifyPluginProjectMutationScope,
  scopedPluginMetadataReceipt,
  type PluginProjectMutationScope,
  type CreativeProjectCommitAuthority,
} from "@crewon/application";
import { creativeProjectPluginCommitQualification } from "./creative-project-plugin-commit-support.ts";
import {
  creativeStoreDigester,
  type creativeMutationIdentity,
} from "./creative-project-store-records.ts";

export async function prepareSqliteOwnedMetadataMutation(
  scope: PluginProjectMutationScope,
  authority: CreativeProjectCommitAuthority | undefined,
  identity: ReturnType<typeof creativeMutationIdentity>,
) {
  const source = qualifyPluginProjectMutationScope(scope);
  const qualification = creativeProjectPluginCommitQualification(
    authority,
    identity.actor,
    identity.kind,
  );
  if (
    qualification === undefined ||
    extensionCanonicalJson(qualification.pin) !==
      extensionCanonicalJson(source.snapshot.pin) ||
    extensionCanonicalJson(qualification.selection) !==
      extensionCanonicalJson(source.snapshot.context.selection) ||
    extensionCanonicalJson(qualification.package) !==
      extensionCanonicalJson(source.snapshot.context.package)
  )
    throw new Error("plugin_project_mutation_authority_mismatch");
  const input = source.request.input as Readonly<Record<string, unknown>>;
  const command = {
    ...(input.request as object),
    ...Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "request"),
    ),
  };
  const receipt = scopedPluginMetadataReceipt(
    scope,
    identity.actor,
    command as never,
    {
      idempotencyKey: String(input.idempotencyKey),
      requestDigest: identity.receipt.requestDigest,
    },
    creativeStoreDigester,
  );
  if (receipt.idempotencyKey !== identity.receipt.idempotencyKey)
    throw new Error("plugin_project_mutation_receipt_mismatch");
  await source.assertCurrent();
  source.assertActive();
  return Object.freeze({ ...source, projectId: String(input.projectId) });
}

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
