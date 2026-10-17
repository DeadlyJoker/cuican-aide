import { ApplicationError } from "./application-error.ts";
import { RunStoreError } from "./run-store-port.ts";

export async function callWorkflowHumanGateStore<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    if (error instanceof RunStoreError) {
      const kind = error.code.includes("authorization")
        ? "authorization"
        : error.code === "workflow_gate_not_found"
          ? "notFound"
          : error.code.endsWith("_conflict") ||
              error.code === "workflow_gate_not_decidable"
            ? "conflict"
            : "internal";
      throw new ApplicationError(kind, error.code, { cause: error });
    }
    throw new ApplicationError("internal", "workflow_gate_store_failed", {
      cause: error,
    });
  }
}
