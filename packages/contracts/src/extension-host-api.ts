/** Private, authenticated Control-to-Worker protocol; metadata conveys no execution authority. */
export const EXTENSION_HOST_PRIVATE_PATH = "/private/v0/extensions";
export const EXTENSION_HOST_WIRE_LIMITS = Object.freeze({
  messageBytes: 128 * 1024,
  configurationBytes: 16 * 1024,
  targetBytes: 4 * 1024,
  registrations: 32,
  jsonNodes: 8192,
  jsonDepth: 24,
});

export type ExtensionHostJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ExtensionHostJsonValue[]
  | Readonly<{ [key: string]: ExtensionHostJsonValue }>;
export type ExtensionHostJsonObject = Readonly<{
  [key: string]: ExtensionHostJsonValue;
}>;
export type ExtensionHostActor = Readonly<{
  principalId: string;
  actorId: string;
  tenantId: string;
  spaceId: string;
}>;
export type ExtensionHostRegistrationIdentity = Readonly<{
  pluginId: string;
  pluginVersion: string;
  manifestDigest: string;
  implementationDigest: string;
}>;
export type ExtensionHostRegistration = Readonly<{
  manifest: ExtensionHostJsonObject;
  manifestDigest: string;
  implementationDigest: string;
}>;
type RequestBase = Readonly<{
  protocol: "crewon.extension-host-request.v0";
  actor: ExtensionHostActor;
}>;
type ConfigurationRequest = Readonly<{
  registration: ExtensionHostRegistrationIdentity;
  configuration: ExtensionHostJsonObject;
}>;
export type ExtensionHostRequest = RequestBase &
  (
    | Readonly<{ operation: "catalog" }>
    | (ConfigurationRequest & Readonly<{ operation: "validateConfiguration" }>)
    | (ConfigurationRequest &
        Readonly<{ operation: "readiness"; agentVersionId: string }>)
  );
export type ExtensionHostUnavailableReason =
  | "extension_runtime_unavailable"
  | "extension_implementation_unavailable"
  | "extension_credential_unavailable"
  | "extension_execution_authority_unsupported";
export type ExtensionHostReadinessResult =
  | Readonly<{ outcome: "ready"; target: ExtensionHostJsonObject }>
  | Readonly<{
      outcome: "unavailable";
      reasonCode: ExtensionHostUnavailableReason;
    }>;
type ResponseBase = Readonly<{
  protocol: "crewon.extension-host-response.v0";
  actor: ExtensionHostActor;
}>;
type ConfigurationResponse = Readonly<{
  registration: ExtensionHostRegistrationIdentity;
  configurationDigest: string;
}>;
export type ExtensionHostResponse = ResponseBase &
  (
    | Readonly<{
        operation: "catalog";
        registrations: readonly ExtensionHostRegistration[];
      }>
    | (ConfigurationResponse & Readonly<{ operation: "validateConfiguration" }>)
    | (ConfigurationResponse &
        Readonly<{
          operation: "readiness";
          agentVersionId: string;
          result: ExtensionHostReadinessResult;
        }>)
  );

export class ExtensionHostContractError extends Error {
  readonly code = "extension_host_contract_invalid";
  constructor() {
    super("extension_host_contract_invalid");
    this.name = "ExtensionHostContractError";
  }
}

export function parseExtensionHostRequest(
  input: unknown,
): ExtensionHostRequest {
  const value = record(
    copyJson(input, EXTENSION_HOST_WIRE_LIMITS.messageBytes),
  );
  if (value.protocol !== "crewon.extension-host-request.v0") fail();
  const actor = parseExtensionHostActor(value.actor);
  if (value.operation === "catalog") {
    keys(value, ["protocol", "operation", "actor"]);
    return Object.freeze({
      protocol: value.protocol,
      operation: "catalog",
      actor,
    });
  }
  if (
    value.operation !== "validateConfiguration" &&
    value.operation !== "readiness"
  )
    fail();
  keys(value, [
    "protocol",
    "operation",
    "actor",
    "registration",
    "configuration",
    ...(value.operation === "readiness" ? ["agentVersionId"] : []),
  ]);
  const registration = parseExtensionHostRegistrationIdentity(
    value.registration,
  );
  const configuration = record(
    copyJson(
      value.configuration,
      EXTENSION_HOST_WIRE_LIMITS.configurationBytes,
    ),
  );
  const common = {
    protocol: value.protocol,
    actor,
    registration,
    configuration,
  } as const;
  return value.operation === "readiness"
    ? Object.freeze({
        ...common,
        operation: value.operation,
        agentVersionId: identifier(value.agentVersionId),
      })
    : Object.freeze({ ...common, operation: value.operation });
}

