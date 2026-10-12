import { lockPostgresCreativeProjectLegacySchema } from "./creative-project-legacy-access.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { assertPluginTaskRunSnapshot } from "@crewon/application";
import {
  qualifyPluginProjectRuntimeObservation,
  type PluginProjectRuntimeObservation,
} from "@crewon/application/host-project-workspaces";
import {
  extensionCanonicalJson,
  parseExtensionRunBinding,
  type ProjectFoundationRunAdmission,
} from "@crewon/domain";
import {
  loadSqlitePluginTask,
  loadPostgresPluginTask,
} from "./plugin-task-admission-store-support.ts";
import {
  loadSqliteStageIfAvailable,
  loadPostgresStageIfAvailable,
} from "./project-stage-run-store-support.ts";
import {
  projectRunBindingQuery,
  projectRunSnapshotQuery,
  projectRunJson,
} from "./creative-project-run-commit-support.ts";
import {
  decodePostgresRunState,
  type PostgresRunRow,
} from "./postgres-run-codec.ts";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { captureSqliteOwnedProjectAccess } from "./plugin-project-owned-read-sqlite.ts";
import { capturePostgresOwnedProjectAccess } from "./plugin-project-owned-read-postgres.ts";

function denied(): never {
  throw new Error("plugin_project_runtime_observation_facts_mismatch");
}
type Source = ReturnType<typeof qualifyPluginProjectRuntimeObservation>;
export function assertRuntimeFoundationPair(
  source: Source,
  value: ProjectFoundationRunAdmission | null,
) {
  if (value === null) return;
  if (
    value.projectStageAdmissionDigest !== source.stage.contentDigest ||
    extensionCanonicalJson(value.actor) !==
      extensionCanonicalJson(source.stage.actor) ||
    extensionCanonicalJson(value.installation) !==
      extensionCanonicalJson(source.stage.installation) ||
    (
      [
        "runId",
        "threadId",
        "projectId",
        "bindingId",
        "bindingRevision",
        "workspaceId",
        "userContentDigest",
        "taskInputDigest",
        "pluginTaskAdmissionDigest",
        "extensionBindingDigest",
        "requestDigest",
        "idempotencyKey",
      ] as const
    ).some((k) => value[k] !== source.stage[k])
  )
    denied();
}
export function runtimeFoundationLocator(source: Source) {
  return {
    tenantId: source.actor.tenantId,
    spaceId: source.actor.spaceId,
    runId: source.binding.runId,
  };
}
function check(
  source: Source,
  task: unknown,
  stage: unknown,
  bindingRow: Record<string, unknown> | undefined,
  runRow: Record<string, unknown> | undefined,
) {
  source.assertActive();
  if (
    extensionCanonicalJson(task) !== extensionCanonicalJson(source.admission) ||
    extensionCanonicalJson(stage) !== extensionCanonicalJson(source.stage) ||
    !bindingRow ||
    !runRow
  )
    denied();
  const binding = parseExtensionRunBinding(
    projectRunJson(bindingRow.binding_json),
    creativeStoreDigester,
  );
  if (
    extensionCanonicalJson(binding) !== extensionCanonicalJson(source.binding)
  )
    denied();
  const run = decodePostgresRunState(
    {
      ...runRow,
      state_json: projectRunJson(runRow.state_json),
    } as unknown as PostgresRunRow,
    runtimeFoundationLocator(source),
  );
  // Validate Run ownership/target against the actual admitted binding; this is not a Tool execution or lease grant.
  assertPluginTaskRunSnapshot(run, binding, run, denied);
  source.assertActive();
}
/** Same original transaction as the paired read; no new pool, Store or artifact capability. */
export function sqliteRuntimeFoundationAccess(
  db: DatabaseSync,
  ref: PluginProjectRuntimeObservation,
) {
  if (!db.isTransaction)
    throw new Error("plugin_project_runtime_observation_transaction_required");
  const s = qualifyPluginProjectRuntimeObservation(ref),
    locator = runtimeFoundationLocator(s);
  check(
    s,
    loadSqlitePluginTask(db, locator),
    loadSqliteStageIfAvailable(db, locator),
    db
      .prepare(projectRunBindingQuery("").replaceAll(/\$[12]/gu, "?"))
      .get(locator.tenantId, locator.runId),
    db
      .prepare(projectRunSnapshotQuery("").replaceAll(/\$[12]/gu, "?"))
      .get(locator.tenantId, locator.runId),
  );
  const projectAccess = captureSqliteOwnedProjectAccess(db, { scope: s.owner });
  projectAccess.assertProject({ ...s.actor, projectId: s.stage.projectId });
  return { projectAccess };
}
export async function postgresRuntimeFoundationAccess(
  c: PoolClient,
  schema: string,
  ref: PluginProjectRuntimeObservation,
) {
  await lockPostgresCreativeProjectLegacySchema(c, schema);
  const s = qualifyPluginProjectRuntimeObservation(ref),
    locator = runtimeFoundationLocator(s),
    p = `${creativeProjectSchemaName(schema)}.`;
  check(
    s,
    await loadPostgresPluginTask(c, schema, locator),
    await loadPostgresStageIfAvailable(c, schema, locator),
    (
      await c.query(projectRunBindingQuery(p), [
        locator.tenantId,
        locator.runId,
      ])
    ).rows[0],
    (
      await c.query(projectRunSnapshotQuery(p), [
        locator.tenantId,
        locator.runId,
      ])
    ).rows[0],
  );
  const projectAccess = await capturePostgresOwnedProjectAccess(c, schema, {
    scope: s.owner,
  });
  await projectAccess.assertProject({ projectId: s.stage.projectId });
  s.assertActive();
  return { projectAccess };
}
