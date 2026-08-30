import type { RunRoute } from "./run-commands.ts";

export type StartThreadCompactionRequestCommand = Readonly<{
  kind: "thread.compact";
  idempotencyKey: string;
  threadId: string;
  expectedThreadRevision: number;
  requestedAgentVersionId: string | null;
}>;

export type StartThreadCompactionCommand = StartThreadCompactionRequestCommand &
  Readonly<{ route: RunRoute }>;
