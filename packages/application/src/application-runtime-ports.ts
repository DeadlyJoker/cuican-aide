export type ApplicationIdKind =
  | "run"
  | "runEvent"
  | "outboxMessage"
  | "workItem"
  | "outboxLease"
  | "thread"
  | "threadEvent"
  | "rollback"
  | "goal"
  | "proposedPlan"
  | "message"
  | "modelHistoryItem"
  | "attempt"
  | "approval"
  | "toolReceipt"
  | "toolExecution"
  | "artifact";

export interface ApplicationIdGenerator {
  nextId(kind: ApplicationIdKind): string;
}

export interface ApplicationClock {
  now(): string;
}

export interface ContentDigester {
  sha256(value: string): string;
}
