import {
  HttpProviderProbeWorkerClient,
  type TenantProviderProbeWorkerRegistry,
} from "./provider-probe-worker-client.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const ROUTES = "CREWON_PROVIDER_PROBE_TENANT_ROUTES_JSON";
const MAX_ROUTES = 1_000;
const MAX_CONFIG_BYTES = 512 * 1_024;
const STANDALONE_NAMES = [
  "CREWON_PROVIDER_PROBE_WORKER_ORIGIN",
  "CREWON_PROVIDER_PROBE_WORKER_TOKEN",
  "CREWON_PROVIDER_PROBE_WORKER_TIMEOUT_MS",
] as const;

type Route = Readonly<{
  tenantId: string;
  runtimeBindingId: string;
  origin: string;
  token: string;
  timeoutMs?: number;
}>;

/** Builds the Team/Cloud tenant registry from authenticated Worker routes. */
export function resolveProductionProviderProbeWorkers(
  environment: Environment,
): TenantProviderProbeWorkerRegistry {
  if (STANDALONE_NAMES.some((name) => environment[name] !== undefined)) {
    throw new Error("CREWON_PROVIDER_PROBE_WORKER_CONFIGURATION_forbidden");
  }
  const encoded = environment[ROUTES];
  if (encoded === undefined || encoded.length === 0) {
    throw new Error(`${ROUTES}_required`);
  }
  if (
    encoded !== encoded.trim() ||
    new TextEncoder().encode(encoded).byteLength > MAX_CONFIG_BYTES
  ) {
    throw invalidConfiguration();
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (cause) {
    throw invalidConfiguration(cause);
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ROUTES
  ) {
    throw invalidConfiguration();
  }

  const workers = new Map<string, HttpProviderProbeWorkerClient>();
  for (const input of value) {
    const route = parseRoute(input);
    const key = routeKey(route.tenantId, route.runtimeBindingId);
    if (workers.has(key)) throw invalidConfiguration();
    try {
      workers.set(
        key,
        new HttpProviderProbeWorkerClient({
          origin: route.origin,
          token: route.token,
          ...(route.timeoutMs === undefined
            ? {}
            : { timeoutMs: route.timeoutMs }),
        }),
      );
    } catch (cause) {
      throw invalidConfiguration(cause);
    }
  }

  return {
    resolve: ({ tenantId, runtimeBindingId }) =>
      workers.get(routeKey(tenantId, runtimeBindingId)) ?? null,
  };
}

function parseRoute(value: unknown): Route {
  if (!record(value)) throw invalidConfiguration();
  const keys = Object.keys(value).sort();
  const required = ["origin", "runtimeBindingId", "tenantId", "token"];
  const allowed = [...required, "timeoutMs"].sort();
  if (
    keys.join("\0") !== required.sort().join("\0") &&
    keys.join("\0") !== allowed.join("\0")
  ) {
    throw invalidConfiguration();
  }
  if (
    !opaque(value.tenantId, 512) ||
    !opaque(value.runtimeBindingId, 512) ||
    typeof value.origin !== "string" ||
    typeof value.token !== "string" ||
    (value.timeoutMs !== undefined &&
      (!Number.isSafeInteger(value.timeoutMs) ||
        (value.timeoutMs as number) < 1_000 ||
        (value.timeoutMs as number) > 30_000))
  ) {
    throw invalidConfiguration();
  }
  return {
    tenantId: value.tenantId,
    runtimeBindingId: value.runtimeBindingId,
    origin: value.origin,
    token: value.token,
    ...(value.timeoutMs === undefined
      ? {}
      : { timeoutMs: value.timeoutMs as number }),
  };
}

function routeKey(tenantId: string, runtimeBindingId: string): string {
  return `${tenantId.length}:${tenantId}${runtimeBindingId}`;
}

function opaque(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
    new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConfiguration(cause?: unknown): Error {
  return new Error(`${ROUTES}_invalid`, { cause });
}
