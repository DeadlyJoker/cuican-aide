import type { PoolClient } from "pg";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitTransactionCurrent,
  type CreativeProjectCommitAuthority,
  type CreativeProjectMutationResult,
  type CreativeProjectOwnerScope,
  type PluginProjectMutationScope,
} from "@crewon/application";
import type {
  CreativeProject,
  ProjectBriefRevision,
  ConceptAsset,
  ConceptAssetRevision,
} from "@crewon/domain";
import {
  creativeMutationIdentity,
  creativeOwnerValues,
  verifyCreativeMutation,
  type PreparedCreativeMutation,
} from "./creative-project-store-records.ts";
import {
  creativeProjectPluginCommitQualification,
  assertCreativeProjectPluginCommitSelection,
} from "./creative-project-plugin-commit-support.ts";
import {
  projectRunCommitQualification,
  type ProjectRunQualification,
} from "./creative-project-run-commit-support.ts";
import { assertPostgresProjectRunCommit } from "./creative-project-run-commit-postgres.ts";
import {
  assertPostgresPluginInstallationPinSchema,
  admitPostgresPluginInstallationPin,
} from "./plugin-installation-pin-store-support.ts";
import {
  beginPostgresPlanResult,
  finishPostgresPlanResult,
} from "./project-text-plan-tool.ts";
import {
  postgresCreativeProjectLegacyMutationFence,
  type PostgresCreativeProjectLegacyMutationFence,
} from "./creative-project-legacy-mutation-access.ts";
import type { PostgresCreativeProjectLegacyRead } from "./creative-project-postgres-legacy-read.ts";
import type { PostgresCreativeProjectLegacyAccess } from "./creative-project-legacy-access.ts";
import { prepareOwnedMetadataMutation } from "./plugin-project-owned-mutation-preparation.ts";
import { assertPostgresOwnedMetadataTarget } from "./plugin-project-owned-mutation-postgres.ts";
import { capturePostgresOwnedProjectAccess } from "./plugin-project-owned-read-postgres.ts";
type Identity = ReturnType<typeof creativeMutationIdentity>;
export type PostgresCreativeMutationPorts = Readonly<{
  schema: string;
  assertOpen(): void;
  transact<T>(
    body: PostgresCreativeProjectLegacyRead<T>,
    authority?: CreativeProjectCommitAuthority,
    run?: ProjectRunQualification,
    fence?: PostgresCreativeProjectLegacyMutationFence,
  ): Promise<T>;
  lock(client: PoolClient, key: readonly unknown[]): Promise<void>;
  readReceipt(
    client: PoolClient,
    identity: Identity,
    access: PostgresCreativeProjectLegacyAccess,
  ): Promise<CreativeProjectMutationResult | null>;
  loadProject(
    client: PoolClient,
    owner: CreativeProjectOwnerScope,
    projectId: string,
    access: PostgresCreativeProjectLegacyAccess,
  ): Promise<CreativeProject | null>;
  loadBrief(
    client: PoolClient,
    owner: CreativeProjectOwnerScope,
    projectId: string,
    briefRevision: number,
    access: PostgresCreativeProjectLegacyAccess,
  ): Promise<ProjectBriefRevision | null>;
  loadAsset(
    client: PoolClient,
    owner: CreativeProjectOwnerScope,
    projectId: string,
    assetId: string,
    access: PostgresCreativeProjectLegacyAccess,
  ): Promise<ConceptAsset | null>;
  writeProject(
    client: PoolClient,
    project: CreativeProject,
    prepared: PreparedCreativeMutation,
    access: PostgresCreativeProjectLegacyAccess,
  ): Promise<void>;
  writeAsset(
    client: PoolClient,
    asset: ConceptAsset,
    prepared: PreparedCreativeMutation,
    access: PostgresCreativeProjectLegacyAccess,
  ): Promise<void>;
  insertBrief(client: PoolClient, brief: ProjectBriefRevision): Promise<void>;
  insertRevision(
    client: PoolClient,
    revision: ConceptAssetRevision,
  ): Promise<void>;
  saveReceipt(
    client: PoolClient,
    identity: Identity,
    result: CreativeProjectMutationResult,
  ): Promise<void>;
}>;
/** Original CAS/receipt/Run recipes over the caller's Store ports; owned branch changes only the captured predicate and final target fence. */
export async function commitPostgresCreativeMutation(
  ports: PostgresCreativeMutationPorts,
  prepared: PreparedCreativeMutation,
  authority: CreativeProjectCommitAuthority | undefined,
  mutationScope?: PluginProjectMutationScope,
): Promise<CreativeProjectMutationResult> {
  const identity = creativeMutationIdentity({
    actor: prepared.actor,
    receipt: prepared.receipt,
    kind: prepared.kind,
  });
  const owned =
    mutationScope === undefined
      ? undefined
      : await prepareOwnedMetadataMutation(mutationScope, authority, identity);
  const qualification = creativeProjectPluginCommitQualification(
    authority,
    identity.actor,
    identity.kind,
  );
  const runQualification = projectRunCommitQualification(
    authority,
    identity.actor,
    identity.kind,
    identity.receipt,
  );
  const ordinaryFence = postgresCreativeProjectLegacyMutationFence({
    schema: ports.schema,
    project: prepared.project,
    identity,
  });
  const assertLegacy: PostgresCreativeProjectLegacyMutationFence =
    owned === undefined
      ? ordinaryFence
      : async (client) => {
          await assertPostgresOwnedMetadataTarget(
            client,
            ports.schema,
            owned,
            prepared.project,
          );
        };
  return ports.transact(
    async (client, legacyAccess) => {
      const access =
        owned === undefined
          ? legacyAccess
          : await capturePostgresOwnedProjectAccess(
              client,
              ports.schema,
              owned,
            );
      await assertPostgresProjectRunCommit(
        client,
        ports.schema,
        runQualification,
      );
      if (qualification !== undefined) {
        await assertPostgresPluginInstallationPinSchema(client, ports.schema);
        const installation = await admitPostgresPluginInstallationPin(
          client,
          ports.schema,
          qualification.pin,
        );
        assertCreativeProjectPluginCommitSelection(qualification, installation);
        await assertCreativeProjectCommitTransactionCurrent(authority);
        assertCreativeProjectCommitActive(authority);
        ports.assertOpen();
      }
      // Receipt first: retries may prepare a different server-generated project ID.
      await ports.lock(client, [
        "creative-project-receipt",
        ports.schema,
        ...creativeOwnerValues(identity.owner),
        identity.actor.actorId,
        identity.kind,
        identity.receipt.idempotencyKey,
      ]);
      await assertLegacy(client, access);
      const planResult = await beginPostgresPlanResult(
        client,
        ports.schema,
        runQualification,
      );
      const previous = await ports.readReceipt(client, identity, access);
      if (previous !== null) {
        if (
          owned !== undefined &&
          previous.project.projectId !== owned.projectId
        )
          throw new Error("plugin_project_mutation_receipt_target_mismatch");
        await finishPostgresPlanResult(
          client,
          ports.schema,
          planResult,
          previous,
        );
        return previous;
      }
      await ports.lock(client, [
        "creative-project-project",
        ports.schema,
        prepared.project.tenantId,
        prepared.project.spaceId,
        prepared.project.projectId,
      ]);
      const project = await ports.loadProject(
        client,
        identity.owner,
        prepared.project.projectId,
        access,
      );
      const concept =
        prepared.kind === "create-concept" ||
        prepared.kind === "append-concept";
      const brief = concept
        ? await ports.loadBrief(
            client,
            identity.owner,
            prepared.project.projectId,
            prepared.assetRevision.briefRevision,
            access,
          )
        : null;
      const asset = concept
        ? await ports.loadAsset(
            client,
            identity.owner,
            prepared.project.projectId,
            prepared.asset.assetId,
            access,
          )
        : null;
      const result = verifyCreativeMutation(prepared, {
        project,
        brief,
        asset,
      });
      await ports.writeProject(client, result.project, prepared, access);
      if (result.kind === "create-project" || result.kind === "append-brief")
        await ports.insertBrief(client, result.brief);
      if (
        result.kind === "create-concept" ||
        result.kind === "append-concept"
      ) {
        await ports.writeAsset(client, result.asset, prepared, access);
        await ports.insertRevision(client, result.assetRevision);
      }
      await ports.saveReceipt(client, identity, result);
      await finishPostgresPlanResult(client, ports.schema, planResult, result);
      return result;
    },
    authority,
    runQualification,
    assertLegacy,
  );
}
