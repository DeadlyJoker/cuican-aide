import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  pluginTaskReceiptKey,
  qualifyPluginProjectReadScope,
  type ExtensionStore,
} from "@crewon/application";
import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import type {
  CreativeProjectLegacyAccess,
  PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { readSqliteOwnedCreativeProject } from "./plugin-project-owned-read-sqlite.ts";
import { readPostgresOwnedCreativeProject } from "./plugin-project-owned-read-postgres.ts";
type Input = Parameters<ExtensionStore["loadExtensionTurnReceipt"]>[0];
type Options = Extract<
  NonNullable<Parameters<ExtensionStore["loadExtensionTurnReceipt"]>[1]>,
  { projectAssetStageReadScope: unknown }
>;
type Result = Awaited<ReturnType<ExtensionStore["loadExtensionTurnReceipt"]>>;
function call(input: Input, options: Options) {
  if (
    options === null ||
    typeof options !== "object" ||
    Reflect.ownKeys(options).length !== 1 ||
    !Object.getOwnPropertyDescriptor(options, "projectAssetStageReadScope")
      ?.enumerable ||
    !Object.hasOwn(
      Object.getOwnPropertyDescriptor(options, "projectAssetStageReadScope")!,
      "value",
    )
  )
    denied();
  const scope = options.projectAssetStageReadScope,
    source = qualifyPluginProjectReadScope(scope),
    b = source.assetStageRead?.binding;
  if (
    !b ||
    source.request.action !== "crewon.project-asset-stage-read.v1" ||
    source.request.input.purpose !== "start-stage" ||
    input.tenantId !== b.owner.tenantId ||
    input.spaceId !== b.owner.spaceId ||
    input.pluginId !== b.currentInstallation.pluginId ||
    input.receipt.actorId !== b.owner.actorId ||
    input.receipt.idempotencyKey !==
      pluginTaskReceiptKey(
        {
          actor: b.owner,
          profileId: b.profileId,
          pluginId: b.currentInstallation.pluginId,
          idempotencyKey: source.request.input.idempotencyKey,
        },
        creativeStoreDigester,
      )
  )
    denied();
  return {
    scope,
    method: "loadExtensionTurnReceipt" as const,
    query: {
      owner: {
        tenantId: b.owner.tenantId,
        spaceId: b.owner.spaceId,
        principalId: b.owner.principalId,
      },
      projectId: b.projectId,
    },
  };
}
function checked(options: Options, value: Result) {
  const b = qualifyPluginProjectReadScope(options.projectAssetStageReadScope)
    .assetStageRead!.binding;
  if (
    value !== null &&
    (value.binding.threadId !== b.threadId ||
      value.projectAssetStageAdmission?.bindingId !== b.bindingId ||
      value.projectAssetStageAdmission.projectId !== b.projectId ||
      value.projectAssetStageAdmission.bindingRevision !== b.revision)
  )
    denied();
  return { projectId: b.projectId, value };
}
export async function readSqliteAssetStageExtensionReceipt(
  input: Readonly<{
    database: DatabaseSync;
    assertOpen(): void;
    request: Input;
    options: Options;
  }>,
  read: (access: CreativeProjectLegacyAccess) => Result,
) {
  return (
    await readSqliteOwnedCreativeProject(
      input.database,
      call(input.request, input.options),
      (access) => checked(input.options, read(access)),
      input.assertOpen,
    )
  ).value;
}
export async function readPostgresAssetStageExtensionReceipt(
  input: Readonly<{
    pool: Pool;
    schema: string;
    assertOpen(): void;
    request: Input;
    options: Options;
  }>,
  read: (
    c: PoolClient,
    access: PostgresCreativeProjectLegacyAccess,
  ) => Promise<Result>,
) {
  return (
    await readPostgresOwnedCreativeProject(
      input,
      call(input.request, input.options),
      async (c, access) => checked(input.options, await read(c, access)),
    )
  ).value;
}
function denied(): never {
  throw new Error("project_asset_stage_receipt_read_mismatch");
}
