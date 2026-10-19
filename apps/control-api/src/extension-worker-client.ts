import { createHash } from "node:crypto";
import { observePluginGenerationPhase as observe } from "./installed-plugin-invocation-diagnostics.ts";
import type {
  ActorContext,
  ExtensionCatalogPort,
  ExtensionHostPort,
  ExtensionReadiness,
  ExtensionRegistration,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parseExtensionManifest,
  validateExtensionConfiguration,
} from "@crewon/domain";
import {
  EXTENSION_HOST_PRIVATE_PATH,
  EXTENSION_HOST_WIRE_LIMITS,
  parseExtensionHostActor,
  parseExtensionHostRequest,
  parseExtensionHostResponse,
  type ExtensionHostRegistrationIdentity,
  type ExtensionHostRequest,
  type ExtensionHostResponse,
} from "@crewon/contracts";

/** One authenticated standalone peer. Requests carry only identity supplied by Control's trusted boundary. */
export class LoopbackExtensionHostClient implements ExtensionHostPort {
  readonly #url: URL;
  readonly #token: string;
  readonly #deadlineMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #controllers = new Set<AbortController>();
  readonly #pending = new Set<Promise<ExtensionHostResponse>>();
  #closed = false;

  constructor(
    input: { origin: string; token: string; deadlineMs?: number },
    dependencies: { fetch?: typeof globalThis.fetch } = {},
  ) {
    const checked = parseLoopbackExtensionHostConfig(input);
    this.#url = loopbackUrl(checked.origin);
    this.#token = checked.token;
    this.#deadlineMs = checked.deadlineMs;
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Startup negotiation returns an immutable synchronous catalog; every admission rechecks Worker readiness. */
  async loadCatalog(
    actorInput: ActorContext,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<ExtensionCatalogPort> {
    const actor = parseExtensionHostActor(actorInput);
    const response = await this.#post(
      parseExtensionHostRequest({
        protocol: "crewon.extension-host-request.v0",
        operation: "catalog",
        actor,
      }),
      options.signal,
    );
    if (response.operation !== "catalog") throw responseInvalid();
    const registrations = Object.freeze(
      response.registrations.map((entry) => parseRegistration(entry)),
    );
    const indexed = new Map<string, ExtensionRegistration>();
    for (const registration of registrations) {
      const key = registrationKey(
        registration.manifest.pluginId,
        registration.manifest.version,
      );
      if (indexed.has(key)) throw responseInvalid();
      indexed.set(key, registration);
    }
    return Object.freeze({
      list: () => registrations,
      resolve: (
        identity: Readonly<{ pluginId: string; pluginVersion: string }>,
      ) =>
        indexed.get(
          registrationKey(identity.pluginId, identity.pluginVersion),
        ) ?? null,
    });
  }

  async validateConfiguration(
    input: Parameters<ExtensionHostPort["validateConfiguration"]>[0],
  ): Promise<void> {
    const checked = configurationRequest(input);
    const response = await this.#post(
      parseExtensionHostRequest({
        protocol: "crewon.extension-host-request.v0",
        operation: "validateConfiguration",
        ...checked,
      }),
    );
    if (response.operation !== "validateConfiguration") throw responseInvalid();
    assertConfigurationEcho(
      response,
      checked.registration,
      checked.configuration.contentDigest,
    );
  }

