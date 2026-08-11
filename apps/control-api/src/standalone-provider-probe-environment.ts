import {
  HttpProviderProbeWorkerClient,
  SingleTenantProviderProbeWorkerRegistry,
  type TenantProviderProbeWorkerRegistry,
} from "./provider-probe-worker-client.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const ORIGIN = "CREWON_PROVIDER_PROBE_WORKER_ORIGIN";
const TOKEN = "CREWON_PROVIDER_PROBE_WORKER_TOKEN";
const TIMEOUT = "CREWON_PROVIDER_PROBE_WORKER_TIMEOUT_MS";
const NAMES = [ORIGIN, TOKEN, TIMEOUT] as const;

/** Projects the single-tenant standalone route without exposing its bearer token. */
export function resolveStandaloneProviderProbeWorkers(
  environment: Environment,
  securityMode: "standalone" | "production",
  tenantId: string,
): TenantProviderProbeWorkerRegistry | undefined {
  const declared = NAMES.some((name) => environment[name] !== undefined);
  if (securityMode === "production") {
    if (declared) {
      throw new Error("CREWON_PROVIDER_PROBE_WORKER_CONFIGURATION_forbidden");
    }
    return undefined;
  }
  if (!declared) return undefined;

  const origin = requiredExact(environment, ORIGIN);
  const token = requiredExact(environment, TOKEN);
  const timeout = environment[TIMEOUT];
  return new SingleTenantProviderProbeWorkerRegistry({
    tenantId,
    worker: new HttpProviderProbeWorkerClient({
      origin,
      token,
      ...(timeout === undefined ? {} : { timeoutMs: timeoutMs(timeout) }),
    }),
  });
}

function requiredExact(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error("CREWON_PROVIDER_PROBE_WORKER_CONFIGURATION_incomplete");
  }
  if (value !== value.trim()) throw new Error(`${name}_invalid`);
  return value;
}

function timeoutMs(value: string): number {
  if (value !== value.trim() || !/^\d{4,5}$/u.test(value)) {
    throw new Error("CREWON_PROVIDER_PROBE_WORKER_TIMEOUT_MS_invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 30_000) {
    throw new Error("CREWON_PROVIDER_PROBE_WORKER_TIMEOUT_MS_invalid");
  }
  return parsed;
}
