type Environment = Readonly<Record<string, string | undefined>>;

export type RuntimeProcessSecurityMode = "standalone" | "production";

export type RuntimeDatabaseAuthority =
  | Readonly<{
      mode: "standalone";
      databasePath: string;
    }>
  | Readonly<{
      mode: "production";
      connectionString: string;
      schema: string;
    }>;

const DATABASE_PATH = "CREWON_CONTROL_DB_PATH";
const DATABASE_URL = "CREWON_CONTROL_DATABASE_URL";
const DATABASE_SCHEMA = "CREWON_CONTROL_DATABASE_SCHEMA";

/** Resolves exactly one Store authority before either process may open a Store. */
export function resolveRuntimeDatabaseAuthority(
  environment: Environment,
  securityMode: RuntimeProcessSecurityMode,
): RuntimeDatabaseAuthority {
  if (securityMode === "production") {
    forbid(environment, DATABASE_PATH);
    return {
      mode: "production",
      connectionString: postgresConnectionString(
        requiredExact(environment, DATABASE_URL, 8_192),
      ),
      schema: postgresSchema(requiredExact(environment, DATABASE_SCHEMA, 63)),
    };
  }

  forbid(environment, DATABASE_URL);
  forbid(environment, DATABASE_SCHEMA);
  return {
    mode: "standalone",
    databasePath: requiredExact(environment, DATABASE_PATH, 8_192),
  };
}

/** Allows defaults only in standalone mode and rejects their production reuse. */
export function resolveRuntimeAuthorityValue(
  environment: Environment,
  securityMode: RuntimeProcessSecurityMode,
  name: string,
  standaloneDefault: string,
  explicitValue?: string,
): string {
  const value =
    explicitValue === undefined
      ? securityMode === "production"
        ? requiredExact(environment, name, 512)
        : environment[name]?.trim() || standaloneDefault
      : exactValue(explicitValue, name, 512);
  if (securityMode === "production" && value === standaloneDefault) {
    throw new Error(`${name}_standalone_default_forbidden`);
  }
  return value;
}

function forbid(environment: Environment, name: string): void {
  if (environment[name] !== undefined) {
    throw new Error(`${name}_forbidden`);
  }
}

function requiredExact(
  environment: Environment,
  name: string,
  maximumBytes: number,
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name}_required`);
  }
  return exactValue(value, name, maximumBytes);
}

function exactValue(value: string, name: string, maximumBytes: number): string {
  if (
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

function postgresConnectionString(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new Error(`${DATABASE_URL}_invalid`, { cause });
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.hostname.length === 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(`${DATABASE_URL}_invalid`);
  }
  return value;
}

function postgresSchema(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error(`${DATABASE_SCHEMA}_invalid`);
  }
  return value;
}
