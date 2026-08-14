import {
  ProductionWorkspaceWorkerClient,
  type ProductionWorkspaceWorkerRegistry,
  type ProductionWorkspaceWorkerRoute,
} from "./workspace-runtime-worker-client.ts";

type Environment = Readonly<Record<string, string | undefined>>;
const ROUTES = "CREWON_WORKSPACE_TENANT_ROUTES_JSON";
const MAX_ROUTES = 1_000;
const MAX_BYTES = 512 * 1_024;

type RouteConfig = ProductionWorkspaceWorkerRoute &
  Readonly<{
    origin: string;
    tokenEnvironment: string;
    deadlineMs?: number;
  }>;

/** Static production projection; one current freeze route per tenant. */
export function resolveProductionWorkspaceWorkers(
  environment: Environment,
): ProductionWorkspaceWorkerRegistry {
  const encoded = environment[ROUTES];
  if (encoded === undefined || encoded.length === 0) {
    throw new Error(`${ROUTES}_required`);
  }
  if (
    encoded !== encoded.trim() ||
    new TextEncoder().encode(encoded).byteLength > MAX_BYTES
  ) {
    throw invalidConfiguration();
  }
  let input: unknown;
  try {
    input = JSON.parse(encoded);
  } catch (cause) {
    throw invalidConfiguration(cause);
  }
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_ROUTES
  ) {
    throw invalidConfiguration();
  }

  const routes = new Map<string, ProductionWorkspaceWorkerClient>();
  const tenants = new Map<string, ProductionWorkspaceWorkerClient>();
  for (const value of input) {
    const config = routeConfig(value);
    if (tenants.has(config.tenantId)) throw invalidConfiguration();
    let worker;
    try {
      worker = new ProductionWorkspaceWorkerClient({
        ...config,
        token: secret(environment[config.tokenEnvironment]),
      });
    } catch (cause) {
      throw invalidConfiguration(cause);
    }
    const key = routeKey(config);
    if (routes.has(key)) throw invalidConfiguration();
    tenants.set(config.tenantId, worker);
    routes.set(key, worker);
  }

  return {
    resolveForCreate: ({ tenantId }) => tenants.get(tenantId) ?? null,
    resolve: (route) => routes.get(routeKey(route)) ?? null,
    async close() {
      await Promise.all([...routes.values()].map((worker) => worker.close()));
    },
  };
}

function routeConfig(value: unknown): RouteConfig {
  if (!record(value)) throw invalidConfiguration();
  const required = [
    "origin",
    "runtimeBindingId",
    "tenantId",
    "tokenEnvironment",
    "workspaceBindingId",
  ].sort();
  const allowed = [...required, "deadlineMs"].sort();
  const keys = Object.keys(value).sort();
  if (
    keys.join("\0") !== required.join("\0") &&
    keys.join("\0") !== allowed.join("\0")
  ) {
    throw invalidConfiguration();
  }
  if (
    typeof value.tenantId !== "string" ||
    typeof value.runtimeBindingId !== "string" ||
    typeof value.workspaceBindingId !== "string" ||
    typeof value.origin !== "string" ||
    !environmentName(value.tokenEnvironment) ||
    (value.deadlineMs !== undefined &&
      (!Number.isSafeInteger(value.deadlineMs) ||
        (value.deadlineMs as number) < 1_000 ||
        (value.deadlineMs as number) > 60_000))
  ) {
    throw invalidConfiguration();
  }
  return {
    tenantId: value.tenantId,
    runtimeBindingId: value.runtimeBindingId,
    workspaceBindingId: value.workspaceBindingId,
    origin: value.origin,
    tokenEnvironment: value.tokenEnvironment,
    ...(value.deadlineMs === undefined
      ? {}
      : { deadlineMs: value.deadlineMs as number }),
  };
}

function environmentName(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)
  );
}

function secret(value: string | undefined): string {
  if (value === undefined) throw invalidConfiguration();
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 32 || bytes > 8_192 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidConfiguration();
  }
  return value;
}

function routeKey(route: ProductionWorkspaceWorkerRoute): string {
  return JSON.stringify([
    route.tenantId,
    route.runtimeBindingId,
    route.workspaceBindingId,
  ]);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConfiguration(cause?: unknown): Error {
  return new Error(`${ROUTES}_invalid`, { cause });
}
