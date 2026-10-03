import {
  assertProjectQueryExecutionPublication,
  parsePluginTaskAdmissionPin,
  parseProjectQueryPublication,
  type PluginTaskAdmissionPin,
  type ProjectQueryPublication,
  type ProjectQueryReference,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";
import { projectGenerationHostFields } from "./project-generation-execution-authority.ts";

/** Explicit current business UI and query execution owners; history grants neither. */
export type ProjectQueryExecutionPublication = Readonly<{
  publication: ProjectQueryPublication;
  sourcePin: PluginTaskAdmissionPin;
  executionPin: PluginTaskAdmissionPin;
}>;

export type ProjectQueryExecutionAuthority = Readonly<{
  /** Full preflight may read installed selections before a Store transaction. */
  assertCurrent(): Promise<void>;
  /** External identity, profile, policy and local lifetime only; no borrowed SQL connection. */
  assertTransactionCurrent(): Promise<void>;
  assertActive(): void;
}>;

export type CreatePublishedProjectQueryTaskInput =
  ProjectQueryExecutionPublication &
    Readonly<{
      actor: ActorContext;
      command: CreateExtensionTaskCommand;
      reference: ProjectQueryReference;
      authority: ProjectQueryExecutionAuthority;
    }>;

export function captureProjectQueryExecutionPublication(
  input: ProjectQueryExecutionPublication,
): ProjectQueryExecutionPublication {
  const value = projectGenerationHostFields(input, [
    "publication",
    "sourcePin",
    "executionPin",
  ]);
  const captured = Object.freeze({
    publication: parseProjectQueryPublication(value.publication),
    sourcePin: parsePluginTaskAdmissionPin(value.sourcePin),
    executionPin: parsePluginTaskAdmissionPin(value.executionPin),
  });
  assertProjectQueryExecutionPublication(captured);
  return captured;
}
