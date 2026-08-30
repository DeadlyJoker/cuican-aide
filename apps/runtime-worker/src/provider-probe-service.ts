import type {
  ModelProviderProbeRequest,
  ModelProviderProbeResult,
  ModelProviderSettingsStore,
  ModelProviderSetting,
} from "@crewon/application";

import { ResponsesProviderConnectivityProbe } from "./provider-connectivity-probe.ts";
import {
  ProviderProbeEgressResolver,
  type ProviderProbeDnsResolver,
  type ProviderProbeEgressPolicy,
} from "./provider-probe-egress.ts";

export type RuntimeProviderBinding = Readonly<{
  runtimeBindingId: string;
  providerId: string;
  endpoint: string;
  credentialKind: "environment" | "keychain" | "none";
  environmentVariable: string | null;
}>;

export type RuntimeProviderSecretLease = Readonly<{
  value: string;
  release(): void;
}>;

/** Secrets are resolved only inside the Worker and released after one probe. */
export interface RuntimeProviderSecretResolver {
  resolve(
    binding: RuntimeProviderBinding,
    signal: AbortSignal,
  ):
    | RuntimeProviderSecretLease
    | null
    | Promise<RuntimeProviderSecretLease | null>;
}

export class EnvironmentProviderSecretResolver
  implements RuntimeProviderSecretResolver
{
  readonly #environment: Readonly<Record<string, string | undefined>>;

  constructor(
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.#environment = environment;
  }

  resolve(
    binding: RuntimeProviderBinding,
    _signal: AbortSignal,
  ): RuntimeProviderSecretLease | null {
    if (binding.credentialKind === "none") return null;
    if (
      binding.credentialKind !== "environment" ||
      binding.environmentVariable === null
    ) {
      return null;
    }
    const value = this.#environment[binding.environmentVariable];
    if (value === undefined || value.length === 0) return null;
    return { value, release: () => {} };
  }
}

type ConnectivityProbe = Readonly<{
  probe(signal: AbortSignal): Promise<ModelProviderProbeResult>;
}>;

type ConnectivityProbeFactory = (input: {
  tenantId: string;
  binding: RuntimeProviderBinding;
  catalogRevision: number;
  secret: string | null;
  egress: ProviderProbeEgressResolver;
}) => ConnectivityProbe;

export class RuntimeProviderProbeService {
  readonly #store: ModelProviderSettingsStore;
  readonly #tenantId: string;
  readonly #runtimeBinding: RuntimeProviderBinding;
  readonly #secrets: RuntimeProviderSecretResolver;
  readonly #egress: ProviderProbeEgressResolver;
  readonly #createProbe: ConnectivityProbeFactory;
  readonly #rateLimiter: FixedWindowRateLimiter;
  readonly #concurrencyLimit: number;
  readonly #deadlineMs: number;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  #active = 0;

