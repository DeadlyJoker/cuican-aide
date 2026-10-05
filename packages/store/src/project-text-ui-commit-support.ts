import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  projectTextUiMutationCommand,
  type ActorContext,
  type CreativeProjectCommitAuthority,
  type CreativeProjectMutationReceipt,
  type ProjectTextMutationKind,
  type ProjectTextUiCommitTransactionAuthority,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import { creativeStoreDigester } from "./creative-project-store-records.ts";
import { pluginInstallationSchemaName } from "./plugin-installation-schema.ts";
import {
  assertSqlitePluginInstallationPinSchema,
  assertPostgresPluginInstallationPinSchema,
  admitSqliteProjectToolInstallationPin,
  admitPostgresProjectToolInstallationPin,
} from "./plugin-installation-pin-store-support.ts";
import { assertCreativeProjectPluginCommitSelection } from "./creative-project-plugin-commit-support.ts";
import type { TextPrepared } from "./project-text-store-support.ts";

export type ProjectTextUiQualification =
  ProjectTextUiCommitTransactionAuthority;
export function projectTextUiCommitQualification(
  authority: CreativeProjectCommitAuthority | undefined,
  actor: ActorContext,
  kind: ProjectTextMutationKind,
  receipt: CreativeProjectMutationReceipt,
  prepared?: TextPrepared,
): ProjectTextUiQualification | undefined {
  const q = authority?.textUiTransaction;
  if (q === undefined) return undefined;
  const expected = projectTextUiMutationCommand(q, creativeStoreDigester);
  if (
    extensionCanonicalJson(actor) !== extensionCanonicalJson(q.actor) ||
    kind !== expected.kind ||
    receipt.idempotencyKey !== expected.receipt.idempotencyKey ||
    receipt.requestDigest !== expected.receipt.requestDigest
  )
    denied();
  if (prepared !== undefined) {
    const command = expected.command;
    if (
      prepared.project.projectId !== command.projectId ||
      prepared.expectedArtifactRevision !== command.expectedArtifactRevision
    )
      denied();
    if (kind === "save-outline" || kind === "save-script") {
      if (
        !("contentRevision" in prepared) ||
        !("content" in command) ||
        !("briefRevision" in command) ||
        prepared.contentRevision.brief.briefRevision !==
          command.briefRevision ||
        extensionCanonicalJson(prepared.contentRevision.content) !==
          extensionCanonicalJson(command.content)
      )
        denied();
      if (kind === "save-script") {
        if (
          !("outline" in command) ||
          !("episodeId" in command) ||
          prepared.contentRevision.episodeId !== command.episodeId
        )
          denied();
        const outline = prepared.contentRevision.outline;
        if (
          command.outline === null
            ? outline !== null
            : outline === null ||
              outline.artifactId !== command.outline.artifactId ||
              outline.contentRevision !== command.outline.contentRevision
        )
          denied();
      }
    } else {
      if (
        !("artifactId" in command) ||
        prepared.artifact.artifactId !== command.artifactId
      )
        denied();
      if (
        kind === "set-lock" &&
        (!("locked" in command) || prepared.artifact.locked !== command.locked)
      )
        denied();
      if (
        kind === "select-revision" &&
        (!("contentRevision" in command) ||
          !("contentRevision" in prepared) ||
          prepared.contentRevision.contentRevision !== command.contentRevision)
      )
        denied();
    }
  }
  return q;
}

const installationTables = [
  "plugin_installation_schema_version",
  "installed_plugin_packages",
  "plugin_profile_selections",
] as const;

/** No Run/credit schema is needed; these are the three original installation tables. */
export function assertSqliteProjectTextUiCommit(
  database: DatabaseSync,
  q: ProjectTextUiQualification | undefined,
): void {
  if (q === undefined) return;
  for (const table of installationTables) {
    const rows = database
      .prepare(
        "SELECT type FROM main.sqlite_schema WHERE name=? UNION ALL SELECT type FROM temp.sqlite_schema WHERE name=?",
      )
      .all(table, table);
    if (rows.length !== 1 || rows[0]?.type !== "table") denied();
  }
  assertSqlitePluginInstallationPinSchema(database);
  assertCreativeProjectPluginCommitSelection(
    q,
    admitSqliteProjectToolInstallationPin(database, q.installation),
  );
}

/** Full selection/package locks live on the already borrowed text transaction connection. */
export async function assertPostgresProjectTextUiCommit(
  client: PoolClient,
  schema: string,
  q: ProjectTextUiQualification | undefined,
): Promise<void> {
  if (q === undefined) return;
  // Validate the configured schema string without search_path or another connection.
  pluginInstallationSchemaName(schema);
  const rows = (
    await client.query<{ relname: string; relkind: string }>(
      "SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
      [schema, installationTables],
    )
  ).rows;
  if (
    rows.length !== installationTables.length ||
    installationTables.some(
      (name) =>
        !rows.some((row) => row.relname === name && row.relkind === "r"),
    )
  )
    denied();
  await assertPostgresPluginInstallationPinSchema(client, schema);
  assertCreativeProjectPluginCommitSelection(
    q,
    await admitPostgresProjectToolInstallationPin(
      client,
      schema,
      q.installation,
    ),
  );
}
function denied(): never {
  throw new Error("project_text_ui_commit_pin_mismatch");
}
