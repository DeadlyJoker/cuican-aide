import { createHash } from "node:crypto";
import type { ExternalOperationStore } from "@crewon/application";
import {
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parsePluginProfileScope,
} from "@crewon/domain";
import {
  NetworkEgressResolver,
  ProductionNetworkEgressPolicy,
} from "../network-egress.ts";
import { SystemProviderProbeDnsResolver } from "../provider-probe-egress.ts";
import { captureInstalledPluginExecutionIoConfig } from "./installed-plugin-execution-io-config.ts";
import {
  captureNetworkApproval,
  ioJson,
  ioRecord,
} from "./plugin-execution-io-network.ts";
import type {
  InstalledPluginExecutionReadinessDependencies,
  InstalledPluginExecutionReadinessInput,
  InstalledPluginExecutionReadinessMetadata,
  InstalledPluginExecutionReadinessPort,
} from "./installed-plugin-execution-readiness-types.ts";
export type {
  InstalledPluginExecutionReadinessDependencies,
  InstalledPluginExecutionReadinessInput,
  InstalledPluginExecutionReadinessMetadata,
  InstalledPluginExecutionReadinessPort,
} from "./installed-plugin-execution-readiness-types.ts";
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

/** IO preflight only. Borrowed Store/transport lifetime and actual dispatch belong to the composition owner. */
export class InstalledPluginExecutionReadinessOwner
  implements InstalledPluginExecutionReadinessPort
{
  readonly #configuration: InstalledPluginExecutionReadinessDependencies["configuration"];
  readonly #operations: ExternalOperationStore | null;
  readonly #maximumChecks: number;
  readonly #timeoutMs: number;
  readonly #pending = new Set<Promise<void>>();
  readonly #controllers = new Set<AbortController>();
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(input: InstalledPluginExecutionReadinessDependencies) {
    const maximum = input.maximumChecks ?? 32;
    const timeout = input.timeoutMs ?? 5_000;
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 32 ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > 30_000
    )
      fail("configuration_invalid");
    this.#configuration =
      input.configuration === undefined
        ? undefined
        : captureInstalledPluginExecutionIoConfig(input.configuration);
    const operations = input.operations;
    this.#operations =
      operations !== undefined &&
      [
        "reserveExternalOperation",
        "loadExternalOperation",
        "advanceExternalOperation",
      ].every(
        (name) =>
          typeof operations[name as keyof ExternalOperationStore] ===
          "function",
      )
        ? Object.freeze({
            reserveExternalOperation:
              operations.reserveExternalOperation.bind(operations),
            loadExternalOperation:
              operations.loadExternalOperation.bind(operations),
            advanceExternalOperation:
              operations.advanceExternalOperation.bind(operations),
          })
        : null;
    this.#maximumChecks = maximum;
    this.#timeoutMs = timeout;
  }

  assertReady(
    input: InstalledPluginExecutionReadinessInput,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#closed) return Promise.reject(error("closed"));
    signal.throwIfAborted();
    const captured = captureInput(input);
    if (captured.requiredServices.length === 0) return Promise.resolve();
    if (this.#pending.size >= this.#maximumChecks)
      return Promise.reject(error("capacity_exceeded"));
    const controller = new AbortController();
    const operationSignal = AbortSignal.any([signal, controller.signal]);
    this.#controllers.add(controller);
    const timer = setTimeout(
      () => controller.abort(error("timeout")),
      this.#timeoutMs,
    );
    // Retain the actual physical callback/DNS promise after logical cancellation or timeout.
    const work = Promise.resolve()
      .then(() => this.#check(captured, operationSignal))
      .finally(() => {
        clearTimeout(timer);
        this.#controllers.delete(controller);
        this.#pending.delete(work);
      });
    this.#pending.add(work);
    return abortable(work, operationSignal);
  }

  async #check(
    input: InstalledPluginExecutionReadinessInput,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const configuration = this.#configuration;
    if (
      configuration?.resolveReadinessNetwork === undefined ||
      this.#operations === null
    )
      fail("services_unavailable");
    const approved = await configuration.resolveReadinessNetwork(
      input.metadata,
      signal,
    );
    signal.throwIfAborted();
    if (approved === null) fail("services_unavailable");
    const network = captureNetworkApproval(approved);
    const baseUrl =
      input.metadata.configuration.parameters[network.baseUrlParameter];
    if (
      typeof baseUrl !== "string" ||
      baseUrl.trim() !== baseUrl ||
      /[\u0000-\u001f\u007f]/u.test(baseUrl)
    )
      fail("network_unavailable");
    let endpoint: URL;
    try {
      endpoint = new URL(baseUrl);
    } catch {
      return fail("network_unavailable");
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== "/"
    )
      fail("network_unavailable");
    // The callback supplies approved paths. This check validates them but never sends GET or POST.
    if (
      !network.paths.some(
        (path) => input.metadata.purpose === "submit" || path.method === "GET",
      )
    )
      fail("network_unavailable");
    const actualDns = configuration.dns ?? new SystemProviderProbeDnsResolver();
    const physicalDns = new Set<Promise<unknown>>();
    const resolver = new NetworkEgressResolver({
      policy: new ProductionNetworkEgressPolicy(),
      dns: {
        resolveAll: (hostname) => {
          const task = Promise.resolve().then(() =>
            actualDns.resolveAll(hostname),
          );
          physicalDns.add(task);
          return task;
        },
      },
    });
    try {
      await resolver.resolve(
        {
          tenantId: input.metadata.scope.tenantId,
          scopeId: input.metadata.identity.packageDigest,
          endpoint,
        },
        signal,
      );
      signal.throwIfAborted();
    } finally {
      // The egress resolver's logical abort cannot prove its DNS callback physically ended.
      await Promise.allSettled([...physicalDns]);
    }
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    for (const controller of this.#controllers)
      controller.abort(error("closed"));
    this.#closing = Promise.allSettled([...this.#pending]).then(() => {});
    return this.#closing;
  }
}

function captureInput(
  input: InstalledPluginExecutionReadinessInput,
): InstalledPluginExecutionReadinessInput {
  const value = ioRecord(ioJson(input, 256 * 1024), [
    "metadata",
    "requiredServices",
  ]);
  const raw = ioRecord(value.metadata, [
    "identity",
    "scope",
    "configuration",
    "target",
    "purpose",
  ]);
  const identity = ioRecord(raw.identity, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
  ]);
  if (
    !["pluginId", "publisherId", "version"].every(
      (key) =>
        typeof identity[key] === "string" &&
        identity[key].length >= 1 &&
        identity[key].length <= 256 &&
        identity[key].trim() === identity[key],
    ) ||
    typeof identity.packageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(identity.packageDigest) ||
    (raw.purpose !== "submit" && raw.purpose !== "observe") ||
    !Array.isArray(value.requiredServices) ||
    value.requiredServices.length > 2 ||
    new Set(value.requiredServices).size !== value.requiredServices.length ||
    !value.requiredServices.every(
      (item) => item === "externalOperations" || item === "jsonHttp",
    )
  )
    fail("metadata_invalid");
  const scope = parsePluginProfileScope(
    raw.scope as Parameters<typeof parsePluginProfileScope>[0],
  );
  const configuration = parseExtensionConfiguration(
    raw.configuration as Parameters<typeof parseExtensionConfiguration>[0],
    digester,
  );
  const target = parseExtensionExecutionTarget(
    raw.target as Parameters<typeof parseExtensionExecutionTarget>[0],
  );
  if (
    configuration.tenantId !== scope.tenantId ||
    configuration.spaceId !== scope.spaceId ||
    configuration.pluginId !== identity.pluginId ||
    configuration.pluginVersion !== identity.version
  )
    fail("metadata_invalid");
  return Object.freeze({
    metadata: Object.freeze({
      identity: Object.freeze(
        identity,
      ) as InstalledPluginExecutionReadinessMetadata["identity"],
      scope: Object.freeze(scope),
      configuration: ioJson(
        configuration,
        256 * 1024,
      ) as unknown as InstalledPluginExecutionReadinessMetadata["configuration"],
      target: Object.freeze(target),
      purpose: raw.purpose,
    }),
    requiredServices: Object.freeze(value.requiredServices),
  }) as InstalledPluginExecutionReadinessInput;
}
function error(code: string): Error {
  return new Error("installed_plugin_execution_readiness_" + code);
}
function fail(code: string): never {
  throw error(code);
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (failure) => {
        signal.removeEventListener("abort", abort);
        reject(failure);
      },
    );
  });
}
