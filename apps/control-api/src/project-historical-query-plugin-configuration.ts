import { ApplicationError } from "@crewon/application";
import {
  captureProjectHistoricalQueryPublications,
  type ProjectHistoricalQueryPublication,
} from "@crewon/domain";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";
export type ProjectHistoricalQueryPluginConfiguration = Readonly<{
  version: "crewon.desktop-project-historical-query.v1";
  publications: readonly ProjectHistoricalQueryPublication[];
}>;
export function captureProjectHistoricalQueryPluginConfiguration(
  input: unknown,
): ProjectHistoricalQueryPluginConfiguration | undefined {
  if (input === undefined) return undefined;
  const fields = pluginSecurityRecord(input, ["version", "publications"]);
  if (fields.version !== "crewon.desktop-project-historical-query.v1")
    throw new Error("project_historical_query_configuration_invalid");
  return Object.freeze({
    version: fields.version,
    publications: captureProjectHistoricalQueryPublications(
      fields.publications,
    ),
  });
}
export function assertProjectHistoricalQueryPluginPublications(
  configuration: ProjectHistoricalQueryPluginConfiguration | undefined,
  approved:
    | readonly Readonly<{ pluginId: string; packageDigest: string }>[]
    | undefined,
): void {
  if (configuration === undefined) return;
  if (
    approved === undefined ||
    configuration.publications.some(
      ({ source }) =>
        !approved.some(
          (p) =>
            p.pluginId === source.pluginId &&
            p.packageDigest === source.packageDigest,
        ),
    )
  )
    throw new ApplicationError(
      "authorization",
      "project_historical_query_source_publication_unapproved",
    );
}
