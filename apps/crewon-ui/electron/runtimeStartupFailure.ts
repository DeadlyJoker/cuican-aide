import { types } from "node:util";

/** Keep startup failures diagnosable without forwarding provider bodies, credentials or file paths. */
export function runtimeStartupFailureCode(error: unknown): string {
  if (!types.isNativeError(error)) return "runtime_startup_failed";
  const message = Object.getOwnPropertyDescriptor(error, "message");
  return message &&
    "value" in message &&
    typeof message.value === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/u.test(message.value)
    ? message.value
    : "runtime_startup_failed";
}
