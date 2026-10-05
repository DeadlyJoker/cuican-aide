import {
  assertProjectHistoricalQueryExecutionPublication,
  parsePluginTaskAdmissionPin,
  parseProjectHistoricalQueryPublication,
  type PluginTaskAdmissionPin,
  type ProjectHistoricalQueryPublication,
  type ProjectQueryReference,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import { projectGenerationHostFields } from "./project-generation-execution-authority.ts";

/** Explicit current business UI and query execution owners; history grants neither. */
export type ProjectHistoricalQueryExecutionPublication = Readonly<{
  publication: ProjectHistoricalQueryPublication;
  sourcePin: PluginTaskAdmissionPin;
  executionPin: PluginTaskAdmissionPin;
}>;

export type ProjectHistoricalQueryExecutionAuthority = Readonly<{
  invocation: import("./plugin-project-historical-query-invocation.ts").PluginHistoricalQueryInvocationAuthority;
  /** Full preflight may read installed selections before a Store transaction. */
  assertCurrent(): Promise<void>;
  /** External identity, profile, policy and local lifetime only; no borrowed SQL connection. */
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;

export type CreateHistoricalPublishedProjectQueryTaskInput =
  ProjectHistoricalQueryExecutionPublication &
    Readonly<{
      actor: ActorContext;
      command: CreateExtensionTaskCommand;
      reference: ProjectQueryReference;
      authority: ProjectHistoricalQueryExecutionAuthority;
    }>;

export function captureProjectHistoricalQueryExecutionPublication(
  input: ProjectHistoricalQueryExecutionPublication,
): ProjectHistoricalQueryExecutionPublication {
  const value = projectGenerationHostFields(input, [
    "publication",
    "sourcePin",
    "executionPin",
  ]);
  const captured = Object.freeze({
    publication: parseProjectHistoricalQueryPublication(value.publication),
    sourcePin: parsePluginTaskAdmissionPin(value.sourcePin),
    executionPin: parsePluginTaskAdmissionPin(value.executionPin),
  });
  assertProjectHistoricalQueryExecutionPublication(captured);
  return captured;
}
