import { createRemoteProjectServices } from "./remote-project-services.ts";
import { createHash } from "node:crypto";
import type {
  ActorContext,
  AuthorizationPort,
  ProjectPlanningRuntimePort,
} from "@crewon/application";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  extensionDigest,
  extensionOpaqueId,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import type { InstalledPluginExecutionConfig } from "./installed-plugin-runtime-composition.ts";
import type { InstalledPluginReleaseIdentity } from "./installed-plugin-release-document.ts";
import {
  assertInstalledPluginWorkerConfig,
  type InstalledPluginWorkerConfig,
  type InstalledPluginWorkerEndpoint,
} from "./installed-plugin-worker-config.ts";
import {
  captureNetworkApproval,
  ioJson,
  ioRecord,
} from "./plugin-execution-io-network.ts";
import { snapshotContext } from "./plugin-tool-runtime-adapter-data.ts";
import type { InstalledPluginExecutionReadinessMetadata } from "./installed-plugin-execution-readiness-types.ts";
import type { InstalledPluginExtensionHostDependencies } from "./installed-plugin-extension-host.ts";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type { InstalledPluginAuthorityConfig } from "./installed-plugin-authority-config.ts";
import {
  createInstalledPluginNativeWorkerAuthority,
  prepareInstalledPluginNativeWorkerAuthority,
} from "./installed-plugin-native-authority.ts";

export type InstalledPluginReadAuthorityInput = Readonly<{
  identity: InstalledPluginReleaseIdentity;
  scope: PluginProfileScope;
  purpose: "read";
}>;
export type InstalledPluginWorkerAuthority = Readonly<{
  installRoot: string;
  releaseDocumentPath: string;
  authorizeRead(
    input: InstalledPluginReadAuthorityInput,
    signal: AbortSignal,
  ): Promise<"allow" | "deny">;
  /** Fresh profile authority also serves generation peers when historical observation is disabled. */
  resolveProfile: InstalledPluginExtensionHostDependencies["resolveProfile"];
  installedPluginExecution: InstalledPluginExecutionConfig;
  /** Explicit Native metadata/proposal approval; remote configurations expose none by default. */
  projectPlanning?: ProjectPlanningRuntimePort;
  close(): Promise<void>;
}>;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const digester = {
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
};

function failure(code: string): never {
  throw new Error(`installed_plugin_worker_authority_${code}`);
}
function actor(input: unknown): ActorContext {
  const value = ioRecord(input, [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
  ]);
  return Object.freeze({
    principalId: extensionOpaqueId(value.principalId),
    actorId: extensionOpaqueId(value.actorId),
    tenantId: extensionOpaqueId(value.tenantId),
    spaceId: extensionOpaqueId(value.spaceId),
  });
}
function identity(input: unknown): InstalledPluginReleaseIdentity {
  const value = ioRecord(input, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
  ]);
  return Object.freeze({
    pluginId: extensionOpaqueId(value.pluginId),
    publisherId: extensionOpaqueId(value.publisherId),
    version: extensionOpaqueId(value.version),
    packageDigest: extensionDigest(value.packageDigest),
  });
}
function outcome(input: unknown): "allow" | "deny" {
  const value = ioRecord(input, ["outcome"]);
  if (value.outcome !== "allow" && value.outcome !== "deny")
    failure("decision_invalid");
  return value.outcome;
}
function policyOutcome(input: unknown) {
  const value = ioRecord(input, ["outcome"], ["reasonCode"]);
  if (value.outcome === "allow" && value.reasonCode === undefined)
    return { outcome: "allow" as const };
  if (value.outcome === "deny")
    return {
      outcome: "deny" as const,
      reasonCode:
        value.reasonCode === undefined
          ? "installed_plugin_execution_denied"
          : extensionOpaqueId(value.reasonCode),
    };
  return failure("decision_invalid");
}
function policyPayload(input: Parameters<AuthorizationPort["authorize"]>[0]) {
  const value = ioRecord(ioJson(input, MAX_REQUEST_BYTES), [
    "actor",
    "action",
    "resource",
  ]);
  const current = actor(value.actor);
  const resource = ioRecord(
    value.resource,
    ["kind", "tenantId", "spaceId"],
    ["threadId", "runId", "pluginId", "agentVersionId"],
  );
  if (
    resource.tenantId !== current.tenantId ||
    resource.spaceId !== current.spaceId
  )
    failure("scope_mismatch");
  switch (value.action) {
    case "run:read":
    case "run:execute":
      ioRecord(resource, ["kind", "tenantId", "spaceId", "threadId", "runId"]);
      if (resource.kind !== "run") failure("request_invalid");
      extensionOpaqueId(resource.threadId);
      if (resource.runId !== null) extensionOpaqueId(resource.runId);
      break;
    case "extension:read":
    case "extension:run":
    case "extension:query":
      ioRecord(resource, ["kind", "tenantId", "spaceId", "pluginId"]);
      if (resource.kind !== "extension") failure("request_invalid");
      extensionOpaqueId(resource.pluginId);
      break;
    case "agentVersion:read":
      ioRecord(resource, ["kind", "tenantId", "spaceId", "agentVersionId"]);
      if (resource.kind !== "agentVersion") failure("request_invalid");
      extensionOpaqueId(resource.agentVersionId);
      break;
    default:
      failure("request_invalid");
  }
  return { actor: current, action: value.action, resource };
}
function readinessMetadata(input: InstalledPluginExecutionReadinessMetadata) {
  const value = ioRecord(ioJson(input, MAX_REQUEST_BYTES), [
    "identity",
    "scope",
    "configuration",
    "target",
    "purpose",
  ]);
  const packageIdentity = identity(value.identity),
    scope = parsePluginProfileScope(value.scope);
  const configuration = parseExtensionConfiguration(
    value.configuration,
    digester,
  );
  const target = parseExtensionExecutionTarget(value.target);
  if (
    (value.purpose !== "submit" && value.purpose !== "observe") ||
    configuration.tenantId !== scope.tenantId ||
    configuration.spaceId !== scope.spaceId ||
    configuration.pluginId !== packageIdentity.pluginId ||
    configuration.pluginVersion !== packageIdentity.version ||
    target.executionAuthority !== "crewonKernel"
  )
    failure("scope_mismatch");
  return {
    identity: packageIdentity,
    scope,
    configuration,
    target,
    purpose: value.purpose,
  };
}

