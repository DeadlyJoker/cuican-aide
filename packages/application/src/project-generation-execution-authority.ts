import {
  assertProjectGenerationExecutionPublication,
  parsePluginTaskAdmissionPin,
  parseProjectGenerationPublication,
  type PluginTaskAdmissionPin,
  type ProjectGenerationPublication,
  type ProjectGenerationReference,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import type { CreateExtensionTaskCommand } from "./extension-task-application-service.ts";

/** Host-only qualification. Installation and permission are checked separately by the actual owners. */
export type ProjectGenerationExecutionPublication = Readonly<{
  publication: ProjectGenerationPublication;
  sourcePin: PluginTaskAdmissionPin;
  executionPin: PluginTaskAdmissionPin;
}>;

/** Distinguishes pool-backed preflight from checks permitted while the Store owns its transaction. */
export type ProjectGenerationExecutionAuthority = Readonly<{
  /** Full source invocation and target owner fence; may use the ordinary Store before a transaction. */
  assertCurrent(): Promise<void>;
  /** Current external identity/policy and local owner checks only; never acquires another DB connection. */
  assertTransactionCurrent(): Promise<void>;
  /** Captured original invocation and execution owner withdrawal; must finish synchronously. */
  assertActive(): void;
}>;

export type CreatePublishedProjectTaskInput =
  ProjectGenerationExecutionPublication &
    Readonly<{
      actor: ActorContext;
      command: CreateExtensionTaskCommand;
      reference: ProjectGenerationReference;
      authority: ProjectGenerationExecutionAuthority;
    }>;

export function captureProjectGenerationExecutionPublication(
  input: ProjectGenerationExecutionPublication,
): ProjectGenerationExecutionPublication {
  const value = projectGenerationHostFields(input, [
    "publication",
    "sourcePin",
    "executionPin",
  ]);
  const publication = parseProjectGenerationPublication(value.publication);
  const sourcePin = parsePluginTaskAdmissionPin(value.sourcePin);
  const executionPin = parsePluginTaskAdmissionPin(value.executionPin);
  const captured = Object.freeze({ publication, sourcePin, executionPin });
  assertProjectGenerationExecutionPublication(captured);
  return captured;
}

/** Internal shallow envelope: callback ports remain separate from all JSON recipes. */
export function projectGenerationHostFields(
  input: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new ApplicationError(
      "validation",
      "project_generation_host_input_invalid",
    );
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new ApplicationError(
      "validation",
      "project_generation_host_input_invalid",
    );
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        )
          throw new ApplicationError(
            "validation",
            "project_generation_host_input_invalid",
          );
        return [field, descriptor.value as unknown] as const;
      }),
    ),
  );
}
