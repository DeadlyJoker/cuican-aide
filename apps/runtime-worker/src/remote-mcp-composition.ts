import {
  ConfiguredRemoteMcpClient,
  CrewonRemoteMcpMutationProvider,
  McpRuntimeGroup,
  McpToolRuntime,
  type CrewonRemoteMcpCredentialLeasePort,
} from "@crewon/mcp-runtime";

import type {
  NetworkDnsResolver,
  NetworkEgressPolicy,
} from "./network-egress.ts";
import type { PinnedHttpPort } from "./pinned-node-http.ts";
import { ProductionRemoteMcpMutationHttp } from "./remote-mcp-mutation-http.ts";
import type {
  RemoteMcpRuntimeConfig,
  RemoteMcpServerConfig,
} from "./remote-mcp-runtime-config.ts";

export type RemoteMcpBindingIdentity = Readonly<{
  mode: RemoteMcpServerConfig["mode"];
  tenantId: string;
  agentVersionId: string;
  contentDigest: string;
  materializationDigest: string;
  serverBindingId: string;
  credentialBindingId: string;
  endpoint: string;
}>;

export type RemoteMcpCompositionDependencies =
  | Readonly<{
      mode: "production";
      credentialLeaseFactory(
        identity: RemoteMcpBindingIdentity,
      ): CrewonRemoteMcpCredentialLeasePort;
      tenantEgressFactory(identity: RemoteMcpBindingIdentity): Readonly<{
        policy: NetworkEgressPolicy;
        dns?: NetworkDnsResolver;
        transport?: PinnedHttpPort;
      }>;
    }>
  | Readonly<{
      mode: "standaloneLoopback";
      staticBearerResolver(identity: RemoteMcpBindingIdentity): string;
      fetch?: typeof globalThis.fetch;
    }>;

type ReleaseBinding = Readonly<{
  tenantId: string;
  agentVersionId: string;
  contentDigest: string;
  materializationDigest: string;
}>;

/** Composes one connected runtime per immutable Remote MCP server catalog. */
export async function composeRemoteMcpRuntime(
  config: RemoteMcpRuntimeConfig,
  release: ReleaseBinding,
  dependencies: RemoteMcpCompositionDependencies,
): Promise<McpRuntimeGroup> {
  assertReleaseBinding(release);
  if (config.servers.some((server) => server.mode !== dependencies.mode)) {
    throw new Error("remote_mcp_composition_mode_mismatch");
  }
  const runtimes: McpToolRuntime[] = [];
  try {
    for (const server of config.servers) {
      runtimes.push(createServerRuntime(server, release, dependencies));
    }
    const group = new McpRuntimeGroup(runtimes);
    await group.connect(new AbortController().signal);
    return group;
  } catch (error) {
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    throw error;
  }
}

function createServerRuntime(
  server: RemoteMcpServerConfig,
  release: ReleaseBinding,
  dependencies: RemoteMcpCompositionDependencies,
): McpToolRuntime {
  const identity = Object.freeze({
    mode: server.mode,
    ...release,
    serverBindingId: server.serverBindingId,
    credentialBindingId: server.credentialBindingId,
    endpoint: server.endpoint,
  });
  const mutationProvider =
    dependencies.mode === "production"
      ? productionProvider(server, identity, dependencies)
      : new CrewonRemoteMcpMutationProvider({
          endpoint: server.endpoint,
          auth: {
            kind: "bearer",
            token: dependencies.staticBearerResolver(identity),
          },
          network: {
            mode: "standaloneLoopback",
            ...(dependencies.fetch === undefined
              ? {}
              : { fetch: dependencies.fetch }),
          },
        });
  const client = new ConfiguredRemoteMcpClient({
    descriptors: server.tools.map(({ descriptor }) => descriptor),
    mutationProvider,
  });
  return new McpToolRuntime({
    serverId: server.serverId,
    client,
    policies: new Map(
      server.tools.map(({ descriptor, policy }) => [descriptor.name, policy]),
    ),
  });
}

function productionProvider(
  server: RemoteMcpServerConfig,
  identity: RemoteMcpBindingIdentity,
  dependencies: Extract<
    RemoteMcpCompositionDependencies,
    { mode: "production" }
  >,
): CrewonRemoteMcpMutationProvider {
  const credentialPort = dependencies.credentialLeaseFactory(identity);
  if (typeof credentialPort?.acquire !== "function") {
    throw new Error("remote_mcp_composition_dependencies_invalid");
  }
  const network = dependencies.tenantEgressFactory(identity);
  if (typeof network?.policy?.authorize !== "function") {
    throw new Error("remote_mcp_composition_dependencies_invalid");
  }
  return new CrewonRemoteMcpMutationProvider({
    endpoint: server.endpoint,
    auth: { kind: "credentialLease", port: credentialPort },
    network: {
      mode: "production",
      http: new ProductionRemoteMcpMutationHttp({
        tenantId: identity.tenantId,
        serverBindingId: identity.serverBindingId,
        egressPolicy: network.policy,
        ...(network.dns === undefined ? {} : { dns: network.dns }),
        ...(network.transport === undefined
          ? {}
          : { transport: network.transport }),
      }),
    },
  });
}

function assertReleaseBinding(value: ReleaseBinding): void {
  if (
    typeof value.tenantId !== "string" ||
    value.tenantId.length === 0 ||
    typeof value.agentVersionId !== "string" ||
    value.agentVersionId.length === 0 ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.contentDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.materializationDigest)
  ) {
    throw new Error("remote_mcp_release_binding_invalid");
  }
}