/** Logical cancellation never frees a slot until the actual HTTP/body operation terminates. */
class AuthorityHttpOwner {
  readonly #config: InstalledPluginWorkerConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #controllers = new Set<AbortController>();
  readonly #physical = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<void> | null = null;
  constructor(
    config: InstalledPluginWorkerConfig,
    fetch: typeof globalThis.fetch,
  ) {
    this.#config = config;
    this.#fetch = fetch;
  }
  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    return (this.#closing = Promise.allSettled([...this.#physical]).then(
      () => {},
    ));
  }
  post(
    endpoint: InstalledPluginWorkerEndpoint,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(
        new Error("installed_plugin_worker_authority_closed"),
      );
    if (this.#physical.size >= 128)
      return Promise.reject(
        new Error("installed_plugin_worker_authority_busy"),
      );
    signal?.throwIfAborted();
    const body = JSON.stringify(ioJson(payload, MAX_REQUEST_BYTES));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.#controllers.add(controller);
    let rejectLogical!: (reason: Error) => void;
    const logical = new Promise<never>((_, reject) => {
      rejectLogical = reject;
    });
    const onAbort = () =>
      rejectLogical(new Error("installed_plugin_worker_authority_unavailable"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(abort, this.#config.timeoutMs);
    const physical = Promise.resolve().then(() => {
      if (this.#closed || controller.signal.aborted) failure("unavailable");
      return this.#http(endpoint, body, controller.signal);
    });
    this.#physical.add(physical);
    void physical
      .finally(() => {
        this.#physical.delete(physical);
        this.#controllers.delete(controller);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", onAbort);
      })
      .catch(() => {});
    return Promise.race([physical, logical]).then((value) => {
      if (this.#closed || controller.signal.aborted || signal?.aborted)
        failure("unavailable");
      return value;
    });
  }
  async #http(
    endpoint: InstalledPluginWorkerEndpoint,
    body: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.#fetch(endpoint.url, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal,
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "authorization": `Bearer ${endpoint.serviceToken}`,
      },
      body,
    });
    const media = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const length = response.headers.get("content-length");
    if (
      signal.aborted ||
      response.status !== 200 ||
      (media !== "application/json" && media?.endsWith("+json") !== true) ||
      (length !== null &&
        (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES))
    ) {
      await response.body?.cancel();
      failure("response_invalid");
    }
    if (response.body === null) failure("response_invalid");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (signal.aborted || total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          failure("response_invalid");
        }
        chunks.push(part.value);
      }
      signal.throwIfAborted();
      const bytes = Buffer.concat(chunks, total);
      return ioJson(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        MAX_RESPONSE_BYTES,
      );
    } finally {
      reader.releaseLock();
    }
  }
}

