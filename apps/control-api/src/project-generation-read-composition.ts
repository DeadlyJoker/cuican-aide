import {
  ExtensionReadApplicationService,
  ProjectGenerationReadApplicationService,
  type ContentDigester,
  type ExtensionStore,
} from "@crewon/application";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";

export type ProjectGenerationReadConfiguration = Readonly<{
  version: "crewon.project-generation-read.v1";
}>;
export type ProjectGenerationReadStore = ExtensionStore & {
  enableProjectGenerationReads(): Promise<void>;
};

export function captureProjectGenerationReadConfiguration(
  input: unknown,
): ProjectGenerationReadConfiguration | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("project_generation_read_configuration_invalid");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !== 1 ||
    !Object.hasOwn(fields, "version") ||
    !fields.version!.enumerable ||
    !Object.hasOwn(fields.version!, "value") ||
    fields.version!.value !== "crewon.project-generation-read.v1"
  )
    throw new Error("project_generation_read_configuration_invalid");
  return Object.freeze({ version: "crewon.project-generation-read.v1" });
}

/** Cold history must already exist. The adapter verifies it without creating a schema or enabling writes. */
export async function prepareProjectGenerationReadStore(
  owner: Readonly<{ extensionStore?(): ProjectGenerationReadStore }>,
): Promise<ProjectGenerationReadStore> {
  const createStore = owner.extensionStore?.bind(owner);
  if (createStore === undefined)
    throw new Error("project_generation_read_composition_required");
  const extensions = createStore();
  await extensions.enableProjectGenerationReads();
  return extensions;
}

/** Uses the original real task reader; its bound HTTP request owner remains the authority. */
export function composeProjectGenerationReadService(
  input: Readonly<{
    projects: PreparedCreativeProjects | undefined;
    extensions: ExtensionStore | undefined;
    tasks: ExtensionReadApplicationService | undefined;
    digester: ContentDigester;
  }>,
): ProjectGenerationReadApplicationService | undefined {
  if (
    input.projects?.generationReads === undefined &&
    input.projects?.pluginGenerations === undefined
  )
    return undefined;
  if (
    input.projects === undefined ||
    input.extensions === undefined ||
    !(input.tasks instanceof ExtensionReadApplicationService)
  )
    throw new Error("project_generation_read_composition_required");
  return new ProjectGenerationReadApplicationService({
    projects: input.projects.service,
    tasks: input.tasks,
    extensions: input.extensions,
    digester: input.digester,
  });
}
