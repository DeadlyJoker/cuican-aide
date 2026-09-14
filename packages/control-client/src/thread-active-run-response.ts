import type { GetThreadActiveRunResponse } from "@crewon/contracts";
import { parseRunView, RunViewValidationError } from "./run-view.ts";

export function parseThreadActiveRunResponse(
  input: unknown,
  threadId: string,
): GetThreadActiveRunResponse {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new RunViewValidationError();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3 ||
    value.schemaVersion !== "crewon.thread-active-run.v0" ||
    value.threadId !== threadId ||
    !("run" in value)
  )
    throw new RunViewValidationError();
  const run = value.run === null ? null : parseRunView(value.run, threadId);
  if (run !== null && ["completed", "failed", "canceled"].includes(run.status))
    throw new RunViewValidationError();
  return { schemaVersion: "crewon.thread-active-run.v0", threadId, run };
}
