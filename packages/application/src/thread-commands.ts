import type { MessageRole } from "@crewon/domain";

export type CreateThreadCommand = Readonly<{
  kind: "thread.create";
  idempotencyKey: string;
  title: string | null;
}>;

export type AppendThreadMessageCommand = Readonly<{
  kind: "thread.message.append";
  idempotencyKey: string;
  threadId: string;
  expectedRevision: number;
  role: MessageRole;
  content: string;
}>;

export type ForkThreadCommand = Readonly<{
  kind: "thread.fork";
  idempotencyKey: string;
  sourceThreadId: string;
  expectedSourceRevision: number;
  throughHistorySequence: number | null;
}>;

export type ArchiveThreadCommand = Readonly<{
  kind: "thread.archive";
  idempotencyKey: string;
  threadId: string;
  expectedRevision: number;
}>;

export type UnarchiveThreadCommand = Readonly<{
  kind: "thread.unarchive";
  idempotencyKey: string;
  threadId: string;
  expectedRevision: number;
}>;

export type RenameThreadCommand = Readonly<{
  kind: "thread.rename";
  idempotencyKey: string;
  threadId: string;
  expectedRevision: number;
  title: string | null;
}>;

export type DeleteThreadCommand = Readonly<{
  kind: "thread.delete";
  idempotencyKey: string;
  threadId: string;
  expectedRevision: number;
}>;
