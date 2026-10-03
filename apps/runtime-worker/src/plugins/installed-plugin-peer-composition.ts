import type { RuntimeCompositionLifetime } from "../runtime-composition-lifetime.ts";
import type { StoreBackedAgentVersionRuntimeResolver } from "../store-backed-agent-version-runtime-resolver.ts";
import type { InstalledPluginQueryHost } from "./installed-plugin-query-host.ts";
import { verifyInstalledPluginRelease } from "./installed-plugin-release-loader.ts";
import {
  InstalledPluginPeerService,
  type InstalledPluginPeerServiceDependencies,
} from "./installed-plugin-peer-service.ts";
import {
  startInstalledPluginPeerServer,
  type InstalledPluginPeerServer,
} from "./installed-plugin-peer-server.ts";
import {
  captureInstalledPluginPeerConfig,
  type InstalledPluginPeerCompositionConfig,
} from "./installed-plugin-peer-environment.ts";

export type InstalledPluginPeer = InstalledPluginPeerServer;
export type InstalledPluginPeerCompositionInput = Omit<
  InstalledPluginPeerServiceDependencies,
  "resolveProfile"
> &
  Readonly<{ config: InstalledPluginPeerCompositionConfig }>;

/** Both transports use the caller's actual parent Store; no second runtime or borrowed-owner shutdown. */
export async function composeInstalledPluginPeer(
  input: InstalledPluginPeerCompositionInput,
): Promise<InstalledPluginPeer> {
  const config = captureInstalledPluginPeerCompositionConfig(input.config);
  await verifyInstalledPluginRelease({
    release: input.release,
    store: input.store,
  });
  const service = new InstalledPluginPeerService({
    ...input,
    resolveProfile: config.resolveProfile,
  });
  let server: InstalledPluginPeerServer;
  try {
    server = await startInstalledPluginPeerServer({ ...config, service });
  } catch (error) {
    try {
      await service.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "installed_plugin_peer_startup_cleanup_failed",
      );
    }
    throw error;
  }
  let closing: Promise<void> | null = null;
  return Object.freeze({
    origin: server.origin,
    close() {
      if (closing !== null) return closing;
      let resolve!: () => void, reject!: (error: unknown) => void;
      closing = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // Both calls synchronously fence admission and cancel actual host signals.
      // Joining the server first would wait on calls whose cancellation it cannot own.
      const operations = [service.close(), server.close()];
      void Promise.allSettled(operations)
        .then((results) => {
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length)
            throw new AggregateError(
              failures,
              "installed_plugin_peer_cleanup_failed",
            );
        })
        .then(resolve, reject);
      return closing;
    },
  });
}

export function captureInstalledPluginPeerCompositionConfig(
  input: InstalledPluginPeerCompositionConfig,
): InstalledPluginPeerCompositionConfig {
  const descriptor = Object.getOwnPropertyDescriptor(input, "resolveProfile");
  if (
    !descriptor ||
    !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value !== "function"
  )
    throw new Error("installed_plugin_peer_configuration_invalid");
  return Object.freeze({
    ...captureInstalledPluginPeerConfig(input),
    resolveProfile: descriptor.value.bind(input),
  });
}

export function captureInstalledPluginPeerOptions(
  input: Readonly<{
    installedPluginPeer?: InstalledPluginPeerCompositionConfig;
    installedPluginRelease?: unknown;
    installedPluginExecution?: unknown;
    extensionHost?: unknown;
    extensionRuntime?: unknown;
  }>,
): Readonly<{ installedPluginPeer?: InstalledPluginPeerCompositionConfig }> {
  if (input.installedPluginPeer === undefined) return {};
  if (
    input.installedPluginRelease === undefined ||
    input.installedPluginExecution === undefined ||
    input.extensionHost !== undefined ||
    input.extensionRuntime !== undefined
  )
    throw new Error("installed_plugin_peer_deployment_invalid");
  return {
    installedPluginPeer: captureInstalledPluginPeerCompositionConfig(
      input.installedPluginPeer,
    ),
  };
}

/** Peer/query borrowers drain before their actual shared runtime resolver. */
export function ownInstalledPluginPeerStop(
  input: Readonly<{
    lifetime: RuntimeCompositionLifetime;
    runtimeResolver: StoreBackedAgentVersionRuntimeResolver;
    queryHost: InstalledPluginQueryHost | null;
    peer: InstalledPluginPeer | null;
  }>,
): void {
  const resolver = input.lifetime.own(input.runtimeResolver, { phase: "stop" });
  const borrowers = [input.peer, input.queryHost].flatMap((owner) =>
    owner === null ? [] : [input.lifetime.own(owner, { phase: "stop" })],
  );
  if (borrowers.length === 0) return;
  let closing: Promise<void> | null = null;
  input.lifetime.own(
    {
      close() {
        if (closing !== null) return closing;
        const drains = borrowers.map((owner) => owner.close());
        closing = (async () => {
          const results = await Promise.allSettled(drains);
          try {
            await resolver.close();
          } catch (error) {
            results.push({ status: "rejected", reason: error });
          }
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length)
            throw new AggregateError(
              failures,
              "installed_plugin_peer_stop_failed",
            );
        })();
        return closing;
      },
    },
    { phase: "stop" },
  );
  for (const owner of [...borrowers, resolver]) owner.delegate();
}
