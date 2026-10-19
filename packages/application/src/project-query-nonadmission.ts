import { ApplicationError } from "./application-error.ts";
import type { PluginTaskAdmissionPin } from "@crewon/domain";
import type { ContentDigester } from "./application-runtime-ports.ts";
import { projectGenerationQueryUiTaskKey } from "./project-query-task-receipt.ts";
import type { ProjectGenerationQueryUiInput } from "@crewon/contracts/plugins";

type Proof = Readonly<{
  threadId: string;
  expectedThreadRevision: number;
  taskKey: string;
}>;
const proofs = new WeakMap<object, Proof>();

/** Internal: called only after the actual thread has advanced and a subsequent receipt lookup is empty. */
export function queryRevisionNotAdmitted(
  proof: Proof,
  cause: unknown,
): ApplicationError {
  const error = new ApplicationError(
    "conflict",
    "project_query_revision_not_admitted",
    { cause },
  );
  proofs.set(error, Object.freeze({ ...proof }));
  return error;
}

export function isQueryRevisionNotAdmitted(
  error: unknown,
  request: ProjectGenerationQueryUiInput,
  sourcePin: PluginTaskAdmissionPin,
  digester: ContentDigester,
): boolean {
  if (!error || typeof error !== "object") return false;
  const proof = proofs.get(error);
  return (
    proof !== undefined &&
    proof.threadId === request.threadId &&
    proof.expectedThreadRevision === request.expectedThreadRevision &&
    proof.taskKey ===
      projectGenerationQueryUiTaskKey(
        { sourcePin, idempotencyKey: request.idempotencyKey },
        digester,
      )
  );
}
