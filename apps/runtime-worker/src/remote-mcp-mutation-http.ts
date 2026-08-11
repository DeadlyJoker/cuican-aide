import type {
  CrewonRemoteMcpMutationHttpPort,
  CrewonRemoteMcpMutationHttpRequest,
} from "@crewon/mcp-runtime";

import {
  NetworkEgressResolver,
  ProductionNetworkEgressPolicy,
  type NetworkEgressPolicy,
  type NetworkDnsResolver,
} from "./network-egress.ts";
import {
  type PinnedHttpPort,
  PinnedNodeHttpTransport,
} from "./pinned-node-http.ts";

const MAX_ID_BYTES = 512;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

/** Production adapter; composition must supply the tenant's strict egress policy. */
export class ProductionRemoteMcpMutationHttp
  implements CrewonRemoteMcpMutationHttpPort
{
  readonly #tenantId: string;
  readonly #serverBindingId: string;
  readonly #egress: NetworkEgressResolver;
  readonly #transport: PinnedHttpPort;

  constructor(config: {
    tenantId: string;
    serverBindingId: string;
    egressPolicy: NetworkEgressPolicy;
    dns?: NetworkDnsResolver;
    transport?: PinnedHttpPort;
  }) {
    this.#tenantId = boundedId(config.tenantId);
    this.#serverBindingId = boundedId(config.serverBindingId);
    this.#egress = new NetworkEgressResolver({
      dns: config.dns,
      policy: andPolicy(
        new ProductionNetworkEgressPolicy(),
        config.egressPolicy,
      ),
    });
    this.#transport = config.transport ?? new PinnedNodeHttpTransport();
  }

  async post(request: CrewonRemoteMcpMutationHttpRequest): Promise<Response> {
    const target = await this.#egress.resolve(
      {
        tenantId: this.#tenantId,
        scopeId: this.#serverBindingId,
        endpoint: request.endpoint,
      },
      request.signal,
    );
    const response = await this.#transport.request(
      {
        method: "POST",
        target,
        headers: request.headers,
        body: request.body,
        maxRequestBytes: MAX_REQUEST_BYTES,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      },
      request.signal,
    );
    const headers = new Headers();
    for (const name of ["content-type", "content-length"]) {
      const value = response.headers[name];
      if (value !== undefined) headers.set(name, value);
    }
    return new Response(Buffer.from(response.body), {
      status: response.status,
      headers,
    });
  }
}

function andPolicy(
  baseline: NetworkEgressPolicy,
  tenant: NetworkEgressPolicy,
): NetworkEgressPolicy {
  return {
    authorize: async (input) => {
      await baseline.authorize(input);
      return tenant.authorize(input);
    },
  };
}

function boundedId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_ID_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("remote_mcp_network_binding_invalid");
  }
  return value;
}
