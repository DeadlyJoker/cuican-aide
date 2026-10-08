import type { ProjectFoundationRunAdmission } from "@crewon/domain";

export type ProjectFoundationRunLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  runId: string;
}>;

/** Immutable host facts issued beside the original Turn. Reading them grants no Node operation. */
export interface ProjectFoundationRunAdmissionStore {
  readRequiredFoundationDigest(
    locator: ProjectFoundationRunLocator,
  ): Promise<string | null>;
  loadFoundationRunAdmission(
    locator: ProjectFoundationRunLocator,
  ): Promise<ProjectFoundationRunAdmission | null>;
}
