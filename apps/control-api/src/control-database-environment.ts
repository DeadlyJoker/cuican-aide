type Environment = Readonly<Record<string, string | undefined>>;

export type ControlDatabaseAuthority =
  | Readonly<{ mode: "standalone"; databasePath: string }>
  | Readonly<{
      mode: "production";
      connectionString: string;
      schema: string;
    }>;

const DATABASE_PATH = "CREWON_CONTROL_DB_PATH";
const DATABASE_URL = "CREWON_CONTROL_DATABASE_URL";
const DATABASE_SCHEMA = "CREWON_CONTROL_DATABASE_SCHEMA";

/** Selects the only Store backend supported by each Control security mode. */
export function resolveControlDatabaseAuthority(
  environment: Environment,
  securityMode: "standalone" | "production",
): ControlDatabaseAuthority {
  if (securityMode === "standalone") {
    forbid(environment, DATABASE_URL);
    forbid(environment, DATABASE_SCHEMA);
    return {
      mode: "standalone",
      databasePath: requiredExact(environment, DATABASE_PATH, 8_192),
    };
  }

  forbid(environment, DATABASE_PATH);
  return {
    mode: "production",
    connectionString: postgresConnectionString(
      requiredExact(environment, DATABASE_URL, 8_192),
    ),
    schema: postgresSchema(requiredExact(environment, DATABASE_SCHEMA, 63)),
  };
}

function forbid(environment: Environment, name: string): void {
  if (environment[name] !== undefined) throw new Error(`${name}_forbidden`);
}

function requiredExact(
  environment: Environment,
  name: string,
  maximumBytes: number,
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name}_required`);
  if (
    value !== value.trim() ||
    new TextEncoder().encode(value).byteLength > maximumBytes ||
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
