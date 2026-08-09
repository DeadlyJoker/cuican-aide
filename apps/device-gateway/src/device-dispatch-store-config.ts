import type { DeviceDispatchStorePort } from "./device-dispatch-store.ts";
import { DeviceGatewayError } from "./device-gateway-error.ts";
import { PostgresDeviceDispatchStore } from "./postgres-device-dispatch-store.ts";
import { SqliteDeviceDispatchStore } from "./sqlite-device-dispatch-store.ts";

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

function optionalEnvironment(
  environment: Environment,
  name: string,
): string | null {
  const value = environment[name];
  return value === undefined || value.trim().length === 0 ? null : value.trim();
}
