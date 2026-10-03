export const PRODUCTION_DATABASE_MAX_POOL_SIZE_ENV =
  "CREWON_CONTROL_DATABASE_MAX_POOL_SIZE";

/** Explicit production opt-in; omission preserves the existing database pool default. */
export function resolveProductionDatabaseMaxPoolSize(
  environment: Readonly<Record<string, string | undefined>>,
  securityMode: "production" | "standalone",
): number | undefined {
  const field = Object.getOwnPropertyDescriptor(
    environment,
    PRODUCTION_DATABASE_MAX_POOL_SIZE_ENV,
  );
  if (field === undefined || ("value" in field && field.value === undefined))
    return undefined;
  if (
    securityMode !== "production" ||
    !("value" in field) ||
    !field.enumerable ||
    typeof field.value !== "string" ||
    !/^[1-9][0-9]?$/u.test(field.value)
  )
    invalid();
  const maximum = Number(field.value);
  if (maximum > 64) invalid();
  return maximum;
}

function invalid(): never {
  throw new Error("production_database_max_pool_size_invalid");
}
