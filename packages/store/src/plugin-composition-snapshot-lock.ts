import { PLUGIN_COMPOSITION_ENABLED_ENTRY_FUNCTION_BODY } from "./plugin-composition-schema.ts";
import { compositionStoreFail } from "./plugin-composition-store-records.ts";
import type { Client, PoolClient } from "pg";
import {
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
/** Distinct from the dedicated owner's exclusive session lease: Run readers must not wait for that lease to end. */
export async function lockPostgresCompositionSnapshot(input: {
  client: Pick<Client | PoolClient, "query">;
  schema: string;
  scope: PluginProfileScope;
  mode: "read" | "write";
}): Promise<void> {
  pluginInstallationSchemaName(input.schema);
  const scope = parsePluginProfileScope(input.scope);
  const fn =
    input.mode === "read"
      ? "pg_advisory_xact_lock_shared"
      : "pg_advisory_xact_lock";
  await input.client.query(
    `SELECT ${fn}(hashtextextended(jsonb_build_array('plugin-composition-snapshot.v1',$1::text,$2::text,$3::text,$4::text)::text,0))`,
    [input.schema, scope.tenantId, scope.spaceId, scope.profileId],
  );
}

/** An older v1 metadata schema is readable, but cannot admit a graph until its phantom fence is installed and enabled. */
export async function assertPostgresCompositionSnapshotSchema(
  client: Pick<Client | PoolClient, "query">,
  schema: string,
): Promise<void> {
  const result = await client.query<{ prosrc: string }>(
    `SELECT p.prosrc FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class r ON r.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname=$1 AND r.relname='plugin_profile_selections' AND t.tgname='plugin_composition_enabled_entry' AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgtype=23 AND t.tgnargs=0 AND t.tgattr::text='' AND pn.nspname=$1 AND p.proname='reserve_composition_enabled_entry' AND current_setting('session_replication_role')='origin'`,
    [schema],
  );
  if (
    result.rows.length !== 1 ||
    result.rows[0]?.prosrc !== PLUGIN_COMPOSITION_ENABLED_ENTRY_FUNCTION_BODY
  )
    compositionStoreFail("plugin_composition_snapshot_schema_invalid");
}
