import type {
  AdvanceExternalOperation,
  ExternalOperation,
  ExternalOperationLocator,
  ExternalOperationQuery,
  ReserveExternalOperation,
} from "@crewon/application";

export function validateExternalOperationQuery(
  input: ExternalOperationQuery,
): ExternalOperationQuery {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    Object.getOwnPropertySymbols(input).length !== 0 ||
    Object.getOwnPropertyNames(input).sort().join("\0") !==
      "bindingDigest\0limit\0runId\0tenantId"
  )
    throw new Error("external_operation_query_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.values(descriptors).some((entry) => !Object.hasOwn(entry, "value"))
  )
    throw new Error("external_operation_query_invalid");
  const tenantId = descriptors.tenantId!.value;
  const runId = descriptors.runId!.value;
  const bindingDigest = descriptors.bindingDigest!.value;
  const limit = descriptors.limit!.value;
  text(tenantId);
  text(runId);
  for (const value of [tenantId, runId]) {
    for (const point of value) {
      const code = point.codePointAt(0)!;
      if (code >= 0xd800 && code <= 0xdfff)
        throw new Error("external_operation_query_invalid");
    }
  }
  digest(bindingDigest);
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 16
  )
    throw new Error("external_operation_query_invalid");
  return Object.freeze({ tenantId, runId, bindingDigest, limit });
}

export function parseExternalOperationQueryRecord(input: {
  record: unknown;
  query: ExternalOperationQuery;
  operationId: string;
}): ExternalOperation {
  const operation = parseExternalOperation(input.record);
  if (
    operation.tenantId !== input.query.tenantId ||
    operation.runId !== input.query.runId ||
    operation.bindingDigest !== input.query.bindingDigest ||
    operation.operationId !== input.operationId
  )
    throw new Error("external_operation_query_scope_mismatch");
  return operation;
}

export function validateExternalOperationLocator(
  input: ExternalOperationLocator,
) {
  text(input.tenantId);
  text(input.runId);
  digest(input.bindingDigest);
  uuid(input.operationId);
}

export function initialExternalOperation(
  input: ReserveExternalOperation,
): ExternalOperation {
  validateExternalOperationLocator(input);
  text(input.executionId);
  text(input.idempotencyKey);
  digest(input.actionDigest);
  digest(input.requestDigest);
  uuid(input.correlationId);
  timestamp(input.createdAt);
  return {
    schemaVersion: "crewon.external-operation.v0",
    tenantId: input.tenantId,
    runId: input.runId,
    bindingDigest: input.bindingDigest,
    operationId: input.operationId,
    executionId: input.executionId,
    idempotencyKey: input.idempotencyKey,
    actionDigest: input.actionDigest,
    requestDigest: input.requestDigest,
    correlationId: input.correlationId,
    providerOperationId: null,
    status: "submitting",
    resultJson: null,
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function assertExternalOperationReplay(
  existing: ExternalOperation,
  requested: ExternalOperation,
) {
  for (const key of [
    "tenantId",
    "runId",
    "bindingDigest",
    "executionId",
    "idempotencyKey",
    "actionDigest",
    "requestDigest",
  ] as const) {
    if (existing[key] !== requested[key])
      throw new Error("external_operation_identity_conflict");
  }
}

/** Refuse unknown persisted versions or malformed receipts instead of reopening dispatch. */
export function parseExternalOperation(input: unknown): ExternalOperation {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("external_operation_record_invalid");
  const value = input as ExternalOperation;
  if (value.schemaVersion !== "crewon.external-operation.v0")
    throw new Error("external_operation_version_unsupported");
  const initial = initialExternalOperation(value);
  if (
    Object.keys(value).sort().join("\0") !==
    Object.keys(initial).sort().join("\0")
  )
    throw new Error("external_operation_record_invalid");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1)
    throw new Error("external_operation_revision_invalid");
  timestamp(value.updatedAt);
  if (value.updatedAt < value.createdAt)
    throw new Error("external_operation_time_regression");
  if (value.status === "submitting") {
    if (
      value.revision !== 1 ||
      value.providerOperationId !== null ||
      value.resultJson !== null
    )
      throw new Error("external_operation_record_invalid");
  } else
    validateExternalOperationAdvance({
      ...value,
      expectedRevision: value.revision,
    });
  return Object.freeze({ ...value });
}

export function validateExternalOperationAdvance(
  input: AdvanceExternalOperation,
) {
  validateExternalOperationLocator(input);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  )
    throw new Error("external_operation_revision_invalid");
  timestamp(input.updatedAt);
  if (input.providerOperationId !== null) text(input.providerOperationId);
  if (
    ![
      "submitted",
      "queued",
      "running",
      "succeeded",
      "failed",
      "unknownOutcome",
    ].includes(input.status)
  )
    throw new Error("external_operation_state_invalid");
  if (input.status === "succeeded") {
    if (
      typeof input.resultJson !== "string" ||
      Buffer.byteLength(input.resultJson) > 16_384
    )
      throw new Error("external_operation_result_invalid");
    const result: unknown = JSON.parse(input.resultJson);
    if (result === null || typeof result !== "object" || Array.isArray(result))
      throw new Error("external_operation_result_invalid");
  } else if (input.resultJson !== null)
    throw new Error("external_operation_result_invalid");
}

export function nextExternalOperation(
  current: ExternalOperation,
  input: AdvanceExternalOperation,
): ExternalOperation {
  if (current.status === "succeeded" || current.status === "failed")
    throw new Error("external_operation_terminal");
  if (
    current.providerOperationId !== null &&
    current.providerOperationId !== input.providerOperationId
  )
    throw new Error("external_operation_provider_identity_conflict");
  if (input.status === "submitted" && input.providerOperationId === null)
    throw new Error("external_operation_provider_identity_required");
  if (input.updatedAt < current.updatedAt)
    throw new Error("external_operation_time_regression");
  return {
    ...current,
    status: input.status,
    resultJson: input.resultJson,
    providerOperationId: input.providerOperationId,
    revision: current.revision + 1,
    updatedAt: input.updatedAt,
  };
}

function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    Buffer.byteLength(value) > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error("external_operation_identity_invalid");
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new Error("external_operation_digest_invalid");
}
function uuid(value: string) {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
      value,
    )
  )
    throw new Error("external_operation_id_invalid");
}
function timestamp(value: string) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("external_operation_time_invalid");
}
