import { ApplicationError } from "@crewon/application";
import {
  captureProjectGenerationPublications,
  type ProjectGenerationPublication,
} from "@crewon/domain";
import { pluginSecurityRecord } from "./plugin-security-validation.ts";

export type ProjectGenerationPluginConfiguration = Readonly<{
  publications: readonly ProjectGenerationPublication[];
}>;

export function captureProjectGenerationPluginConfiguration(
  input: unknown,
): ProjectGenerationPluginConfiguration | undefined {
  if (input === undefined) return undefined;
  const fields = pluginSecurityRecord(input, ["publications"]);
  return Object.freeze({
    publications: captureProjectGenerationPublications(fields.publications),
  });
}

/** Source publication is explicit UI deployment approval; target package approval still runs at invocation. */
export function assertProjectGenerationPluginPublications(
  configuration: ProjectGenerationPluginConfiguration | undefined,
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
      "project_generation_source_publication_unapproved",
    );
}

/** Validate optional paid generation composition before any database opens. */
export function assertProjectGenerationExecutionComposition(
  input: Readonly<{
    generations: ProjectGenerationPluginConfiguration | undefined;
    publications:
      | readonly Readonly<{ pluginId: string; packageDigest: string }>[]
      | undefined;
    taskConfiguration: unknown;
    uiConfiguration: unknown;
    ownedActions: unknown;
  }>,
): void {
  assertProjectGenerationPluginPublications(
    input.generations,
    input.publications,
  );
  if (
    input.generations !== undefined &&
    (input.taskConfiguration === undefined ||
      input.uiConfiguration === undefined ||
      input.ownedActions !== undefined)
  )
    throw new Error("project_generation_execution_composition_required");
}
