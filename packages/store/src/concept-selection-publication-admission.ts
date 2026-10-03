import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { ProjectConceptSelectionCommandSource } from "@crewon/application";
import {
  admitPostgresPluginInstallationPin,
  admitSqlitePluginInstallationPin,
  assertPostgresPluginInstallationPinSchema,
  assertSqlitePluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";
import { assertCreativeProjectPluginCommitSelection } from "./creative-project-plugin-commit-support.ts";

export async function admitPostgresConceptSelectionSource(
  client: PoolClient,
  schema: string,
  source: ProjectConceptSelectionCommandSource,
): Promise<void> {
  switch (source.kind) {
    case "authenticated-project-command":
      return;
    case "installed-plugin-ui": {
      await assertPostgresPluginInstallationPinSchema(client, schema);
      const current = await admitPostgresPluginInstallationPin(
        client,
        schema,
        source.publication.sourcePin,
      );
      assertCreativeProjectPluginCommitSelection(source.publication, current);
      return;
    }
  }
}
export function admitSqliteConceptSelectionSource(
  database: DatabaseSync,
  source: ProjectConceptSelectionCommandSource,
): void {
  switch (source.kind) {
    case "authenticated-project-command":
      return;
    case "installed-plugin-ui": {
      assertSqlitePluginInstallationPinSchema(database);
      const current = admitSqlitePluginInstallationPin(
        database,
        source.publication.sourcePin,
      );
      assertCreativeProjectPluginCommitSelection(source.publication, current);
      return;
    }
  }
}
