import type { ProjectMediaInputStageRunAdmission } from "@crewon/domain";
export type ProjectMediaInputStageRunLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  runId: string;
}>;
/** Explicitly migrated independent scope; a required marker never degrades into legacy authority. */
export interface ProjectMediaInputStageStore {
  readonly version: "crewon.project-media-input-stage-run-admission.v1";
  migrate(): Promise<void>;
  loadMediaInputStageAdmission(
    input: ProjectMediaInputStageRunLocator,
  ): Promise<ProjectMediaInputStageRunAdmission | null>;
  readRequiredMediaInputStageDigest(
    input: ProjectMediaInputStageRunLocator,
  ): Promise<string | null>;
}
