import type { ProjectAssetStageRunAdmission } from "@crewon/domain";
export type ProjectAssetStageRunLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  runId: string;
}>;
/** Explicitly migrated independent scope; a required marker never degrades into legacy authority. */
export interface ProjectAssetStageStore {
  readonly version: "crewon.project-asset-stage-run-admission.v1";
  bindProjectReads?(
    scope: import("./plugin-project-read-scope.ts").PluginProjectReadScope,
  ): ProjectAssetStageStore;
  migrate(): Promise<void>;
  loadAssetStageAdmission(
    input: ProjectAssetStageRunLocator,
    options?: Readonly<{
      projectAssetRuntimeReadObservation: import("./project-asset-runtime-read-observation.ts").ProjectAssetRuntimeReadObservation;
    }>,
  ): Promise<ProjectAssetStageRunAdmission | null>;
  readRequiredAssetStageDigest(
    input: ProjectAssetStageRunLocator,
    options?: Readonly<{
      projectAssetRuntimeReadObservation: import("./project-asset-runtime-read-observation.ts").ProjectAssetRuntimeReadObservation;
    }>,
  ): Promise<string | null>;
}