/** A deployment-owned authority bridge. Responses are current decisions, never cached grants. */
export function createInstalledPluginWorkerAuthority(
  config: InstalledPluginAuthorityConfig,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): InstalledPluginWorkerAuthority {
  if ("nativeAuthorityPath" in config)
    return createInstalledPluginNativeWorkerAuthority(config);
  assertInstalledPluginWorkerConfig(config);
  const http = new AuthorityHttpOwner(config, fetch);
  const authorizePackage = async (
    input:
      | InstalledPluginReadAuthorityInput
      | Readonly<{
          identity: InstalledPluginReleaseIdentity;
          scope: PluginProfileScope;
          purpose: "submit" | "observe";
        }>,
    signal: AbortSignal,
  ) => {
    const value = ioRecord(input, ["identity", "scope", "purpose"]);
    if (
      value.purpose !== "read" &&
      value.purpose !== "submit" &&
      value.purpose !== "observe"
    )
      failure("request_invalid");
    return outcome(
      await http.post(
        config.packageAuthority,
        {
          schemaVersion: "crewon.plugin-execution-package.v1",
          identity: identity(value.identity),
          scope: parsePluginProfileScope(value.scope),
          purpose: value.purpose,
        },
        signal,
      ),
    );
  };
  const resolveProfile = async (input: ActorContext, signal: AbortSignal) => {
    const current = actor(input);
    const scope = parsePluginProfileScope(
      await http.post(config.profileAuthority, { actor: current }, signal),
    );
    if (
      scope.tenantId !== current.tenantId ||
      scope.spaceId !== current.spaceId
    )
      failure("scope_mismatch");
    return scope;
  };
  const execution: InstalledPluginExecutionConfig = Object.freeze({
    ...(config.projectServiceAuthority === undefined
      ? {}
      : createRemoteProjectServices((body, signal) =>
          http.post(config.projectServiceAuthority!, body, signal),
        )),
    installRoot: config.installRoot,
    authorization: Object.freeze({
      authorize: async (
        input: Parameters<AuthorizationPort["authorize"]>[0],
      ) => {
        return policyOutcome(
          await http.post(config.policyAuthority, policyPayload(input)),
        );
      },
    }),
    resolveActor: async (input, signal) => {
      const value = ioRecord(input, ["tenantId", "spaceId", "actorId"]);
      const owner = Object.freeze({
        tenantId: extensionOpaqueId(value.tenantId),
        spaceId: extensionOpaqueId(value.spaceId),
        actorId: extensionOpaqueId(value.actorId),
      });
      const response = await http.post(
        config.actorAuthority,
        { schemaVersion: "crewon.plugin-execution-actor.v1", owner },
        signal,
      );
      if (response === null) return null;
      const current = actor(response);
      if (
        current.tenantId !== owner.tenantId ||
        current.spaceId !== owner.spaceId ||
        current.actorId !== owner.actorId
      )
        failure("identity_mismatch");
      return current;
    },
    authorizePackage: async (input, signal) => {
      const value = ioRecord(input, ["candidate", "scope", "purpose"]);
      if (value.purpose !== "submit" && value.purpose !== "observe")
        failure("request_invalid");
      const candidate = ioRecord(ioJson(value.candidate, MAX_REQUEST_BYTES), [
        "descriptor",
        "packageDigest",
      ]);
      const descriptor = parsePluginPackageDescriptor(candidate.descriptor);
      return authorizePackage(
        {
          identity: {
            pluginId: descriptor.pluginId,
            publisherId: descriptor.publisherId,
            version: descriptor.version,
            packageDigest: extensionDigest(candidate.packageDigest),
          },
          scope: parsePluginProfileScope(value.scope),
          purpose: value.purpose as "submit" | "observe",
        },
        signal,
      );
    },
    ...(config.networkAuthority === null
      ? {}
      : {
          executionIo: Object.freeze({
            resolveNetwork: async (
              context: PluginToolRuntimeContext,
              signal: AbortSignal,
            ) => {
              const response = await http.post(
                config.networkAuthority!,
                {
                  schemaVersion: "crewon.plugin-execution-network.v1",
                  kind: "run",
                  context: snapshotContext(context),
                },
                signal,
              );
              return response === null
                ? null
                : captureNetworkApproval(response);
            },
            resolveReadinessNetwork: async (
              metadata: InstalledPluginExecutionReadinessMetadata,
              signal: AbortSignal,
            ) => {
              const response = await http.post(
                config.networkAuthority!,
                {
                  schemaVersion: "crewon.plugin-execution-network.v1",
                  kind: "readiness",
                  metadata: readinessMetadata(metadata),
                },
                signal,
              );
              return response === null
                ? null
                : captureNetworkApproval(response);
            },
          }),
        }),
    ...(config.historicalScope === null
      ? {}
      : {
          historicalQuery: Object.freeze({
            scope: config.historicalScope,
            resolveProfile,
          }),
        }),
  });
  return Object.freeze({
    installRoot: config.installRoot,
    releaseDocumentPath: config.releaseDocumentPath,
    authorizeRead: authorizePackage,
    resolveProfile,
    installedPluginExecution: execution,
    close: () => http.close(),
  });
}

/** Production Main uses the asynchronous path; legacy metadata/remote callers retain their existing API. */
export async function prepareInstalledPluginWorkerAuthority(
  config: InstalledPluginAuthorityConfig,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<InstalledPluginWorkerAuthority> {
  return "nativeAuthorityPath" in config
    ? prepareInstalledPluginNativeWorkerAuthority(config, environment)
    : createInstalledPluginWorkerAuthority(config);
}
