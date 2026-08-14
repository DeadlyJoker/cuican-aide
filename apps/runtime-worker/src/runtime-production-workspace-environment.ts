import { isAbsolute } from "node:path";

import type { RuntimeNativeWorkspaceBootstrap } from "./runtime-native-bootstrap.ts";
import {
  validateRuntimeWorkspaceDispatchAuthority,
  type RuntimeWorkspaceDispatchAuthority,
} from "./runtime-workspace-binding-resolver.ts";
import type { RuntimeWorkerSecurityMode } from "./runtime-provider-probe-environment.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const CONFIG = "CREWON_RUNTIME_WORKSPACE_CONFIG_JSON";
const LEGACY_FLAG = "CREWON_NATIVE_WORKSPACE_READ_ENABLED";
const SCHEMA = "crewon.runtime-workspace.v0";
const MAX_CONFIG_BYTES = 64 * 1_024;

/** Parses one Team Workspace deployment without accepting desktop bootstrap flags. */
export function resolveRuntimeProductionWorkspaceEnvironment(
  environment: Environment,
  securityMode: RuntimeWorkerSecurityMode,
): RuntimeNativeWorkspaceBootstrap | undefined {
  const encoded = environment[CONFIG];
  if (securityMode === "standalone") {
    if (encoded !== undefined) throw new Error(`${CONFIG}_forbidden`);
    return undefined;
  }
  if (environment[LEGACY_FLAG] !== undefined) {
    throw new Error(`${LEGACY_FLAG}_forbidden`);
  }
  if (encoded === undefined) return undefined;
  if (
    encoded.length === 0 ||
    encoded !== encoded.trim() ||
    Buffer.byteLength(encoded, "utf8") > MAX_CONFIG_BYTES
  ) {
    throw invalid();
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (cause) {
    throw invalid(cause);
  }
  if (
    !record(value) ||
    !exactKeys(value, [
      "authority",
      "deadlineMs",
      "privateServer",
      "schemaVersion",
      "trustedLocalPath",
    ]) ||
    value.schemaVersion !== SCHEMA ||
    typeof value.trustedLocalPath !== "string" ||
    !isAbsolute(value.trustedLocalPath) ||
    value.trustedLocalPath !== value.trustedLocalPath.trim() ||
    value.trustedLocalPath.includes("\0") ||
    Buffer.byteLength(value.trustedLocalPath, "utf8") > 8_192 ||
    !integer(value.deadlineMs, 1_000, 60_000) ||
    !record(value.privateServer) ||
    !exactKeys(value.privateServer, ["port", "tokenEnvironment"]) ||
    !integer(value.privateServer.port, 1, 65_535) ||
    !environmentName(value.privateServer.tokenEnvironment) ||
    !record(value.authority)
  ) {
    throw invalid();
  }
  try {
    const expected = value.authority as RuntimeWorkspaceDispatchAuthority;
    return {
      trustedLocalPath: value.trustedLocalPath,
      deadlineMs: value.deadlineMs,
      privateServer: {
        port: value.privateServer.port,
        token: secret(environment[value.privateServer.tokenEnvironment]),
      },
      authority: validateRuntimeWorkspaceDispatchAuthority(
        value.authority,
        expected,
      ),
    };
  } catch (cause) {
    throw invalid(cause);
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function environmentName(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)
  );
}

function secret(value: string | undefined): string {
  if (value === undefined) throw invalid();
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 32 || bytes > 8_192 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalid();
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(cause?: unknown): Error {
  return new Error(`${CONFIG}_invalid`, { cause });
}
