import { createHash } from "node:crypto";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Single-conversation fixture evidence; no prompt bodies survive a request. */
export function soakPrefixAudit() {
  let previous: {
    configuration: string;
    input: string;
    length: number;
  } | null = null;
  let comparisons = 0,
    matchingPrefixes = 0,
    configurationChanges = 0,
    deltaRequests = 0;
  return {
    observe(request: Record<string, unknown>) {
      if (!Array.isArray(request.input))
        throw new Error("soak_prefix_input_invalid");
      const configuration = digest([
        request.model,
        request.instructions ?? null,
        request.tools ?? null,
      ]);
      if (request.previous_response_id) {
        deltaRequests++;
        previous = null;
        return;
      }
      if (previous) {
        if (configuration !== previous.configuration) configurationChanges++;
        else {
          comparisons++;
          if (
            request.input.length >= previous.length &&
            digest(request.input.slice(0, previous.length)) === previous.input
          )
            matchingPrefixes++;
        }
      }
      previous = {
        configuration,
        input: digest(request.input),
        length: request.input.length,
      };
    },
    snapshot: () => ({
      comparisons,
      matchingPrefixes,
      configurationChanges,
      deltaRequests,
      scope: "single-conversation-input-array-and-configuration",
      realCacheHitRate: null,
    }),
  };
}