  constructor(
    dependencies: {
      store: ModelProviderSettingsStore;
      tenantId: string;
      runtimeBinding: RuntimeProviderBinding;
      secrets: RuntimeProviderSecretResolver;
      egressPolicy: ProviderProbeEgressPolicy;
      dns?: ProviderProbeDnsResolver;
    },
    options: {
      createProbe?: ConnectivityProbeFactory;
      now?: () => number;
      rateLimit?: number;
      rateWindowMs?: number;
      concurrencyLimit?: number;
      deadlineMs?: number;
      schedule?: (callback: () => void, delayMs: number) => () => void;
    } = {},
  ) {
    this.#store = dependencies.store;
    this.#tenantId = bounded(dependencies.tenantId, 512);
    this.#runtimeBinding = validateRuntimeBinding(dependencies.runtimeBinding);
    this.#secrets = dependencies.secrets;
    this.#egress = new ProviderProbeEgressResolver({
      dns: dependencies.dns,
      policy: dependencies.egressPolicy,
    });
    this.#createProbe =
      options.createProbe ??
      ((input) =>
        new ResponsesProviderConnectivityProbe(
          {
            tenantId: input.tenantId,
            providerId: input.binding.providerId,
            catalogRevision: input.catalogRevision,
            runtimeBindingId: input.binding.runtimeBindingId,
            endpoint: input.binding.endpoint,
            secret: input.secret,
          },
          { egress: input.egress },
        ));
    this.#rateLimiter = new FixedWindowRateLimiter(
      options.rateLimit ?? 3,
      options.rateWindowMs ?? 30_000,
      options.now ?? Date.now,
    );
    this.#concurrencyLimit = positiveInteger(
      options.concurrencyLimit ?? 1,
      32,
      "provider_probe_concurrency_limit_invalid",
    );
    this.#deadlineMs = positiveInteger(
      options.deadlineMs ?? 10_000,
      10_000,
      "provider_probe_deadline_invalid",
    );
    this.#schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      });
  }

  async probe(
    input: ModelProviderProbeRequest,
    signal: AbortSignal,
  ): Promise<ModelProviderProbeResult> {
    validateRequest(input);
    if (input.tenantId !== this.#tenantId) {
      return mismatch(this.#runtimeBinding, input.expectedRevision);
    }
    const retryAfterMs = this.#rateLimiter.take();
    if (retryAfterMs !== null || this.#active >= this.#concurrencyLimit) {
      return rateLimited(
        this.#runtimeBinding,
        input.expectedRevision,
        retryAfterMs ?? 1_000,
      );
    }
    this.#active += 1;
    const deadline = new AbortController();
    const cancelDeadline = this.#schedule(
      () => deadline.abort(new Error("provider_probe_deadline_exceeded")),
      this.#deadlineMs,
    );
    const combined = AbortSignal.any([signal, deadline.signal]);
    let secretLease: RuntimeProviderSecretLease | null = null;
    try {
      const before = await abortable(
        this.#store.loadModelProviderSettingsState({
          tenantId: this.#tenantId,
        }),
        combined,
      );
      const binding = matchingBinding(
        before,
        input.expectedRevision,
        input.expectedProviderId,
        input.expectedRuntimeBindingId,
        this.#runtimeBinding,
      );
      if (binding === null) {
        return mismatch(this.#runtimeBinding, input.expectedRevision);
      }
      const secretResolution = Promise.resolve(
        this.#secrets.resolve(this.#runtimeBinding, combined),
      );
      void secretResolution.then(
        (lease) => {
          if (combined.aborted) lease?.release();
        },
        () => {},
      );
      secretLease = await abortable(secretResolution, combined);
      if (binding.credentialKind !== "none" && !validSecretLease(secretLease)) {
        return credentialMissing(this.#runtimeBinding, input.expectedRevision);
      }
      const result = await abortable(
        this.#createProbe({
          tenantId: this.#tenantId,
          binding: this.#runtimeBinding,
          catalogRevision: input.expectedRevision,
          secret: secretLease?.value ?? null,
          egress: this.#egress,
        }).probe(combined),
        combined,
      );
      const after = await abortable(
        this.#store.loadModelProviderSettingsState({
          tenantId: this.#tenantId,
        }),
        combined,
      );
      if (
        matchingBinding(
          after,
          input.expectedRevision,
          input.expectedProviderId,
          input.expectedRuntimeBindingId,
          this.#runtimeBinding,
        ) === null ||
        result.providerId !== binding.providerId ||
        result.catalogRevision !== input.expectedRevision ||
        result.runtimeBindingId !== this.#runtimeBinding.runtimeBindingId
      ) {
        return mismatch(this.#runtimeBinding, input.expectedRevision);
      }
      return result;
    } catch (error) {
      if (deadline.signal.aborted && !signal.aborted) {
        return unreachable(this.#runtimeBinding, input.expectedRevision);
      }
      throw error;
    } finally {
      try {
        secretLease?.release();
      } finally {
        cancelDeadline();
        this.#active -= 1;
      }
    }
  }
}

function matchingBinding(
  state: Awaited<
    ReturnType<ModelProviderSettingsStore["loadModelProviderSettingsState"]>
  >,
  expectedRevision: number,
  expectedProviderId: string,
  expectedRuntimeBindingId: string,
  runtime: RuntimeProviderBinding,
): ModelProviderSetting | null {
  if (
    state.pending !== null ||
    state.catalog === null ||
    state.catalog.revision !== expectedRevision ||
    expectedProviderId !== runtime.providerId ||
    expectedRuntimeBindingId !== runtime.runtimeBindingId ||
    state.catalog.activeProviderId !== runtime.providerId ||
    state.catalog.runtimeBindingId !== runtime.runtimeBindingId
  ) {
    return null;
  }
  const binding = state.catalog.bindings.find(
    ({ providerId }) => providerId === runtime.providerId,
  );
  return binding !== undefined &&
    binding.endpoint === runtime.endpoint &&
    binding.credentialKind === runtime.credentialKind &&
    binding.environmentVariable === runtime.environmentVariable
    ? binding
    : null;
}

