import type { RunRoute } from "./run-commands.ts";

export type StartTurnRequestCommand = Readonly<{
  kind: "turn.start";
  /** Host-only binding, verified atomically by supported stores; absent for ordinary turns. */
  skillExecution?: Readonly<{ skillId: string; executionId: string }>;
  idempotencyKey: string;
  executionIntentVersion?: "v1";
  threadId: string;
  expectedThreadRevision: number;
  content: string;
  requestedAgentVersionId: string | null;
  executionIntent: "none" | "goal" | "plan" | "resumeGoal";
  toolPermissionMode?: import("@crewon/domain").RunToolPermissionMode;
}>;

export type StartTurnCommand = StartTurnRequestCommand &
  Readonly<{ route: RunRoute }>;
