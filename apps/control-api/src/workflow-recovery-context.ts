import { createHash } from "node:crypto";
import {
  ApplicationError,
  canonicalJson,
  captureWorkflowDeploymentConfiguration,
  type ActorContext,
  type WorkflowDeploymentConfiguration,
} from "@crewon/application";
import { parseWorkflowRecoveryContextId } from "@crewon/contracts";
import { WorkflowRecoveryContextUnavailableError } from "./control-api-errors.ts";

/** Captured deployment identity is stable across process restarts, not across policy changes. */
export class WorkflowRecoveryContext {
  readonly #deployment: string;
  constructor(input: {
    configuration: WorkflowDeploymentConfiguration;
    namespace: string;
  }) {
    if (!input.namespace || input.namespace.length > 256)
      throw new Error("workflow_recovery_namespace_invalid");
    this.#deployment = canonicalJson({
      version: "crewon.workflow-recovery-context.v1",
      namespace: input.namespace,
      configuration: captureWorkflowDeploymentConfiguration(
        input.configuration,
      ),
    });
  }
  read(actor: ActorContext): string {
    const captured: Record<string, string> = {};
    for (const key of [
      "tenantId",
      "spaceId",
      "actorId",
      "principalId",
    ] as const) {
      const field = Object.getOwnPropertyDescriptor(actor, key);
      if (
        !field ||
        !Object.hasOwn(field, "value") ||
        typeof field.value !== "string" ||
        !field.value.trim() ||
        field.value.length > 512
      )
        throw new ApplicationError(
          "authorization",
          "workflow_recovery_actor_invalid",
        );
      captured[key] = field.value;
    }
    return `sha256:${createHash("sha256")
      .update(canonicalJson({ deployment: this.#deployment, actor: captured }))
      .digest("hex")}`;
  }
}

/** Omission preserves old callers. Supplied context must be checked by the mutation's actual request actor. */
export function assertWorkflowRecoveryContext(input: {
  context: WorkflowRecoveryContext | null | undefined;
  actor: ActorContext;
  expected: unknown;
}): void {
  if (input.expected === undefined) return;
  const expected = parseWorkflowRecoveryContextId(input.expected);
  if (!input.context) throw new WorkflowRecoveryContextUnavailableError();
  if (input.context.read(input.actor) !== expected)
    throw new ApplicationError("conflict", "workflow_recovery_context_changed");
}

/** Versioned mutation aliases cannot proceed without the comparison token. */
export function requireWorkflowRecoveryContext(
  input: Parameters<typeof assertWorkflowRecoveryContext>[0],
): void {
  assertWorkflowRecoveryContext({
    ...input,
    expected: parseWorkflowRecoveryContextId(input.expected),
  });
}
