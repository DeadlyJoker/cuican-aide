export type CrewonRemoteMcpMutationPhase = "execute" | "reconcile" | "cancel";

/** Identity and cancellation context for one remote mutation credential lease. */
export interface CrewonRemoteMcpCredentialAcquireInput {
  readonly phase: CrewonRemoteMcpMutationPhase;
  readonly providerExecutionId: string;
  readonly toolName: string;
  readonly signal: AbortSignal;
}

/** Narrow destination that accepts a lease's bearer exactly once. */
export interface CrewonRemoteMcpBearerSink {
  applyBearer(token: string): void;
}

/** Short-lived credential capability owned by one provider invocation. */
export interface CrewonRemoteMcpCredentialLease {
  apply(sink: CrewonRemoteMcpBearerSink): void | Promise<void>;
  release(): void | Promise<void>;
}

/** Acquires per-invocation credentials; factories may capture immutable binding context. */
export interface CrewonRemoteMcpCredentialLeasePort {
  acquire(
    input: CrewonRemoteMcpCredentialAcquireInput,
  ): CrewonRemoteMcpCredentialLease | Promise<CrewonRemoteMcpCredentialLease>;
}

export type CrewonRemoteMcpMutationHttpRequest = Readonly<{
  endpoint: URL;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  signal: AbortSignal;
}>;

/** Production implementations must validate every DNS answer and pin the socket. */
export interface CrewonRemoteMcpMutationHttpPort {
  post(request: CrewonRemoteMcpMutationHttpRequest): Promise<Response>;
}

export type CrewonRemoteMcpMutationProviderConfig = Readonly<{
  endpoint: string | URL;
  deadlineMs?: number;
}> &
  (
    | Readonly<{
        auth: Readonly<{
          kind: "credentialLease";
          port: CrewonRemoteMcpCredentialLeasePort;
        }>;
        network: Readonly<{
          mode: "production";
          http: CrewonRemoteMcpMutationHttpPort;
        }>;
      }>
    | Readonly<{
        auth: Readonly<{ kind: "bearer"; token: string }>;
        network: Readonly<{
          mode: "standaloneLoopback";
          fetch?: typeof globalThis.fetch;
        }>;
      }>
  );

export type CredentialAuthorization =
  | Readonly<{ kind: "bearer"; authorization: string }>
  | Readonly<{
      kind: "credentialLease";
      port: CrewonRemoteMcpCredentialLeasePort;
    }>;

export class CredentialPreparationFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CredentialPreparationFailure";
    this.code = code;
  }
}

export function validateProviderConfig(
  config: unknown,
): asserts config is CrewonRemoteMcpMutationProviderConfig {
  if (
    !plainObject(config) ||
    !onlyKeys(config, ["endpoint", "deadlineMs", "auth", "network"])
  )
    failConfig();
  if (!("endpoint" in config) || !("auth" in config) || !("network" in config))
    failConfig();
  if (
    "deadlineMs" in config &&
    (typeof config.deadlineMs !== "number" ||
      !Number.isSafeInteger(config.deadlineMs) ||
      config.deadlineMs < 1 ||
      config.deadlineMs > 60_000)
  )
    failConfig();
  if (!plainObject(config.auth) || !plainObject(config.network)) failConfig();
  const auth = config.auth;
  const network = config.network;
  const production =
    network.mode === "production" &&
    exactKeys(network, ["mode", "http"]) &&
    objectWithMethod(network.http, "post") &&
    auth.kind === "credentialLease" &&
    exactKeys(auth, ["kind", "port"]) &&
    objectWithMethod(auth.port, "acquire");
  const standalone =
    network.mode === "standaloneLoopback" &&
    onlyKeys(network, ["mode", "fetch"]) &&
    (!("fetch" in network) || typeof network.fetch === "function") &&
    auth.kind === "bearer" &&
    exactKeys(auth, ["kind", "token"]);
  if (!production && !standalone) failConfig();
}

export function credentialAuthorization(
  config: CrewonRemoteMcpMutationProviderConfig,
): CredentialAuthorization {
  return config.auth.kind === "bearer"
    ? { kind: "bearer", authorization: validateBearer(config.auth.token) }
    : { kind: "credentialLease", port: config.auth.port };
}