export function parseExtensionHostResponse(
  input: unknown,
): ExtensionHostResponse {
  const value = record(
    copyJson(input, EXTENSION_HOST_WIRE_LIMITS.messageBytes),
  );
  if (value.protocol !== "crewon.extension-host-response.v0") fail();
  const actor = parseExtensionHostActor(value.actor);
  if (value.operation === "catalog") {
    keys(value, ["protocol", "operation", "actor", "registrations"]);
    if (
      !Array.isArray(value.registrations) ||
      value.registrations.length > EXTENSION_HOST_WIRE_LIMITS.registrations
    )
      fail();
    const registrations = value.registrations.map((input) => {
      const entry = record(input);
      keys(entry, ["manifest", "manifestDigest", "implementationDigest"]);
      return Object.freeze({
        manifest: record(entry.manifest),
        manifestDigest: digest(entry.manifestDigest),
        implementationDigest: digest(entry.implementationDigest),
      });
    });
    return Object.freeze({
      protocol: value.protocol,
      operation: value.operation,
      actor,
      registrations: Object.freeze(registrations),
    });
  }
  if (
    value.operation !== "validateConfiguration" &&
    value.operation !== "readiness"
  )
    fail();
  keys(value, [
    "protocol",
    "operation",
    "actor",
    "registration",
    "configurationDigest",
    ...(value.operation === "readiness" ? ["agentVersionId", "result"] : []),
  ]);
  const common = {
    protocol: value.protocol,
    actor,
    registration: parseExtensionHostRegistrationIdentity(value.registration),
    configurationDigest: digest(value.configurationDigest),
  } as const;
  return value.operation === "readiness"
    ? Object.freeze({
        ...common,
        operation: value.operation,
        agentVersionId: identifier(value.agentVersionId),
        result: readiness(value.result),
      })
    : Object.freeze({ ...common, operation: value.operation });
}

export function parseExtensionHostActor(input: unknown): ExtensionHostActor {
  const value = record(copyJson(input, 1024));
  keys(value, ["principalId", "actorId", "tenantId", "spaceId"]);
  return Object.freeze({
    principalId: identifier(value.principalId),
    actorId: identifier(value.actorId),
    tenantId: identifier(value.tenantId),
    spaceId: identifier(value.spaceId),
  });
}

export function parseExtensionHostRegistrationIdentity(
  input: unknown,
): ExtensionHostRegistrationIdentity {
  const value = record(copyJson(input, 1024));
  keys(value, [
    "pluginId",
    "pluginVersion",
    "manifestDigest",
    "implementationDigest",
  ]);
  const pluginId = text(value.pluginId, 48);
  const pluginVersion = text(value.pluginVersion, 32);
  if (
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(pluginId) ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(pluginVersion)
  )
    fail();
  return Object.freeze({
    pluginId,
    pluginVersion,
    manifestDigest: digest(value.manifestDigest),
    implementationDigest: digest(value.implementationDigest),
  });
}

function readiness(input: unknown): ExtensionHostReadinessResult {
  const value = record(input);
  if (value.outcome === "ready") {
    keys(value, ["outcome", "target"]);
    return Object.freeze({
      outcome: value.outcome,
      target: record(
        copyJson(value.target, EXTENSION_HOST_WIRE_LIMITS.targetBytes),
      ),
    });
  }
  keys(value, ["outcome", "reasonCode"]);
  if (
    value.outcome !== "unavailable" ||
    ![
      "extension_runtime_unavailable",
      "extension_implementation_unavailable",
      "extension_credential_unavailable",
      "extension_execution_authority_unsupported",
    ].includes(typeof value.reasonCode === "string" ? value.reasonCode : "")
  )
    fail();
  return Object.freeze({
    outcome: value.outcome,
    reasonCode: value.reasonCode as ExtensionHostUnavailableReason,
  });
}

function copyJson(
  input: unknown,
  maximumBytes: number,
): ExtensionHostJsonValue {
  let nodes = 0;
  let rawBytes = 0;
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  const visit = (value: unknown, depth: number): ExtensionHostJsonValue => {
    if (
      ++nodes > EXTENSION_HOST_WIRE_LIMITS.jsonNodes ||
      depth > EXTENSION_HOST_WIRE_LIMITS.jsonDepth
    )
      fail();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail();
      return value;
    }
    if (typeof value === "string") {
      if (value.length > maximumBytes) fail();
      if (!wellFormed(value)) fail();
      rawBytes += encoder.encode(value).byteLength;
      if (rawBytes > maximumBytes) fail();
      return value;
    }
    if (value === null || typeof value !== "object" || ancestors.has(value))
      fail();
    const prototype = Object.getPrototypeOf(value);
    if (
      !Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      fail();
    if (Object.getOwnPropertySymbols(value).length > 0) fail();
    ancestors.add(value);
    const names = Object.getOwnPropertyNames(value);
    if (names.length > EXTENSION_HOST_WIRE_LIMITS.jsonNodes) fail();
    let result: ExtensionHostJsonValue;
    if (Array.isArray(value)) {
      if (
        value.length > EXTENSION_HOST_WIRE_LIMITS.jsonNodes ||
        names.length !== value.length + 1
      )
        fail();
      result = Object.freeze(
        Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            !descriptor.enumerable
          )
            fail();
          return visit(descriptor.value, depth + 1);
        }),
      );
    } else {
      const entries = names.sort().map((key) => {
        if (key.length > maximumBytes) fail();
        if (!wellFormed(key)) fail();
        rawBytes += encoder.encode(key).byteLength;
        if (rawBytes > maximumBytes) fail();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        )
          fail();
        return [key, visit(descriptor.value, depth + 1)] as const;
      });
      result = Object.freeze(Object.fromEntries(entries));
    }
    ancestors.delete(value);
    return result;
  };
  const copied = visit(input, 0);
  if (encoder.encode(JSON.stringify(copied)).byteLength > maximumBytes) fail();
  return copied;
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function record(input: unknown): ExtensionHostJsonObject {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    fail();
  return input as ExtensionHostJsonObject;
}
function keys(value: ExtensionHostJsonObject, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  )
    fail();
}
function text(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  )
    fail();
  return value;
}
function identifier(value: unknown): string {
  return text(value, 128);
}
function digest(value: unknown): string {
  const result = text(value, 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(result)) fail();
  return result;
}
function fail(): never {
  throw new ExtensionHostContractError();
}
