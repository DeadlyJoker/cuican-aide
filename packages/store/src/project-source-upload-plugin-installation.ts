import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  ApplicationError,
  qualifyProjectSourceUploadPluginCommit,
  type ProjectSourceUploadCommitAuthority,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  admitPostgresPluginInstallationPin,
  admitSqlitePluginInstallationPin,
  assertPostgresPluginInstallationPinSchema,
  assertSqlitePluginInstallationPinSchema,
} from "./plugin-installation-pin-store-support.ts";

/** Only trusted host tests/recipes may opt out. Production constructors leave it unset. */
export type SourceUploadInstallationAdmission = "trusted-internal-authority";
export function captureSourceUploadInstallationAdmission(
  input: SourceUploadInstallationAdmission | undefined,
) {
  if (input !== undefined && input !== "trusted-internal-authority")
    throw new Error("project_source_upload_installation_admission_invalid");
  return input;
}
export function qualifySourceUploadInstallation(
  authority: ProjectSourceUploadCommitAuthority,
  admission: SourceUploadInstallationAdmission | undefined,
  mutation: boolean,
) {
  const qualification = qualifyProjectSourceUploadPluginCommit(authority);
  if (
    mutation &&
    qualification === undefined &&
    admission !== "trusted-internal-authority"
  )
    throw new ApplicationError(
      "authorization",
      "project_source_upload_plugin_commit_authority_required",
    );
  return qualification;
}
export function admitSqliteSourceUploadInstallation(
  database: DatabaseSync,
  authority: ProjectSourceUploadCommitAuthority,
  admission: SourceUploadInstallationAdmission | undefined,
  mutation: boolean,
): void {
  const qualification = qualifySourceUploadInstallation(
    authority,
    admission,
    mutation,
  );
  if (qualification === undefined) return;
  assertSqlitePluginInstallationPinSchema(database);
  const actual = admitSqlitePluginInstallationPin(database, qualification.pin);
  equal(actual.selection, qualification.selection);
  equal(actual.package, qualification.package);
}
export async function admitPostgresSourceUploadInstallation(
  client: PoolClient,
  schema: string,
  authority: ProjectSourceUploadCommitAuthority,
  admission: SourceUploadInstallationAdmission | undefined,
  mutation: boolean,
): Promise<void> {
  const qualification = qualifySourceUploadInstallation(
    authority,
    admission,
    mutation,
  );
  if (qualification === undefined) return;
  await assertPostgresPluginInstallationPinSchema(client, schema);
  const actual = await admitPostgresPluginInstallationPin(
    client,
    schema,
    qualification.pin,
  );
  equal(actual.selection, qualification.selection);
  equal(actual.package, qualification.package);
}
function equal(actual: unknown, expected: unknown): void {
  if (extensionCanonicalJson(actual) !== extensionCanonicalJson(expected))
    throw new Error("project_source_upload_plugin_commit_selection_mismatch");
}
