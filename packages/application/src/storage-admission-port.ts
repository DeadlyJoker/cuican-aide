/** Gates new work; settlement, cancellation and recovery must not use this gate. */
export interface StorageAdmissionPort {
  assertNewWorkAllowed(): Promise<void>;
}

export class StorageAdmissionError extends Error {
  readonly code: "storage_capacity_low" | "storage_capacity_unknown";
  readonly retryAfterMs: number;

  constructor(code: StorageAdmissionError["code"], retryAfterMs = 30_000) {
    super(code);
    this.name = "StorageAdmissionError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
