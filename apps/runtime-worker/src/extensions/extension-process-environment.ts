import { inspect } from "node:util";
import type {
  ActorContext,
  AuthorizationPort,
  AuthorizationAction,
} from "@crewon/application";
import { parseExtensionHostActor } from "@crewon/contracts";
import type { RuntimeWorkerSecurityMode } from "../runtime-provider-probe-environment.ts";
import type { RuntimeExtensionActorResolver } from "./extension-runtime-composition.ts";
import {
  parseExtensionExecutionMode,
  type ExtensionExecutionMode,
} from "./extension-work-item-scope.ts";

type Environment = Readonly<Record<string, string | undefined>>;
const EXECUTION_MODE = "CREWON_EXTENSION_EXECUTION_MODE";
const HOST_NAMES = [
  "CREWON_EXTENSION_HOST_PORT",
  "CREWON_EXTENSION_HOST_TOKEN",
  "CREWON_EXTENSION_HOST_DEADLINE_MS",
] as const;
const PATH_NAMES = [
  "CREWON_EXTENSION_RUNTIME_BINDINGS_PATH",
  "CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH",
] as const;
const ALLOWED_ACTIONS = new Set<AuthorizationAction>([
  "extension:read",
  "extension:run",
  "extension:query",
  "run:read",
  "run:execute",
  "agentVersion:read",
]);

export type RuntimeExtensionHostConfig = Readonly<{
  port: number;
  token: string;
  deadlineMs?: number;
  authorization: AuthorizationPort;
  resolveActor: RuntimeExtensionActorResolver;
}>;
export type RuntimeExtensionProcessEnvironment = Readonly<{
  actor: ActorContext;
  host: RuntimeExtensionHostConfig;
  runtimeBindingsPath: string | null;
  agentVersionAssetsPath: string | null;
  executionMode: ExtensionExecutionMode;
}>;

/** A single explicitly identified local owner; never an ambient production tenant authority. */
export function resolveRuntimeExtensionEnvironment(
  environment: Environment,
  securityMode: RuntimeWorkerSecurityMode,
): RuntimeExtensionProcessEnvironment | undefined {
  const flag = environment.CREWON_EXTENSIONS_ENABLED;
  if (flag !== undefined && flag !== "0" && flag !== "1") throw invalid();
  const hostDeclared = HOST_NAMES.some(
    (name) => environment[name] !== undefined,
  );
  const pathsDeclared = PATH_NAMES.some(
    (name) => environment[name] !== undefined,
  );
  const modeDeclared = environment[EXECUTION_MODE] !== undefined;
  if (securityMode === "production") {
    if (flag === "1" || hostDeclared || pathsDeclared || modeDeclared)
      throw new Error("CREWON_EXTENSION_CONFIGURATION_forbidden");
    return undefined;
  }
  if (modeDeclared && flag !== "1")
    throw new Error("extension_execution_mode_without_host");
  const executionMode = parseExtensionExecutionMode(
    environment[EXECUTION_MODE],
  );
  if (executionMode === "historical" && !pathsDeclared)
    throw new Error("extension_historical_runtime_required");
  if (pathsDeclared)
    for (const name of PATH_NAMES) path(required(environment, name));
  const enabled = flag === "1";
  if (!enabled && !hostDeclared) return undefined;
  const port = integer(required(environment, HOST_NAMES[0]), 0, 65535);
  const token = required(environment, HOST_NAMES[1]);
  if (
    Buffer.byteLength(token) < 32 ||
    Buffer.byteLength(token) > 8192 ||
    /[\u0000-\u0020\u007f]/u.test(token)
  )
    throw invalid();
  const deadlineMs =
    environment[HOST_NAMES[2]] === undefined
      ? undefined
      : integer(required(environment, HOST_NAMES[2]), 1000, 30000);
  if (!enabled) return undefined;
  const actor = parseExtensionHostActor({
    principalId: required(environment, "CREWON_PRINCIPAL_ID"),
    actorId: required(environment, "CREWON_ACTOR_ID"),
    tenantId: required(environment, "CREWON_TENANT_ID"),
    spaceId: required(environment, "CREWON_SPACE_ID"),
  });
  const authorization: AuthorizationPort = {
    authorize: async (request) =>
      ALLOWED_ACTIONS.has(request.action) &&
      request.resource.kind ===
        (request.action.startsWith("extension:")
          ? "extension"
          : request.action === "agentVersion:read"
            ? "agentVersion"
            : "run") &&
      sameActor(actor, request.actor) &&
      request.resource.tenantId === actor.tenantId &&
      request.resource.spaceId === actor.spaceId
        ? { outcome: "allow" }
        : {
            outcome: "deny",
            reasonCode: "standalone_extension_scope_mismatch",
          },
  };
  const resolveActor: RuntimeExtensionActorResolver = async (owner, signal) => {
    signal.throwIfAborted();
    return owner.tenantId === actor.tenantId &&
      owner.spaceId === actor.spaceId &&
      owner.actorId === actor.actorId
      ? actor
      : null;
  };
  const host = redact(
    Object.freeze({
      port,
      token,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      authorization,
      resolveActor,
    }),
  );
  return redact(
    Object.freeze({
      actor,
      host,
      executionMode,
      runtimeBindingsPath: pathsDeclared
        ? path(required(environment, PATH_NAMES[0]))
        : null,
      agentVersionAssetsPath: pathsDeclared
        ? path(required(environment, PATH_NAMES[1]))
        : null,
    }),
  );
}
function sameActor(left: ActorContext, right: ActorContext): boolean {
  return (
    left.principalId === right.principalId &&
    left.actorId === right.actorId &&
    left.tenantId === right.tenantId &&
    left.spaceId === right.spaceId
  );
}
function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value === "" || value !== value.trim())
    throw invalid();
  return value;
}
function path(value: string): string {
  if (Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f]/u.test(value))
    throw invalid();
  return value;
}
function integer(value: string, minimum: number, maximum: number): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw invalid();
  return parsed;
}
function redact<T extends object>(value: T): T {
  // Install before freezing: inspect must never print the private peer token.
  const copy = { ...value };
  Object.defineProperty(copy, inspect.custom, {
    value: () => "[RuntimeExtensionEnvironment]",
    enumerable: false,
  });
  return Object.freeze(copy) as T;
}
function invalid(): Error {
  return new Error("CREWON_EXTENSION_CONFIGURATION_invalid");
}
