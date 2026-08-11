import type { DeviceConnectionRouteStorePort } from "./device-connection-route-store.ts";
import type { DeviceDispatchStorePort } from "./device-dispatch-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import { PostgresDeviceDispatchStore } from "./postgres-device-dispatch-store.ts";
import { PostgresWorkspaceDispatchStore } from "./postgres-workspace-dispatch-store.ts";
import { PostgresWorkspaceReadDispatchStore } from "./postgres-workspace-read-dispatch-store.ts";
import { SqliteDeviceDispatchStore } from "./sqlite-device-dispatch-store.ts";
import { SqliteWorkspaceDispatchStore } from "./sqlite-workspace-dispatch-store.ts";
import { SqliteWorkspaceReadDispatchStore } from "./sqlite-workspace-read-dispatch-store.ts";
import type { WorkspaceDispatchStorePort } from "./workspace-dispatch-store.ts";
import type {
  WorkspaceReadCurrentRouteResolver,
  WorkspaceReadDispatchStorePort,
} from "./workspace-read-dispatch-store.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** Selects exactly one Standalone or Team Device dispatch authority. */
export function createDeviceDispatchStoreFromEnvironment(
  environment: Environment,
): DeviceDispatchStorePort {
  const sqlitePath = optionalEnvironment(
    environment,
    "CREWON_DEVICE_GATEWAY_DATABASE_PATH",
  );
  const postgresUrl = optionalEnvironment(
    environment,
    "CREWON_DEVICE_GATEWAY_DATABASE_URL",
  );
  if ((sqlitePath === null) === (postgresUrl === null)) {
    throw new DeviceGatewayError("device_dispatch_database_config_invalid");
  }
  if (postgresUrl !== null) {
    return new PostgresDeviceDispatchStore({
      connectionString: postgresUrl,
      schema:
        optionalEnvironment(
          environment,
          "CREWON_DEVICE_GATEWAY_DATABASE_SCHEMA",
        ) ?? undefined,
    });
  }
  return new SqliteDeviceDispatchStore(sqlitePath as string);
}

/** Selects the Workspace authority colocated with the Device dispatch DB. */
export function createWorkspaceDispatchStoreFromEnvironment(
  environment: Environment,
): WorkspaceDispatchStorePort {
  const sqlitePath = optionalEnvironment(
    environment,
    "CREWON_DEVICE_GATEWAY_DATABASE_PATH",
  );
  const postgresUrl = optionalEnvironment(
    environment,
    "CREWON_DEVICE_GATEWAY_DATABASE_URL",
  );
  if ((sqlitePath === null) === (postgresUrl === null)) {
    throw new DeviceGatewayError("device_dispatch_database_config_invalid");
  }
  if (postgresUrl !== null) {
    return new PostgresWorkspaceDispatchStore({
      connectionString: postgresUrl,
      schema:
        optionalEnvironment(
          environment,
          "CREWON_DEVICE_GATEWAY_DATABASE_SCHEMA",
        ) ?? undefined,
    });
  }
  return new SqliteWorkspaceDispatchStore(sqlitePath as string);
}

/** Selects the Workspace-read authority colocated with the route database. */
export function createWorkspaceReadDispatchStoreFromEnvironment(
  environment: Environment,
  currentRoute: WorkspaceReadCurrentRouteResolver,
): WorkspaceReadDispatchStorePort {
  const sqlitePath = optionalEnvironment(
    environment,
    "CREWON_DEVICE_GATEWAY_DATABASE_PATH",
  );
  const postgresUrl = optionalEnvironment(
    environment,
    "CREWON_DEVICE_GATEWAY_DATABASE_URL",
  );
  if ((sqlitePath === null) === (postgresUrl === null)) {
    throw new DeviceGatewayError("device_dispatch_database_config_invalid");
  }
  const config = { now: () => new Date(), currentRoute };
  if (postgresUrl !== null) {
    return new PostgresWorkspaceReadDispatchStore({
      connectionString: postgresUrl,
      schema:
        optionalEnvironment(
          environment,
          "CREWON_DEVICE_GATEWAY_DATABASE_SCHEMA",
        ) ?? undefined,
      ...config,
    });
  }
  return new SqliteWorkspaceReadDispatchStore(sqlitePath as string, config);
}

/** Builds the complete production dispatch authority set without optional routes. */
export function createDeviceGatewayDispatchStoresFromEnvironment(
  environment: Environment,
): Readonly<{
  dispatchStore: DeviceDispatchStorePort;
  workspaceDispatchStore: WorkspaceDispatchStorePort;
  workspaceReadDispatchStore: WorkspaceReadDispatchStorePort;
  connectionRouteStore: DeviceConnectionRouteStorePort;
}> {
  const dispatchStore = createDeviceDispatchStoreFromEnvironment(environment);
  const workspaceDispatchStore =
    createWorkspaceDispatchStoreFromEnvironment(environment);
  const connectionRouteStore =
    dispatchStore instanceof PostgresDeviceDispatchStore
      ? dispatchStore
      : workspaceDispatchStore instanceof SqliteWorkspaceDispatchStore
        ? workspaceDispatchStore
        : failUnsupportedRouteStore();
  const workspaceReadDispatchStore =
    createWorkspaceReadDispatchStoreFromEnvironment(
      environment,
      currentWorkspaceReadRoute(connectionRouteStore),
    );
  return {
    dispatchStore,
    workspaceDispatchStore,
    workspaceReadDispatchStore,
    connectionRouteStore,
  };
}

function failUnsupportedRouteStore(): never {
  throw new DeviceGatewayError("device_dispatch_database_config_invalid");
}

function currentWorkspaceReadRoute(
  routes: DeviceConnectionRouteStorePort,
): WorkspaceReadCurrentRouteResolver {
  return async (expected) => {
    const current = await routes.loadConnection(expected.deviceId);
    return current !== null &&
      current.deviceId === expected.deviceId &&
      current.gatewayId === expected.gatewayId &&
      current.connectionId === expected.connectionId &&
      current.epoch === expected.connectionEpoch &&
      current.leaseExpiresAt === expected.leaseExpiresAt
      ? structuredClone(expected)
      : null;
  };
}

function optionalEnvironment(
  environment: Environment,
  name: string,
): string | null {
  const value = environment[name];
  return value === undefined || value.trim().length === 0 ? null : value.trim();
}
