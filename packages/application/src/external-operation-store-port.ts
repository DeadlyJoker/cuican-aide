/** Host-owned scope. Never construct this from model-supplied Tool arguments. */
export type ExternalOperationScope = Readonly<{
  tenantId: string;
  runId: string;
  bindingDigest: string;
}>;

export type ExternalOperationState = Readonly<{
  status:
    | "submitting"
    | "submitted"
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "unknownOutcome";
  /** Provider-specific bounded JSON, containing references rather than media bytes. */
  resultJson: string | null;
}>;

export type ExternalOperation = ExternalOperationScope &
  ExternalOperationState &
  Readonly<{
    schemaVersion: "crewon.external-operation.v0";
    operationId: string;
    executionId: string;
    idempotencyKey: string;
    actionDigest: string;
    requestDigest: string;
    /** Persisted before dispatch; identifies a potentially accepted request after response loss. */
    correlationId: string;
    providerOperationId: string | null;
    revision: number;
    createdAt: string;
    updatedAt: string;
  }>;

export type ReserveExternalOperation = ExternalOperationScope &
  Pick<
    ExternalOperation,
    | "operationId"
    | "executionId"
    | "idempotencyKey"
    | "actionDigest"
    | "requestDigest"
    | "correlationId"
    | "createdAt"
  >;

export type ExternalOperationLocator = ExternalOperationScope &
  Pick<ExternalOperation, "operationId">;
export type AdvanceExternalOperation = ExternalOperationLocator &
  ExternalOperationState &
  Readonly<{
    expectedRevision: number;
    providerOperationId: string | null;
    updatedAt: string;
  }>;

/** A successful reservation is permission for exactly one dispatch, never a retry token. */
export interface ExternalOperationStore {
  reserveExternalOperation(input: ReserveExternalOperation): Promise<
    Readonly<{
      disposition: "created" | "existing";
      operation: ExternalOperation;
    }>
  >;
  loadExternalOperation(
    input: ExternalOperationLocator,
  ): Promise<ExternalOperation | null>;
  advanceExternalOperation(input: AdvanceExternalOperation): Promise<
    Readonly<{
      disposition: "updated" | "conflict";
      operation: ExternalOperation;
    }>
  >;
}
