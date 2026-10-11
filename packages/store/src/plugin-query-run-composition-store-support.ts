import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { PreparedPluginTaskModelSelection } from "@crewon/application";
import {
  assertPluginQueryTaskAdmission,
  type ExtensionRunBinding,
  type PluginQueryTaskAdmission,
} from "@crewon/domain";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
import {
  lockPostgresRunComposition,
  readPostgresRunComposition,
  readSqliteRunComposition,
} from "./plugin-run-composition-store-support.ts";

export type ExtensionCompositionAdmissionOptions = Readonly<{
  modelSelection?: PreparedPluginTaskModelSelection;
  queryAdmission?: PluginQueryTaskAdmission;
}>;

function assertSource(
  binding: ExtensionRunBinding,
  admission: PluginQueryTaskAdmission,
  sourceJson: unknown,
): void {
  if (sourceJson == null) throw new Error("plugin_query_source_invalid");
  assertPluginQueryTaskAdmission(
    {
      binding,
      admission,
      sourceBinding: (typeof sourceJson === "string"
        ? JSON.parse(sourceJson)
        : sourceJson) as ExtensionRunBinding,
      receipt: {
        actorId: admission.actorId,
        requestDigest: admission.requestDigest,
        idempotencyKey: admission.idempotencyKey,
      },
    },
    extensionStoreDigester,
  );
}

/** Query admission has already checked current permission, original funding and operation in this transaction. */
export function admitSqliteQueryRunComposition(
  db: DatabaseSync,
  binding: ExtensionRunBinding,
  admission: PluginQueryTaskAdmission,
) {
  const row = db
    .prepare(
      "SELECT binding_json FROM extension_run_bindings WHERE tenant_id=? AND space_id=? AND run_id=?",
    )
    .get(binding.tenantId, binding.spaceId, admission.source.runId);
  assertSource(binding, admission, row?.binding_json);
  // The original lock is immutable. A query never reads or admits today's head or enabled graph.
  return readSqliteRunComposition(db, binding);
}

export async function admitPostgresQueryRunComposition(
  client: PoolClient,
  schema: string,
  binding: ExtensionRunBinding,
  admission: PluginQueryTaskAdmission,
) {
  await lockPostgresRunComposition(client, schema, binding);
  const prefix = pluginInstallationSchemaName(schema);
  const row = (
    await client.query(
      `SELECT binding_json FROM ${prefix}.extension_run_bindings WHERE tenant_id=$1 AND space_id=$2 AND run_id=$3`,
      [binding.tenantId, binding.spaceId, admission.source.runId],
    )
  ).rows[0];
  assertSource(binding, admission, row?.binding_json);
  return readPostgresRunComposition(client, schema, binding);
}
