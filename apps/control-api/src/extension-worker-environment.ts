import { inspect } from "node:util";
import type { ActorContext } from "@crewon/application";
import { parseExtensionHostActor } from "@crewon/contracts";
import { parseLoopbackExtensionHostConfig } from "./extension-worker-client.ts";

type Environment = Readonly<Record<string, string | undefined>>;
export type ControlExtensionWorkerEnvironment = Readonly<{
  actor: ActorContext;
  extensionWorker: Readonly<{
    origin: string;
    token: string;
    deadlineMs?: number;
  }>;
}>;
const ENABLED = "CREWON_EXTENSIONS_ENABLED";
const ORIGIN = "CREWON_EXTENSION_HOST_ORIGIN";
const TOKEN = "CREWON_EXTENSION_HOST_TOKEN";
const DEADLINE = "CREWON_EXTENSION_HOST_DEADLINE_MS";
const PEER_NAMES = [ORIGIN, TOKEN, DEADLINE] as const;

/** Only explicit standalone ownership can opt in to the authenticated local Worker host. */
export function resolveControlExtensionWorkerEnvironment(
  environment: Environment,
  securityMode: "standalone" | "production",
): ControlExtensionWorkerEnvironment | undefined {
  const enabled = environment[ENABLED];
  if (enabled !== undefined && enabled !== "0" && enabled !== "1")
    throw new Error(`${ENABLED}_invalid`);
  const peerDeclared = PEER_NAMES.some(
    (name) => environment[name] !== undefined,
  );
  if (securityMode === "production") {
    if (enabled === "1" || peerDeclared)
      throw new Error("CREWON_EXTENSION_HOST_CONFIGURATION_forbidden");
    return undefined;
  }
  let extensionWorker:
    | ControlExtensionWorkerEnvironment["extensionWorker"]
    | undefined;
  if (peerDeclared || enabled === "1") {
    const origin = requiredExact(environment, ORIGIN);
    const token = requiredExact(environment, TOKEN);
    const rawDeadline = environment[DEADLINE];
    const deadlineMs =
      rawDeadline === undefined ? undefined : parseDeadline(rawDeadline);
    const checked = parseLoopbackExtensionHostConfig({
      origin,
      token,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    });
    extensionWorker = redact(
      Object.freeze({
        origin: checked.origin,
        token: checked.token,
        ...(deadlineMs === undefined ? {} : { deadlineMs: checked.deadlineMs }),
      }),
    );
  }
  if (enabled !== "1") return undefined;
  if (extensionWorker === undefined)
    throw new Error("CREWON_EXTENSION_HOST_CONFIGURATION_incomplete");
  let actor: ActorContext;
  try {
    actor = parseExtensionHostActor({
      principalId: requiredExact(environment, "CREWON_PRINCIPAL_ID"),
      actorId: requiredExact(environment, "CREWON_ACTOR_ID"),
      tenantId: requiredExact(environment, "CREWON_TENANT_ID"),
      spaceId: requiredExact(environment, "CREWON_SPACE_ID"),
    });
  } catch (error) {
    throw new Error("CREWON_EXTENSION_HOST_OWNER_invalid", { cause: error });
  }
  return redact(Object.freeze({ actor, extensionWorker }));
}

function requiredExact(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0)
    throw new Error("CREWON_EXTENSION_HOST_CONFIGURATION_incomplete");
  if (value !== value.trim()) throw new Error(`${name}_invalid`);
  return value;
}
function parseDeadline(value: string): number {
  if (!/^[1-9]\d{3,4}$/u.test(value)) throw new Error(`${DEADLINE}_invalid`);
  const parsed = Number(value);
  if (parsed < 1000 || parsed > 30000) throw new Error(`${DEADLINE}_invalid`);
  return parsed;
}
function redact<T extends object>(input: T): T {
  // Clone before attaching the inspection hook; callers may already freeze their bounded config.
  const value = { ...input };
  Object.defineProperty(value, inspect.custom, {
    value: () => "[ControlExtensionWorkerEnvironment]",
    enumerable: false,
  });
  return Object.freeze(value) as T;
}
