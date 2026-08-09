export type RollbackThreadCommand = Readonly<{
  kind: "thread.rollback";
  idempotencyKey: string;
  threadId: string;
  expectedRevision: number;
  numTurns: number;
}>;