function validateRuntimeBinding(
  value: RuntimeProviderBinding,
): RuntimeProviderBinding {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).sort().join("\0") !==
      [
        "credentialKind",
        "endpoint",
        "environmentVariable",
        "providerId",
        "runtimeBindingId",
      ]
        .sort()
        .join("\0") ||
    (value.credentialKind !== "environment" &&
      value.credentialKind !== "keychain" &&
      value.credentialKind !== "none") ||
    (value.credentialKind === "environment"
      ? typeof value.environmentVariable !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.environmentVariable)
      : value.environmentVariable !== null)
  ) {
    throw new Error("provider_probe_runtime_binding_invalid");
  }
  const endpoint = new URL(value.endpoint);
  if (
    (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("provider_probe_runtime_binding_invalid");
  }
  return {
    runtimeBindingId: bounded(value.runtimeBindingId, 512),
    providerId: bounded(value.providerId, 128),
    endpoint: value.endpoint,
    credentialKind: value.credentialKind,
    environmentVariable: value.environmentVariable,
  };
}

function validateRequest(value: ModelProviderProbeRequest): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).sort().join("\0") !==
      [
        "expectedProviderId",
        "expectedRevision",
        "expectedRuntimeBindingId",
        "tenantId",
      ]
        .sort()
        .join("\0") ||
    typeof value.expectedProviderId !== "string" ||
    value.expectedProviderId.length === 0 ||
    value.expectedProviderId.length > 128 ||
    typeof value.expectedRuntimeBindingId !== "string" ||
    value.expectedRuntimeBindingId.length === 0 ||
    value.expectedRuntimeBindingId.length > 512 ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 1
  ) {
    throw new Error("provider_probe_request_invalid");
  }
  bounded(value.tenantId, 512);
  bounded(value.expectedProviderId, 128);
  bounded(value.expectedRuntimeBindingId, 512);
}

function validSecretLease(
  value: RuntimeProviderSecretLease | null,
): value is RuntimeProviderSecretLease {
  return (
    value !== null &&
    typeof value.value === "string" &&
    value.value.length > 0 &&
    new TextEncoder().encode(value.value).byteLength <= 16 * 1024 &&
    !/[\u0000-\u001f\u007f]/u.test(value.value) &&
    typeof value.release === "function"
  );
}

class FixedWindowRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #windowStartedAt: number | null = null;
  #lastNow: number | null = null;
  #count = 0;

  constructor(limit: number, windowMs: number, now: () => number) {
    this.#limit = positiveInteger(
      limit,
      1_000,
      "provider_probe_rate_limit_invalid",
    );
    this.#windowMs = positiveInteger(
      windowMs,
      86_400_000,
      "provider_probe_rate_window_invalid",
    );
    this.#now = now;
  }

  take(): number | null {
    const now = this.#now();
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      (this.#lastNow !== null && now < this.#lastNow)
    ) {
      throw new Error("provider_probe_clock_invalid");
    }
    this.#lastNow = now;
    if (
      this.#windowStartedAt === null ||
      now - this.#windowStartedAt >= this.#windowMs
    ) {
      this.#windowStartedAt = now;
      this.#count = 0;
    }
    if (this.#count >= this.#limit) {
      return Math.max(1, this.#windowMs - (now - this.#windowStartedAt));
    }
    this.#count += 1;
    return null;
  }
}

function mismatch(
  runtime: RuntimeProviderBinding,
  catalogRevision: number,
): ModelProviderProbeResult {
  return empty(runtime, catalogRevision, "bindingMismatch");
}

function credentialMissing(
  runtime: RuntimeProviderBinding,
  catalogRevision: number,
): ModelProviderProbeResult {
  return empty(runtime, catalogRevision, "credentialMissing");
}

function rateLimited(
  runtime: RuntimeProviderBinding,
  catalogRevision: number,
  retryAfterMs: number,
): ModelProviderProbeResult {
  return {
    ...empty(runtime, catalogRevision, "rateLimited"),
    retryable: true,
    retryAfterMs,
  };
}

function unreachable(
  runtime: RuntimeProviderBinding,
  catalogRevision: number,
): ModelProviderProbeResult {
  return {
    ...empty(runtime, catalogRevision, "unreachable"),
    retryable: true,
  };
}

function empty(
  runtime: RuntimeProviderBinding,
  catalogRevision: number,
  status: ModelProviderProbeResult["status"],
): ModelProviderProbeResult {
  return {
    providerId: runtime.providerId,
    catalogRevision,
    runtimeBindingId: runtime.runtimeBindingId,
    status,
    models: null,
    modelCount: null,
    latencyMs: 0,
    retryable: false,
    retryAfterMs: null,
  };
}

function bounded(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    new TextEncoder().encode(value).byteLength > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("provider_probe_value_invalid");
  }
  return value;
}

function positiveInteger(value: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(code);
  }
  return value;
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
