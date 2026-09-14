import { readFileSync, statSync } from "node:fs";
import { parseAgentPlatformOrigin } from "./agentPlatformCredentials.ts";

/** Trust only the bounded manifest produced alongside the packaged renderer. */
export function readPackagedAccountOrigin(path: string): string {
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size > 2_048) {
    throw new Error("desktop_account_endpoint_invalid");
  }
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    value === null ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("accountOrigin" in value)
  ) {
    throw new Error("desktop_account_endpoint_invalid");
  }
  return parseAgentPlatformOrigin(value.accountOrigin);
}
