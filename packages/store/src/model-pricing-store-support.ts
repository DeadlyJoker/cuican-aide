import {
  RunStoreError,
  type ModelPricingLocator,
  type ModelPricingState,
  type SetModelPricingInput,
} from "@crewon/application";
import {
  validateModelCallRecord,
  validateModelTokenPrice,
  validateModelTokenPricingSnapshot,
  copyModelTokenPricing,
  type ModelCallRecord,
  type ModelTokenPricingSnapshot,
} from "@crewon/domain";
import { stableJson } from "./store-invariants.ts";
export const EMPTY_MODEL_PRICING: ModelPricingState = {
  revision: 0,
  price: null,
};
export function validateModelPricingLocator(input: ModelPricingLocator): void {
  for (const id of [input.tenantId, input.agentVersionId])
    if (
      typeof id !== "string" ||
      !id.trim() ||
      id.length > 512 ||
      /[\u0000-\u001f]/u.test(id)
    )
      throw new RunStoreError("model_pricing_locator_invalid");
}
export function validateModelPricingUpdate(input: SetModelPricingInput): void {
  validateModelPricingLocator(input);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    throw new RunStoreError("model_pricing_revision_invalid");
  if (input.price !== null) {
    try {
      validateModelTokenPrice(input.price);
    } catch {
      throw new RunStoreError("model_pricing_value_invalid");
    }
  }
}
export function nextModelPricing(
  current: ModelPricingState,
  input: SetModelPricingInput,
): ModelPricingState {
  validateModelPricingUpdate(input);
  const same = stableJson(current.price) === stableJson(input.price);
  if (current.revision !== input.expectedRevision) {
    if (same && current.revision === input.expectedRevision + 1) return current;
    throw new RunStoreError("model_pricing_revision_conflict");
  }
  if (same) return current;
  if (!Number.isSafeInteger(current.revision + 1))
    throw new RunStoreError("model_pricing_revision_overflow");
  return {
    revision: current.revision + 1,
    price: structuredClone(input.price),
  };
}
export function decodeModelPricing(
  row: Record<string, unknown> | undefined,
): ModelPricingState {
  if (row === undefined) return EMPTY_MODEL_PRICING;
  try {
    const revision = Number(row.revision),
      price =
        typeof row.price_json === "string"
          ? JSON.parse(row.price_json)
          : row.price_json;
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error();
    if (price !== null) validateModelTokenPrice(price);
    return { revision, price };
  } catch {
    throw new RunStoreError("model_pricing_record_invalid");
  }
}
export function preserveModelCallPricing(
  record: ModelCallRecord,
  pricing: ModelTokenPricingSnapshot | undefined,
): ModelCallRecord {
  if (
    record.tokenPricing !== undefined &&
    stableJson(record.tokenPricing) !==
      (pricing === undefined ? undefined : stableJson(pricing))
  )
    throw new RunStoreError("model_call_pricing_conflict");
  const { tokenPricing: _ignored, ...rest } = record;
  if (pricing === undefined) return rest;
  validateModelTokenPricingSnapshot(pricing);
  const result = { ...rest, tokenPricing: copyModelTokenPricing(pricing) };
  try {
    validateModelCallRecord(result);
  } catch {
    throw new RunStoreError("model_call_record_invalid");
  }
  return result;
}
export function modelPricingSchemaSql(postgres: boolean, schema = ""): string {
  return `CREATE TABLE IF NOT EXISTS ${schema}model_token_pricing (
    tenant_id TEXT NOT NULL, agent_version_id TEXT NOT NULL,
    revision ${postgres ? "bigint" : "INTEGER"} NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    price_json ${postgres ? "jsonb" : "TEXT"} NOT NULL CHECK(${postgres ? "octet_length(price_json::text)" : "length(CAST(price_json AS BLOB))"} <= 2048),
    PRIMARY KEY(tenant_id,agent_version_id)
  )${postgres ? "" : " STRICT"};`;
}