  async evaluate(
    input: Parameters<ExtensionHostPort["evaluate"]>[0],
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<ExtensionReadiness> {
    const checked = configurationRequest(input);
    const request = parseExtensionHostRequest({
      protocol: "crewon.extension-host-request.v0",
      operation: "readiness",
      ...checked,
      agentVersionId: input.agentVersionId,
    });
    if (request.operation !== "readiness") throw requestInvalid();
    const response = await observe("readiness.host-evaluate", () =>
      this.#post(request, options.signal),
    );
    if (
      response.operation !== "readiness" ||
      response.agentVersionId !== request.agentVersionId
    )
      throw responseInvalid();
    assertConfigurationEcho(
      response,
      checked.registration,
      checked.configuration.contentDigest,
    );
    if (response.result.outcome === "unavailable") return response.result;
    try {
      const target = parseExtensionExecutionTarget(response.result.target);
      if (target.agentVersionId !== request.agentVersionId)
        throw responseInvalid();
      return Object.freeze({ outcome: "ready", target });
    } catch (error) {
      throw responseInvalid(error);
    }
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      const reason = new ExtensionHostWorkerError("extension_host_closed");
      for (const controller of this.#controllers) controller.abort(reason);
    }
    await Promise.allSettled([...this.#pending]);
  }

  #post(
    request: ExtensionHostRequest,
    signal?: AbortSignal,
  ): Promise<ExtensionHostResponse> {
    if (this.#closed)
      return Promise.reject(
        new ExtensionHostWorkerError("extension_host_closed"),
      );
    if (signal?.aborted) return Promise.reject(signal.reason);
    const controller = new AbortController();
    const aborted = () => controller.abort(signal?.reason);
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
    this.#controllers.add(controller);
    const timer = setTimeout(
      () =>
        controller.abort(
          new ExtensionHostWorkerError("extension_host_deadline_exceeded"),
        ),
      this.#deadlineMs,
    );
    timer.unref();
    const task = (async () => {
      let receivedResponse = false;
      try {
        const response = await abortable(
          this.#fetch(this.#url, {
            method: "POST",
            headers: {
              "accept": "application/json",
              "authorization": `Bearer ${this.#token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
            redirect: "error",
            signal: controller.signal,
          }),
          controller.signal,
        );
        receivedResponse = true;
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          throw new ExtensionHostWorkerError(
            response.status === 401 || response.status === 403
              ? "extension_host_authentication_failed"
              : "extension_host_unavailable",
          );
        }
        const parsed = parseExtensionHostResponse(
          await readBoundedJson(response, controller.signal),
        );
        if (
          parsed.operation !== request.operation ||
          !sameActor(parsed.actor, request.actor)
        )
          throw responseInvalid();
        return parsed;
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof ExtensionHostWorkerError) throw error;
        if (!receivedResponse)
          throw new ExtensionHostWorkerError("extension_host_unavailable", {
            cause: error,
          });
        throw responseInvalid(error);
      } finally {
        signal?.removeEventListener("abort", aborted);
        clearTimeout(timer);
        this.#controllers.delete(controller);
      }
    })();
    this.#pending.add(task);
    void task.then(
      () => this.#pending.delete(task),
      () => this.#pending.delete(task),
    );
    return task;
  }
}

/** Pure peer validation; disabling the plugin never needs to construct a client or open a connection. */
export function parseLoopbackExtensionHostConfig(input: {
  origin: string;
  token: string;
  deadlineMs?: number;
}): Readonly<{ origin: string; token: string; deadlineMs: number }> {
  loopbackUrl(input.origin);
  const tokenBytes = Buffer.byteLength(input.token);
  if (
    tokenBytes < 32 ||
    tokenBytes > 8192 ||
    /[\u0000-\u0020\u007f]/u.test(input.token)
  )
    throw new ExtensionHostWorkerError("extension_host_token_invalid");
  const deadlineMs = input.deadlineMs ?? 10_000;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1_000 ||
    deadlineMs > 30_000
  )
    throw new ExtensionHostWorkerError("extension_host_deadline_invalid");
  return Object.freeze({
    origin: input.origin,
    token: input.token,
    deadlineMs,
  });
}

export class ExtensionHostWorkerError extends Error {
  readonly code: string;
  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "ExtensionHostWorkerError";
    this.code = code;
  }
}

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`,
};

function configurationRequest(
  input: Parameters<ExtensionHostPort["validateConfiguration"]>[0],
) {
  try {
    const actor = parseExtensionHostActor(input.actor);
    const registration = parseRegistration(input.registration);
    const configuration = parseExtensionConfiguration(
      input.configuration,
      digester,
    );
    if (
      configuration.tenantId !== actor.tenantId ||
      configuration.spaceId !== actor.spaceId ||
      configuration.pluginId !== registration.manifest.pluginId ||
      configuration.pluginVersion !== registration.manifest.version ||
      configuration.manifestDigest !== registration.manifestDigest ||
      configuration.implementationDigest !== registration.implementationDigest
    )
      throw requestInvalid();
    validateExtensionConfiguration(
      registration.manifest,
      configuration.parameters,
    );
    return { actor, registration: identity(registration), configuration };
  } catch (error) {
    throw requestInvalid(error);
  }
}

function parseRegistration(
  input: Readonly<{
    manifest: unknown;
    manifestDigest: string;
    implementationDigest: string;
  }>,
): ExtensionRegistration {
  try {
    const manifest = parseExtensionManifest(input.manifest);
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(input.implementationDigest) ||
      digester.sha256(extensionCanonicalJson(manifest)) !== input.manifestDigest
    )
      throw responseInvalid();
    return Object.freeze({
      manifest,
      manifestDigest: input.manifestDigest,
      implementationDigest: input.implementationDigest,
    });
  } catch (error) {
    throw responseInvalid(error);
  }
}
function identity(
  registration: ExtensionRegistration,
): ExtensionHostRegistrationIdentity {
  return {
    pluginId: registration.manifest.pluginId,
    pluginVersion: registration.manifest.version,
    manifestDigest: registration.manifestDigest,
    implementationDigest: registration.implementationDigest,
  };
}
function registrationKey(pluginId: string, pluginVersion: string): string {
  return JSON.stringify([pluginId, pluginVersion]);
}
function assertConfigurationEcho(
  response: Readonly<{
    registration: ExtensionHostRegistrationIdentity;
    configurationDigest: string;
  }>,
  expected: ExtensionHostRegistrationIdentity,
  configurationDigest: string,
) {
  if (
    response.configurationDigest !== configurationDigest ||
    response.registration.pluginId !== expected.pluginId ||
    response.registration.pluginVersion !== expected.pluginVersion ||
    response.registration.manifestDigest !== expected.manifestDigest ||
    response.registration.implementationDigest !== expected.implementationDigest
  )
    throw responseInvalid();
}
function sameActor(left: ActorContext, right: ActorContext): boolean {
  return (
    left.principalId === right.principalId &&
    left.actorId === right.actorId &&
    left.tenantId === right.tenantId &&
    left.spaceId === right.spaceId
  );
}
function loopbackUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      Number(url.port) < 1 ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== value
    )
      throw new Error();
    url.pathname = EXTENSION_HOST_PRIVATE_PATH;
    return url;
  } catch (error) {
    throw new ExtensionHostWorkerError("extension_host_origin_invalid", {
      cause: error,
    });
  }
}
async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    void response.body?.cancel().catch(() => {});
    throw responseInvalid();
  }
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/u.test(length) ||
      Number(length) > EXTENSION_HOST_WIRE_LIMITS.messageBytes)
  ) {
    void response.body?.cancel().catch(() => {});
    throw responseInvalid();
  }
  if (response.body === null) throw responseInvalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunksRead = 0;
  let complete = false;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      if (++chunksRead > EXTENSION_HOST_WIRE_LIMITS.messageBytes)
        throw responseInvalid();
      total += next.value.byteLength;
      if (total > EXTENSION_HOST_WIRE_LIMITS.messageBytes)
        throw responseInvalid();
      chunks.push(next.value);
    }
    complete = true;
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, total),
      ),
    );
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}
function responseInvalid(cause?: unknown): ExtensionHostWorkerError {
  return new ExtensionHostWorkerError("extension_host_response_invalid", {
    cause,
  });
}
function requestInvalid(cause?: unknown): ExtensionHostWorkerError {
  return new ExtensionHostWorkerError("extension_host_request_invalid", {
    cause,
  });
}
