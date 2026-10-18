import type { RunRoute } from "./run-commands.ts";
import type { TeamTaskWriteFence } from "./team-task-journal.ts";

export type StartTurnRequestCommand = Readonly<{
  kind: "turn.start";
  idempotencyKey: string;
  executionIntentVersion?: "v1";
  threadId: string;
  expectedThreadRevision: number;
  content: string;
  requestedAgentVersionId: string | null;
  executionIntent: "none" | "goal" | "plan" | "resumeGoal";
  toolPermissionMode?: import("@crewon/domain").RunToolPermissionMode;
  teamTaskFence?: TeamTaskWriteFence;
}>;

export type StartTurnCommand = StartTurnRequestCommand &
  Readonly<{ route: RunRoute }>;
