import type { RunRoute } from "./run-commands.ts";

export type StartTurnRequestCommand = Readonly<{
  kind: "turn.start";
  idempotencyKey: string;
  threadId: string;
  expectedThreadRevision: number;
  content: string;
  requestedAgentVersionId: string | null;
  executionIntent: "none" | "goal" | "plan" | "resumeGoal";
}>;

export type StartTurnCommand = StartTurnRequestCommand &
  Readonly<{ route: RunRoute }>;
