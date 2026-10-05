import type { ProjectAssetStageRunAdmission } from "@crewon/domain";
export type ProjectAssetStageRunLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  runId: string;
}>;
/** Explicitly migrated independent scope; a required marker never degrades into legacy authority. */
export interface ProjectAssetStageStore {
  readonly version: "crewon.project-asset-stage-run-admission.v1";
  migrate(): Promise<void>;
  loadAssetStageAdmission(
    input: ProjectAssetStageRunLocator,
  ): Promise<ProjectAssetStageRunAdmission | null>;
  readRequiredAssetStageDigest(
    input: ProjectAssetStageRunLocator,
  ): Promise<string | null>;
}
