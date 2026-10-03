import { ApplicationError } from "@crewon/application";
import {
  captureProjectQueryPublications,
  type ProjectQueryPublication,
} from "@crewon/domain";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

export type ProjectQueryPluginConfiguration = Readonly<{
  publications: readonly ProjectQueryPublication[];
}>;

export function captureProjectQueryPluginConfiguration(
  input: unknown,
): ProjectQueryPluginConfiguration | undefined {
  if (input === undefined) return undefined;
  const fields = pluginSecurityRecord(input, ["publications"]);
  return Object.freeze({
    publications: captureProjectQueryPublications(fields.publications),
  });
}

/** Source publication is explicit UI deployment approval; target package approval still runs at invocation. */
export function assertProjectQueryPluginPublications(
  configuration: ProjectQueryPluginConfiguration | undefined,
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
          (item) =>
            item.pluginId === source.pluginId &&
            item.packageDigest === source.packageDigest,
        ),
    )
  )
    throw new ApplicationError(
      "authorization",
      "project_query_source_publication_unapproved",
    );
}

/** Validate optional historical query composition before any database opens. */
export function assertProjectQueryExecutionComposition(
  input: Readonly<{
    queries: ProjectQueryPluginConfiguration | undefined;
    publications:
      | readonly Readonly<{ pluginId: string; packageDigest: string }>[]
      | undefined;
    taskConfiguration: unknown;
    uiConfiguration: unknown;
    ownedActions: unknown;
  }>,
): void {
  assertProjectQueryPluginPublications(input.queries, input.publications);
  if (
    input.queries !== undefined &&
    (input.taskConfiguration === undefined ||
      input.uiConfiguration === undefined ||
      input.ownedActions !== undefined)
  )
    throw new Error("project_query_execution_composition_required");
}
