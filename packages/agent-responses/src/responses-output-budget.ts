import { protocolError } from "./responses-errors.ts";

/** Undefined preserves the exact legacy wire shape; no implicit ceiling or gateway fallback. */
export function parseResponsesOutputTokenLimit(
  value: unknown,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw protocolError("responses_max_output_tokens_invalid");
  return value;
}
