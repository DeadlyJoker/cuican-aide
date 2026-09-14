import type { SkillMethod } from "@crewon/domain";
import type { SkillLocator } from "./demonstrated-skill-store-port.ts";
import type { StartTurnCommand } from "./turn-commands.ts";

export type SkillDraftGenerationRecord = SkillLocator &
  Readonly<{
    generationId: string;
    expectedSkillRevision: number;
    command: StartTurnCommand;
    runId: string | null;
    startMessageId: string | null;
    startMessageSequence: number | null;
    outcome: "pending" | "candidate" | "invalid";
    candidate: SkillMethod | null;
    reasonCode: string | null;
    verification: "real" | "simulated" | "unknown";
    outputMessageId: string | null;
    completedAt: string | null;
    applyRequested: boolean;
    appliedRevision: number | null;
    createdAt: string;
  }>;
export type SkillDraftGenerationResult = Pick<
  SkillDraftGenerationRecord,
  | "outcome"
  | "candidate"
  | "reasonCode"
  | "verification"
  | "outputMessageId"
  | "completedAt"
>;
/** Immutable request and append-only result, bounded to 20 generations per Skill. */
export interface SkillDraftGenerationStore {
  putGeneration(
    record: SkillDraftGenerationRecord,
  ): Promise<SkillDraftGenerationRecord>;
  getGeneration(
    locator: SkillLocator,
    generationId: string,
  ): Promise<SkillDraftGenerationRecord | null>;
  listGenerations(
    locator: SkillLocator,
  ): Promise<readonly SkillDraftGenerationRecord[]>;
  bindGenerationRun(
    locator: SkillLocator,
    generationId: string,
    binding: {
      runId: string;
      startMessageId: string;
      startMessageSequence: number;
    },
  ): Promise<void>;
  finishGeneration(
    locator: SkillLocator,
    generationId: string,
    result: SkillDraftGenerationResult,
  ): Promise<void>;
  requestGenerationApply(
    locator: SkillLocator,
    generationId: string,
  ): Promise<void>;
  markGenerationApplied(
    locator: SkillLocator,
    generationId: string,
    appliedRevision: number,
  ): Promise<void>;
}