export async function prepareAuthorization(
  auth: CredentialAuthorization,
  headers: Record<string, string>,
  identity: Omit<CrewonRemoteMcpCredentialAcquireInput, "signal">,
  signal: AbortSignal,
  external: AbortSignal,
  deadline: AbortSignal,
): Promise<() => void> {
  if (signal.aborted) throw abortedFailure(external, deadline);
  if (auth.kind === "bearer") {
    headers.authorization = auth.authorization;
    return () => {
      delete headers.authorization;
    };
  }
  const abort = abortPromise(signal);
  const pending = Promise.resolve().then(() =>
    auth.port.acquire({ ...identity, signal }),
  );
  let lease: unknown;
  try {
    lease = await Promise.race([pending, abort.promise]);
  } catch {
    abort.cleanup();
    if (signal.aborted) {
      void pending.then(releaseUnknown, () => undefined);
      throw abortedFailure(external, deadline);
    }
    throw new CredentialPreparationFailure(
      "remote_mcp_mutation_credential_acquire_failed",
    );
  }
  if (!credentialLease(lease)) {
    abort.cleanup();
    releaseUnknown(lease);
    throw new CredentialPreparationFailure(
      "remote_mcp_mutation_credential_acquire_failed",
    );
  }
  const sink = sealedBearerSink(headers);
  try {
    await Promise.race([Promise.resolve(lease.apply(sink)), abort.promise]);
    sink.seal(true);
  } catch {
    sink.seal(false);
    abort.cleanup();
    releaseUnknown(lease);
    if (signal.aborted) throw abortedFailure(external, deadline);
    throw new CredentialPreparationFailure(
      "remote_mcp_mutation_credential_apply_failed",
    );
  }
  abort.cleanup();
  return () => {
    delete headers.authorization;
    releaseUnknown(lease);
  };
}

function sealedBearerSink(
  headers: Record<string, string>,
): CrewonRemoteMcpBearerSink & { seal(success: boolean): void } {
  let applied = false;
  let sealed = false;
  return {
    applyBearer(token) {
      if (sealed) return;
      if (applied) throw new TypeError("credential_bearer_already_applied");
      headers.authorization = validateBearer(token);
      applied = true;
    },
    seal(success) {
      sealed = true;
      if (!success) {
        delete headers.authorization;
        return;
      }
      if (!applied) throw new TypeError("credential_bearer_not_applied");
    },
  };
}

function releaseUnknown(value: unknown): void {
  try {
    if (typeof value !== "object" || value === null) return;
    const release = (value as { release?: unknown }).release;
    if (typeof release !== "function") return;
    Promise.resolve(release.call(value)).catch(() => undefined);
  } catch {
    // Release is detached, best-effort, and deliberately code-only.
  }
}

function validateBearer(token: unknown): string {
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    token.length > 4096 ||
    !/^[\x21-\x7e]+$/u.test(token)
  ) {
    throw new CredentialPreparationFailure(
      "remote_mcp_mutation_credential_invalid",
    );
  }
  return `Bearer ${token}`;
}

function abortedFailure(
  external: AbortSignal,
  deadline: AbortSignal,
): CredentialPreparationFailure {
  return new CredentialPreparationFailure(
    external.aborted
      ? "remote_mcp_mutation_aborted"
      : deadline.aborted
        ? "remote_mcp_mutation_deadline_exceeded"
        : "remote_mcp_mutation_aborted",
  );
}

function credentialLease(
  value: unknown,
): value is CrewonRemoteMcpCredentialLease {
  return objectWithMethod(value, "apply") && objectWithMethod(value, "release");
}
function abortPromise(
  signal: AbortSignal,
): Readonly<{ promise: Promise<never>; cleanup(): void }> {
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    rejectPromise = reject;
  });
  const onAbort = () => rejectPromise(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    cleanup: () => signal.removeEventListener("abort", onAbort),
  };
}
function failConfig(): never {
  throw new CredentialPreparationFailure("remote_mcp_mutation_config_invalid");
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function objectWithMethod(value: unknown, method: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[method] === "function"
  );
}
function onlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && onlyKeys(value, keys);
}
