import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  assertPluginTaskRunReceipt,
  assertPluginTaskRunSnapshot,
} from "@crewon/application";
import { qualifyProjectAssetRuntimeReadObservation } from "@crewon/application/host-project-workspaces";
import {
  extensionCanonicalJson,
  parsePluginSelection,
  parseInstalledPluginPackage,
  parseExtensionConfiguration,
  parseExtensionRunBinding,
  parseExtensionActivation,
  parsePluginProjectWorkspaceOwner,
  type ProjectAssetStageRunAdmission,
} from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import {
  loadSqlitePluginTask,
  loadPostgresPluginTask,
} from "./plugin-task-admission-store-support.ts";
import {
  projectRunSnapshotQuery,
  projectRunBindingQuery,
  projectRunJson,
} from "./creative-project-run-commit-support.ts";
import {
  decodePostgresRunState,
  type PostgresRunRow,
} from "./postgres-run-codec.ts";
import {
  decodeAssetStage,
  sqliteRequiredAssetStageDigest,
  postgresRequiredAssetStageDigest,
} from "./project-asset-stage-markers.ts";
import { parseExtensionTurnReceipt } from "./extension-store-records.ts";
import { decodeConversation } from "./project-conversation-store-support.ts";
import {
  assertSqlitePluginProjectWorkspaceBinding,
  assertPostgresPluginProjectWorkspaceBinding,
} from "./plugin-project-workspace-thread-fence.ts";
import {
  assertSqlitePluginProjectWorkspaceMetadata,
  assertPostgresPluginProjectWorkspaceMetadata,
} from "./plugin-project-workspace-metadata-fence.ts";
import { captureSqliteOwnedProjectAccess } from "./plugin-project-owned-read-sqlite.ts";
import { capturePostgresOwnedProjectAccess } from "./plugin-project-owned-read-postgres.ts";
import {
  captureSqliteCreativeProjectLegacyAccess,
  capturePostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import {
  readSqliteRunComposition,
  readPostgresRunComposition,
} from "./plugin-run-composition-store-support.ts";
import {
  verifySqliteUnmeteredReceipt,
  verifyPostgresUnmeteredReceipt,
} from "./plugin-task-unmetered-store-support.ts";
import {
  decodeExtensionCreditAdmission,
  assertExtensionCreditAdmissionLink,
} from "./extension-credit-admission-records.ts";
import {
  decodeCreditReservation,
  assertCreditReservationReplay,
  creditScopeValues,
} from "./plugin-credit-support.ts";
import { validateThreadState, type ThreadState } from "@crewon/domain";

type Source = ReturnType<typeof qualifyProjectAssetRuntimeReadObservation>;
type Row = Record<string, unknown>;
const values = (s: Source) => [
  s.admission.tenantId,
  s.admission.spaceId,
  s.admission.profileId,
  s.admission.pluginId,
  s.admission.packageDigest,
];
function records(
  s: Source,
  admission: unknown,
  runRow: Row | undefined,
  original: Row | undefined,
  selectionRow: Row | undefined,
  packageRow: Row | undefined,
  activationRow: Row | undefined,
  receiptRow: Row | undefined,
) {
  s.assertActive();
  if (
    !runRow ||
    !original ||
    !selectionRow ||
    !packageRow ||
    !activationRow ||
    !receiptRow ||
    extensionCanonicalJson(admission) !== extensionCanonicalJson(s.admission) ||
    receiptRow.request_digest !== s.receipt.requestDigest
  )
    denied();
  const binding = parseExtensionRunBinding(
      projectRunJson(original.binding_json),
      creativeStoreDigester,
    ),
    cfg = parseExtensionConfiguration(
      projectRunJson(original.configuration_json),
      creativeStoreDigester,
    );
  if (
    extensionCanonicalJson(binding) !== extensionCanonicalJson(s.binding) ||
    cfg.tenantId !== binding.tenantId ||
    cfg.spaceId !== binding.spaceId ||
    cfg.pluginId !== binding.pluginId ||
    cfg.contentDigest !== binding.configurationDigest ||
    cfg.revision !== binding.configurationRevision ||
    cfg.pluginVersion !== s.admission.version
  )
    denied();
  const selection = parsePluginSelection(
      projectRunJson(selectionRow.record_json),
    ),
    pkg = parseInstalledPluginPackage(projectRunJson(packageRow.record_json)),
    activation = parseExtensionActivation(
      projectRunJson(activationRow.activation_json),
    );
  for (const field of [
    "tenantId",
    "spaceId",
    "profileId",
    "pluginId",
    "publisherId",
  ] as const)
    if (
      selection[field] !== s.admission[field] ||
      pkg[field] !== s.admission[field]
    )
      denied();
  if (
    pkg.packageDigest !== s.admission.packageDigest ||
    pkg.version !== s.admission.version ||
    selection.revision < s.admission.selectionRevision ||
    (selection.revision === s.admission.selectionRevision &&
      (selection.state !== "enabled" ||
        selection.selectedPackageDigest !== s.admission.packageDigest)) ||
    (s.purpose === "submit" && selection.state !== "enabled")
  )
    denied();
  for (const [key, field] of Object.entries({
    tenant_id: "tenantId",
    space_id: "spaceId",
    profile_id: "profileId",
    plugin_id: "pluginId",
    publisher_id: "publisherId",
    revision: "revision",
    state: "state",
    selected_package_digest: "selectedPackageDigest",
  }))
    if (
      String(selectionRow[key]) !==
      String(selection[field as keyof typeof selection])
    )
      denied();
  for (const [key, field] of Object.entries({
    tenant_id: "tenantId",
    space_id: "spaceId",
    profile_id: "profileId",
    plugin_id: "pluginId",
    publisher_id: "publisherId",
    package_digest: "packageDigest",
    version: "version",
  }))
    if (String(packageRow[key]) !== String(pkg[field as keyof typeof pkg]))
      denied();
  if (
    activation.tenantId !== s.actor.tenantId ||
    activation.spaceId !== s.actor.spaceId ||
    activation.pluginId !== s.admission.pluginId ||
    activation.state === "revoked" ||
    (s.purpose === "submit" && activation.state !== "enabled") ||
    Number(activationRow.revision) !== activation.revision ||
    Number(activationRow.configuration_revision) !==
      activation.configurationRevision
  )
    denied();
  const run = decodePostgresRunState(
    {
      ...runRow,
      state_json: projectRunJson(runRow.state_json),
    } as unknown as PostgresRunRow,
    s.binding,
  );
  assertPluginTaskRunSnapshot(run, binding, s.run, denied);
  if (
    run.revision < s.run.revision ||
    (s.purpose === "submit" &&
      (run.cancelRequested ||
        ["completed", "canceled", "failed"].includes(run.status)))
  )
    denied();
  const receipt = parseExtensionTurnReceipt(
    projectRunJson(receiptRow.result_json),
    s.binding,
    s.receipt,
  );
  const created = assertPluginTaskRunReceipt(
    receipt,
    s.binding,
    s.admission,
    s.receipt,
    null,
    { fail: denied, digester: creativeStoreDigester },
  );
  assertPluginTaskRunSnapshot(run, binding, created, denied);
  return receipt;
}
function stageOwner(
  s: Source,
  stage: ProjectAssetStageRunAdmission | null,
  required: string | null,
) {
  if (required !== (stage?.contentDigest ?? null)) denied();
  if (stage === null) return null;
  if (
    extensionCanonicalJson(stage.actor) !== extensionCanonicalJson(s.actor) ||
    stage.runId !== s.binding.runId ||
    stage.threadId !== s.binding.threadId ||
    stage.requestDigest !== s.receipt.requestDigest ||
    stage.idempotencyKey !== s.receipt.idempotencyKey ||
    stage.extensionBindingDigest !== s.binding.bindingDigest ||
    stage.userContentDigest !== s.binding.inputDigest ||
    stage.pluginTaskAdmissionDigest !==
      creativeStoreDigester.sha256(extensionCanonicalJson(s.admission))
  )
    denied();
  for (const k of [
    "tenantId",
    "spaceId",
    "profileId",
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
    "selectionRevision",
  ] as const)
    if (stage.installation[k] !== s.admission[k]) denied();
  return parsePluginProjectWorkspaceOwner({
    ...s.owner,
    projectId: stage.projectId,
  });
}
function bound(
  s: Source,
  stage: ProjectAssetStageRunAdmission,
  b: ReturnType<typeof decodeConversation>,
  threadRow: Row | undefined,
) {
  if (
    !b ||
    !threadRow ||
    b.state !== "active" ||
    b.bindingId !== stage.bindingId ||
    b.revision !== stage.bindingRevision ||
    b.projectId !== stage.projectId ||
    b.threadId !== stage.threadId ||
    b.workspaceId !== stage.workspaceId ||
    extensionCanonicalJson(b.currentInstallation) !==
      extensionCanonicalJson(stage.installation) ||
    extensionCanonicalJson(b.owner) !== extensionCanonicalJson(s.actor)
  )
    denied();
  for (const k of [
    "tenantId",
    "spaceId",
    "profileId",
    "pluginId",
    "publisherId",
  ] as const)
    if (b.currentInstallation[k] !== s.admission[k]) denied();
  const t = projectRunJson(threadRow.state_json) as ThreadState;
  validateThreadState(t);
  if (
    t.tenantId !== s.actor.tenantId ||
    t.spaceId !== s.actor.spaceId ||
    t.threadId !== stage.threadId ||
    t.createdByActorId !== s.actor.actorId ||
    t.status !== "active" ||
    (t.workspaceId ?? null) !== stage.workspaceId ||
    threadRow.project_conversation_binding_id !== b.bindingId ||
    threadRow.tenant_id !== t.tenantId ||
    threadRow.space_id !== t.spaceId ||
    threadRow.thread_id !== t.threadId ||
    threadRow.created_by_actor_id !== t.createdByActorId ||
    threadRow.status !== t.status ||
    Number(threadRow.revision) !== t.revision
  )
    denied();
  return b;
}
const receiptValues = (s: Source) => [
  s.actor.tenantId,
  s.actor.spaceId,
  s.admission.pluginId,
  s.receipt.actorId,
  s.receipt.idempotencyKey,
];
export function proveSqliteAssetRuntimeRead(db: DatabaseSync, s: Source) {
  if (!db.isTransaction) denied();
  const get = (sql: string, v: readonly (string | number)[]) =>
    db.prepare(sql).get(...v);
  const l = s.binding;
  const receipt = records(
    s,
    loadSqlitePluginTask(db, l),
    get(projectRunSnapshotQuery("").replaceAll(/\$[12]/gu, "?"), [
      l.tenantId,
      l.runId,
    ]),
    get(projectRunBindingQuery("").replaceAll(/\$[12]/gu, "?"), [
      l.tenantId,
      l.runId,
    ]),
    get(
      "SELECT * FROM plugin_profile_selections WHERE tenant_id=? AND space_id=? AND profile_id=? AND plugin_id=?",
      values(s).slice(0, 4),
    ),
    get(
      "SELECT * FROM installed_plugin_packages WHERE tenant_id=? AND space_id=? AND profile_id=? AND package_digest=?",
      [...values(s).slice(0, 3), s.admission.packageDigest],
    ),
    get(
      "SELECT * FROM extension_activations WHERE tenant_id=? AND space_id=? AND plugin_id=?",
      [l.tenantId, l.spaceId, l.pluginId],
    ),
    get(
      "SELECT * FROM extension_mutation_receipts WHERE tenant_id=? AND space_id=? AND plugin_id=? AND kind='task' AND actor_id=? AND idempotency_key=?",
      receiptValues(s),
    ),
  );
  readSqliteRunComposition(db, s.binding);
  verifySqliteUnmeteredReceipt(db, receipt);
  if (receipt.creditAdmission) {
    const a = receipt.creditAdmission;
    assertExtensionCreditAdmissionLink({
      admission: a,
      linked: decodeExtensionCreditAdmission(
        get(
          "SELECT * FROM extension_credit_admissions WHERE tenant_id=? AND space_id=? AND run_id=?",
          [l.tenantId, l.spaceId, l.runId],
        ) as never,
      ),
    });
    const reserve = decodeCreditReservation(
      get(
        "SELECT reservation_id,idempotency_key,record_json FROM plugin_credit_reservations WHERE tenant_id=? AND principal_id=? AND pool_id=? AND reservation_id=?",
        [
          ...creditScopeValues(a.reservation.scope),
          a.reservation.reservationId,
        ],
      ) as never,
      a.reservation.scope,
    );
    if (!reserve) denied();
    assertCreditReservationReplay(reserve, a.reservation);
  }
  const required = sqliteRequiredAssetStageDigest(db, l),
    stage =
      required === null
        ? null
        : decodeAssetStage(
            get(
              "SELECT * FROM project_asset_stage_run_admissions WHERE tenant_id=? AND run_id=?",
              [l.tenantId, l.runId],
            ),
            l,
          ),
    o = stageOwner(s, stage, required);
  if (o === null)
    return { access: captureSqliteCreativeProjectLegacyAccess(db), stage };
  const b = bound(
    s,
    stage!,
    decodeConversation(
      get(
        "SELECT * FROM project_conversation_bindings WHERE tenant_id=? AND space_id=? AND binding_id=?",
        [l.tenantId, l.spaceId, stage!.bindingId],
      ),
    ),
    get("SELECT * FROM threads WHERE tenant_id=? AND thread_id=?", [
      l.tenantId,
      l.threadId,
    ]),
  );
  assertSqlitePluginProjectWorkspaceBinding(db, b);
  const access =
    assertSqlitePluginProjectWorkspaceMetadata(db, o) === "protected"
      ? captureSqliteOwnedProjectAccess(db, { scope: o })
      : captureSqliteCreativeProjectLegacyAccess(db);
  access.assertProject(o);
  s.assertActive();
  return { access, stage };
}
export async function provePostgresAssetRuntimeRead(
  c: PoolClient,
  schema: string,
  s: Source,
) {
  const p = `${creativeProjectSchemaName(schema)}.`,
    l = s.binding;
  const one = async (sql: string, v: readonly (string | number)[]) =>
    (await c.query(sql, [...v])).rows[0];
  const required = await postgresRequiredAssetStageDigest(c, schema, l),
    stage =
      required === null
        ? null
        : decodeAssetStage(
            await one(
              `SELECT * FROM ${p}project_asset_stage_run_admissions WHERE tenant_id=$1 AND run_id=$2`,
              [l.tenantId, l.runId],
            ),
            l,
          );
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `run:${l.tenantId}:${l.runId}`,
  ]);
  const receipt = records(
    s,
    await loadPostgresPluginTask(c, schema, l),
    await one(`${projectRunSnapshotQuery(p)} FOR SHARE OF s`, [
      l.tenantId,
      l.runId,
    ]),
    await one(projectRunBindingQuery(p), [l.tenantId, l.runId]),
    await one(
      `SELECT * FROM ${p}plugin_profile_selections WHERE tenant_id=$1 AND space_id=$2 AND profile_id=$3 AND plugin_id=$4 FOR SHARE`,
      values(s).slice(0, 4),
    ),
    await one(
      `SELECT * FROM ${p}installed_plugin_packages WHERE tenant_id=$1 AND space_id=$2 AND profile_id=$3 AND package_digest=$4 FOR SHARE`,
      [...values(s).slice(0, 3), s.admission.packageDigest],
    ),
    await one(
      `SELECT * FROM ${p}extension_activations WHERE tenant_id=$1 AND space_id=$2 AND plugin_id=$3 FOR SHARE`,
      [l.tenantId, l.spaceId, l.pluginId],
    ),
    await one(
      `SELECT * FROM ${p}extension_mutation_receipts WHERE tenant_id=$1 AND space_id=$2 AND plugin_id=$3 AND kind='task' AND actor_id=$4 AND idempotency_key=$5 FOR SHARE`,
      receiptValues(s),
    ),
  );
  if (stage)
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([
        "creative-project-project",
        schema,
        l.tenantId,
        l.spaceId,
        stage.projectId,
      ]),
    ]);
  await readPostgresRunComposition(c, schema, s.binding);
  await verifyPostgresUnmeteredReceipt(c, schema, receipt);
  if (receipt.creditAdmission) {
    const a = receipt.creditAdmission;
    assertExtensionCreditAdmissionLink({
      admission: a,
      linked: decodeExtensionCreditAdmission(
        await one(
          `SELECT * FROM ${p}extension_credit_admissions WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3`,
          [l.tenantId, l.spaceId, l.runId],
        ),
      ),
    });
    const reserve = decodeCreditReservation(
      await one(
        `SELECT reservation_id,idempotency_key,record_json FROM ${p}plugin_credit_reservations WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3 AND reservation_id=$4`,
        [
          ...creditScopeValues(a.reservation.scope),
          a.reservation.reservationId,
        ],
      ),
      a.reservation.scope,
    );
    if (!reserve) denied();
    assertCreditReservationReplay(reserve, a.reservation);
  }
  const o = stageOwner(s, stage, required);
  if (o === null)
    return {
      access: await capturePostgresCreativeProjectLegacyAccess(c, schema),
      stage,
    };
  const b = bound(
    s,
    stage!,
    decodeConversation(
      await one(
        `SELECT * FROM ${p}project_conversation_bindings WHERE tenant_id=$1 AND space_id=$2 AND binding_id=$3 FOR SHARE`,
        [l.tenantId, l.spaceId, stage!.bindingId],
      ),
    ),
    await one(
      `SELECT * FROM ${p}threads WHERE tenant_id=$1 AND thread_id=$2 FOR SHARE`,
      [l.tenantId, l.threadId],
    ),
  );
  await assertPostgresPluginProjectWorkspaceBinding(c, schema, b);
  const access =
    (await assertPostgresPluginProjectWorkspaceMetadata(c, schema, o)) ===
    "protected"
      ? await capturePostgresOwnedProjectAccess(c, schema, { scope: o })
      : await capturePostgresCreativeProjectLegacyAccess(c, schema);
  await access.assertProject(o);
  s.assertActive();
  return { access, stage };
}
function denied(code = "project_asset_runtime_read_changed"): never {
  throw new Error(code);
}
