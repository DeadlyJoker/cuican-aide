import { ApplicationError } from "./application-error.ts";

/** Whitespace is meaningful output and may arrive as its own streaming delta. */
export function requireStreamContent(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApplicationError("validation", code);
  }
  return value;
}
