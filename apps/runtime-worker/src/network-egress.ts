import {
  ProviderProbeEgressError,
  ProviderProbeEgressResolver,
  type ProviderProbeDnsResolver,
  type ProviderProbeResolvedAddress,
  providerAddressKind,
} from "./provider-probe-egress.ts";

export type NetworkResolvedAddress = ProviderProbeResolvedAddress;
export type NetworkEgressInput = Readonly<{
  tenantId: string;
  scopeId: string;
  endpoint: URL;
  addresses: readonly NetworkResolvedAddress[];
}>;
export type NetworkEgressDecision = Readonly<{
  approvedAddresses: readonly string[];
}>;

export interface NetworkEgressPolicy {
  authorize(
    input: NetworkEgressInput,
  ): NetworkEgressDecision | Promise<NetworkEgressDecision>;
}

export type NetworkDnsResolver = ProviderProbeDnsResolver;
export type PinnedNetworkEndpoint = Readonly<{
  endpoint: URL;
  address: string;
  family: 4 | 6;
}>;

export class NetworkEgressError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "NetworkEgressError";
    this.code = code;
  }
}

/** Business-neutral compatibility layer over the provider probe resolver. */
export class NetworkEgressResolver {
  readonly #resolver: ProviderProbeEgressResolver;

  constructor(dependencies: {
    dns?: NetworkDnsResolver;
    policy: NetworkEgressPolicy;
  }) {
    this.#resolver = new ProviderProbeEgressResolver({
      dns: dependencies.dns,
      policy: {
        authorize: ({ tenantId, providerId, endpoint, addresses }) =>
          dependencies.policy.authorize({
            tenantId,
            scopeId: providerId,
            endpoint,
            addresses,
          }),
      },
    });
  }

  async resolve(
    input: Readonly<{ tenantId: string; scopeId: string; endpoint: URL }>,
    signal: AbortSignal,
  ): Promise<PinnedNetworkEndpoint> {
    try {
      return await this.#resolver.resolve(
        {
          tenantId: input.tenantId,
          providerId: input.scopeId,
          endpoint: input.endpoint,
        },
        signal,
      );
    } catch (error) {
      if (error instanceof ProviderProbeEgressError) {
        throw new NetworkEgressError(
          error.code.replace(/^provider_probe_/u, "network_"),
        );
      }
      throw error;
    }
  }
}

/** Production policy permits only public HTTPS addresses. */
export class ProductionNetworkEgressPolicy implements NetworkEgressPolicy {
  authorize(input: NetworkEgressInput): NetworkEgressDecision {
    if (
      input.endpoint.protocol !== "https:" ||
      !input.addresses.every(
        ({ address }) => providerAddressKind(address) === "public",
      )
    ) {
      throw new NetworkEgressError("network_egress_denied");
    }
    return { approvedAddresses: input.addresses.map(({ address }) => address) };
  }
}
