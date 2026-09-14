import type {
  SkillInvocationSpec,
  SkillMethod,
  SkillRecordingSource,
  SkillVersion,
  SkillVersionRef,
} from "@crewon/domain";
import type { StartTurnCommand } from "./turn-commands.ts";
export type SkillScope = Readonly<{
  tenantId: string;
  spaceId: string;
  ownerActorId: string;
}>;
export type SkillLocator = SkillScope & Readonly<{ skillId: string }>;
export type DemonstratedSkillRecord = SkillLocator &
  Readonly<{
    revision: number;
    draft: SkillMethod;
    source: SkillRecordingSource;
    disabled: boolean;
    deleted: boolean;
    activatedVersionIds: readonly string[];
    createdAt: string;
    updatedAt: string;
  }>;
export type SkillTrialReview = Readonly<{
  confirmedAt: string;
  resultNote: string;
  criteria: readonly string[];
  coverage: readonly ("new-date" | "new-input" | "handled-exception")[];
}>;
export type SkillExecutionRecord = SkillLocator &
  Readonly<{
    executionId: string;
    invocation: SkillInvocationSpec;
    purpose: "trial" | "execute";
    command: StartTurnCommand;
    runId: string | null;
    review: SkillTrialReview | null;
    createdAt: string;
  }>;
export interface DemonstratedSkillStore {
  getSkill(locator: SkillLocator): Promise<DemonstratedSkillRecord | null>;
  listSkills(
    scope: SkillScope,
    query: { after: string | null; limit: number },
  ): Promise<readonly DemonstratedSkillRecord[]>;
  saveSkill(
    record: DemonstratedSkillRecord,
    expectedRevision: number,
  ): Promise<void>;
  putVersion(locator: SkillLocator, version: SkillVersion): Promise<void>;
  getVersion(
    locator: SkillLocator,
    ref: SkillVersionRef,
  ): Promise<SkillVersion | null>;
  listVersions(locator: SkillLocator): Promise<readonly SkillVersion[]>;
  putExecution(record: SkillExecutionRecord): Promise<SkillExecutionRecord>;
  getExecution(
    locator: SkillLocator,
    executionId: string,
  ): Promise<SkillExecutionRecord | null>;
  bindExecutionRun(
    locator: SkillLocator,
    executionId: string,
    runId: string,
  ): Promise<void>;
  reviewExecution(
    locator: SkillLocator,
    executionId: string,
    review: SkillTrialReview,
  ): Promise<void>;
  findExecutionByRun(
    scope: SkillScope,
    runId: string,
  ): Promise<SkillExecutionRecord | null>;
  findReviewedTrial(
    locator: SkillLocator,
    ref: SkillVersionRef,
  ): Promise<SkillExecutionRecord | null>;
  listExecutions(
    locator: SkillLocator,
  ): Promise<readonly SkillExecutionRecord[]>;
}
