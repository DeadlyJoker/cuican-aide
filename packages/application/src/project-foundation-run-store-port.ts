import type { PluginProjectRuntimeObservation } from "./plugin-project-runtime-observation.ts";
import type { ProjectFoundationRunAdmission } from "@crewon/domain";

export type ProjectFoundationRunLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  runId: string;
}>;

/** Immutable host facts issued beside the original Turn. Reading them grants no Node operation. */
export interface ProjectFoundationRunAdmissionStore {
  /** Private backend paired metadata only; locator comes from the genuine runtime observation. */
  loadRuntimeFoundationRunAdmission?(
    observation: PluginProjectRuntimeObservation,
  ): Promise<ProjectFoundationRunAdmission | null>;
  readRequiredFoundationDigest(
    locator: ProjectFoundationRunLocator,
  ): Promise<string | null>;
  loadFoundationRunAdmission(
    locator: ProjectFoundationRunLocator,
  ): Promise<ProjectFoundationRunAdmission | null>;
}
