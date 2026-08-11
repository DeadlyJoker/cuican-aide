import { inspect } from "node:util";

import type { ProviderProbeEgressPolicy } from "./provider-probe-egress.ts";
import type {
  RuntimeProviderBinding,
  RuntimeProviderSecretResolver,
} from "./provider-probe-service.ts";
import { EnvironmentProviderSecretResolver } from "./provider-probe-service.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const PORT = "CREWON_PROVIDER_PROBE_PORT";
const TOKEN = "CREWON_PROVIDER_PROBE_TOKEN";
const PROVIDER = "CREWON_PROVIDER_PROBE_PROVIDER_ID";
const BINDING = "CREWON_PROVIDER_PROBE_RUNTIME_BINDING_ID";
const ENDPOINT = "CREWON_PROVIDER_PROBE_ENDPOINT";
const CREDENTIAL = "CREWON_PROVIDER_PROBE_CREDENTIAL_ENVIRONMENT";
const NAMES = [PORT, TOKEN, PROVIDER, BINDING, ENDPOINT, CREDENTIAL] as const;

export type RuntimeProviderProbeEnvironment = Readonly<{
  port: number;
  token: string;
  runtimeBinding: RuntimeProviderBinding;
  secrets: RuntimeProviderSecretResolver;
  egressPolicy: ProviderProbeEgressPolicy;
}>;

export type RuntimeWorkerSecurityMode = "standalone" | "production";

export function parseRuntimeWorkerSecurityMode(
  value: string,
): RuntimeWorkerSecurityMode {
  if (value === "standalone" || value === "production") return value;
  throw new Error("CREWON_CONTROL_SECURITY_MODE_invalid");
}

/** Parses the standalone private listener as one indivisible ambient binding. */
export function resolveRuntimeProviderProbeEnvironment(
  environment: Environment,
  securityMode: RuntimeWorkerSecurityMode,
  egressPolicy: ProviderProbeEgressPolicy,
): RuntimeProviderProbeEnvironment | undefined {
  const declared = NAMES.some((name) => environment[name] !== undefined);
  if (securityMode === "production") {
    if (declared) {
      throw new Error("CREWON_PROVIDER_PROBE_CONFIGURATION_forbidden");
    }
    return undefined;
  }
  if (!declared) return undefined;
  for (const name of NAMES) requiredExact(environment, name);

  const credentialEnvironment = requiredExact(environment, CREDENTIAL);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(credentialEnvironment)) {
    throw invalid();
  }
  secretValue(requiredExact(environment, credentialEnvironment));
  const config = {
    port: integer(requiredExact(environment, PORT), 1, 65_535),
    token: secretValue(requiredExact(environment, TOKEN)),
    runtimeBinding: redact({
      providerId: opaque(requiredExact(environment, PROVIDER), 128),
      runtimeBindingId: opaque(requiredExact(environment, BINDING), 512),
      endpoint: safeEndpoint(requiredExact(environment, ENDPOINT)),
      credentialKind: "environment" as const,
      environmentVariable: credentialEnvironment,
    }),
    secrets: new EnvironmentProviderSecretResolver(environment),
    egressPolicy,
  };
  return redact(config);
}

function requiredExact(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw invalid();
  if (value !== value.trim()) throw invalid();
  return value;
}

function integer(value: string, minimum: number, maximum: number): number {
  if (!/^\d+$/u.test(value)) throw invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalid();
  }
  return parsed;
}

function opaque(value: string, maximumBytes: number): string {
  if (
    Buffer.byteLength(value) > maximumBytes ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw invalid();
  }
  return value;
}

function secretValue(value: string): string {
  const bytes = Buffer.byteLength(value);
  if (bytes < 32 || bytes > 8_192 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalid();
  }
  return value;
}

function safeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(host);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw invalid();
  }
  return value;
}

function invalid(): Error {
  return new Error("CREWON_PROVIDER_PROBE_CONFIGURATION_invalid");
}

function redact<T extends object>(value: T): T {
  Object.defineProperty(value, inspect.custom, {
    value: () => "[RuntimeProviderProbeEnvironment]",
    enumerable: false,
  });
  return value;
}
