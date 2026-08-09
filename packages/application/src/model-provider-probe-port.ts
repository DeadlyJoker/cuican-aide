export type ModelProviderProbeStatus =
  | "ok"
  | "credentialMissing"
  | "authenticationFailed"
  | "rateLimited"
  | "providerError"
  | "unreachable"
  | "invalidResponse"
  | "bindingMismatch";

export type ModelProviderProbeModel = Readonly<{
  id: string;
  displayName: string | null;
}>;

export type ModelProviderProbeResult = Readonly<{
  providerId: string;
  catalogRevision: number;
  runtimeBindingId: string;
  status: ModelProviderProbeStatus;
  models: readonly ModelProviderProbeModel[] | null;
  modelCount: number | null;
  latencyMs: number;
  retryable: boolean;
  retryAfterMs: number | null;
}>;

export type ModelProviderProbeRequest = Readonly<{
  tenantId: string;
  expectedRevision: number;
  expectedProviderId: string;
  expectedRuntimeBindingId: string;
}>;

/** Private Control-to-Worker boundary for a bounded Provider `/models` probe. */
export interface ModelProviderProbeWorkerPort {
  probe(
    input: ModelProviderProbeRequest,
    signal: AbortSignal,
  ): Promise<ModelProviderProbeResult>;
}
