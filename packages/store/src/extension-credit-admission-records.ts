import {
  assertExtensionCreditAdmission,
  extensionCanonicalJson,
  parseExtensionCreditAdmission,
  type ExtensionCreditAdmission,
  type ExtensionRunBinding,
} from "@crewon/domain";
import type { ExtensionMutationReceipt } from "@crewon/application";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { pluginCreditSchemaName } from "./plugin-credit-schema.ts";

export function checkedExtensionCreditAdmission(input: {
  admission: ExtensionCreditAdmission | undefined;
  binding: ExtensionRunBinding;
  receipt: ExtensionMutationReceipt;
}): ExtensionCreditAdmission | undefined {
  return input.admission === undefined
    ? undefined
    : assertExtensionCreditAdmission(
        { ...input, admission: input.admission },
        extensionStoreDigester,
      );
}

/** Repricing races return the original quote; changing the payer never reuses a paid receipt. */
export function assertExtensionCreditReplayPrincipal(input: {
  saved: ExtensionCreditAdmission | undefined;
  requested: ExtensionCreditAdmission | undefined;
}): void {
  if (
    input.saved !== undefined &&
    input.requested !== undefined &&
    input.saved.reservation.scope.principalId !==
      input.requested.reservation.scope.principalId
  )
    throw new Error("extension_credit_account_owner_mismatch");
}

export function decodeExtensionCreditAdmission(
  row:
    | {
        tenant_id: unknown;
        space_id: unknown;
        run_id: unknown;
        principal_id: unknown;
        pool_id: unknown;
        reservation_id: unknown;
        admission_json: unknown;
      }
    | undefined,
): ExtensionCreditAdmission | null {
  if (row === undefined) return null;
  let value: unknown;
  try {
    const json =
      typeof row.admission_json === "string"
        ? row.admission_json
        : JSON.stringify(row.admission_json);
    if (typeof json !== "string" || Buffer.byteLength(json) > 8192)
      throw new Error();
    value = JSON.parse(json);
  } catch {
    throw new Error("extension_credit_admission_invalid");
  }
  const admission = parseExtensionCreditAdmission(
    value,
    extensionStoreDigester,
  );
  if (
    admission.tenantId !== row.tenant_id ||
    admission.spaceId !== row.space_id ||
    admission.runId !== row.run_id ||
    admission.reservation.scope.principalId !== row.principal_id ||
    admission.reservation.scope.poolId !== row.pool_id ||
    admission.reservation.reservationId !== row.reservation_id
  )
    throw new Error("extension_credit_admission_identity_mismatch");
  return admission;
}

export function assertExtensionCreditAdmissionLink(input: {
  admission: ExtensionCreditAdmission;
  linked: ExtensionCreditAdmission | null;
}): void {
  if (
    input.linked === null ||
    extensionCanonicalJson(input.linked) !==
      extensionCanonicalJson(input.admission)
  )
    throw new Error("extension_credit_admission_link_mismatch");
}

export function assertExtensionCreditSchemaVersion(
  rows: readonly { id: unknown; version: unknown }[],
): void {
  if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0]?.version !== 1)
    throw new Error("extension_credit_schema_version_unsupported");
}

export function extensionCreditAdmissionSchemaSql(
  input: { dialect: "sqlite" } | { dialect: "postgres"; schema: string },
): string {
  const postgres = input.dialect === "postgres";
  const prefix =
    input.dialect === "postgres"
      ? `${pluginCreditSchemaName(input.schema)}.`
      : "";
  return `
    CREATE TABLE IF NOT EXISTS ${prefix}extension_credit_schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL
    )${postgres ? "" : " STRICT"};
    INSERT INTO ${prefix}extension_credit_schema_version VALUES (1,1) ON CONFLICT(id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS ${prefix}extension_credit_admissions (
      tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, run_id TEXT NOT NULL,
      principal_id TEXT NOT NULL, pool_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
      admission_json ${postgres ? "JSONB" : "TEXT"} NOT NULL CHECK (${postgres ? "octet_length(admission_json::text)" : "length(CAST(admission_json AS BLOB))"} <= 8192${postgres ? "" : " AND json_valid(admission_json)"}),
      PRIMARY KEY (tenant_id, run_id),
      UNIQUE (tenant_id, principal_id, pool_id, reservation_id),
      FOREIGN KEY (tenant_id,run_id) REFERENCES ${prefix}run_snapshots(tenant_id,run_id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id,principal_id,pool_id,reservation_id)
        REFERENCES ${prefix}plugin_credit_reservations(tenant_id,principal_id,pool_id,reservation_id) ON DELETE RESTRICT
    )${postgres ? "" : " STRICT"};
    ${
      postgres
        ? `CREATE OR REPLACE FUNCTION ${prefix}extension_credit_admission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'extension_credit_admission_immutable'; END;
    $$;
    CREATE OR REPLACE TRIGGER extension_credit_admissions_no_update_or_delete
      BEFORE UPDATE OR DELETE ON ${prefix}extension_credit_admissions
      FOR EACH ROW EXECUTE FUNCTION ${prefix}extension_credit_admission_immutable();`
        : `CREATE TRIGGER IF NOT EXISTS extension_credit_admissions_no_update
        BEFORE UPDATE ON extension_credit_admissions BEGIN SELECT RAISE(ABORT,'extension_credit_admission_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS extension_credit_admissions_no_delete
        BEFORE DELETE ON extension_credit_admissions BEGIN SELECT RAISE(ABORT,'extension_credit_admission_immutable'); END;`
    }
  `;
}
