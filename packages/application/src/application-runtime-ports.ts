export type ApplicationIdKind =
  | "run"
  | "runEvent"
  | "outboxMessage"
  | "workItem"
  | "workflowSchedulerOperation"
  | "workflowExecutionValue"
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
  | "office"
  | "officeVersion"
  | "officeDelegation"
  | "artifact"
  | "knowledge";

export interface ApplicationIdGenerator {
  nextId(kind: ApplicationIdKind): string;
}

export interface ApplicationClock {
  now(): string;
}

export interface ContentDigester {
  sha256(value: string): string;
}
