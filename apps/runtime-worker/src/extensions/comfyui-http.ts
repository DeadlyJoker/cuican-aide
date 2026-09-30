import {
  NetworkEgressResolver,
  ProductionNetworkEgressPolicy,
  type NetworkDnsResolver,
} from "../network-egress.ts";
import {
  PinnedNodeHttpTransport,
  type PinnedHttpPort,
} from "../pinned-node-http.ts";
import { ComfyApiError, type ComfyJsonHttpPort } from "./comfyui-api.ts";

/** The host supplies a fixed service origin. Tool inputs cannot select paths or destinations. */
export class ProductionComfyHttp implements ComfyJsonHttpPort {
  readonly #baseUrl: string;
  readonly #tenantId: string;
  readonly #bindingId: string;
  readonly #egress: NetworkEgressResolver;
  readonly #transport: PinnedHttpPort;

  constructor(config: {
    baseUrl: string;
    tenantId: string;
    bindingId: string;
    dns?: NetworkDnsResolver;
    transport?: PinnedHttpPort;
  }) {
    this.#baseUrl = comfyServiceUrl(config.baseUrl);
    if (
      ![config.tenantId, config.bindingId].every(
        (value) =>
          typeof value === "string" &&
          value.trim() === value &&
          value.length > 0 &&
          Buffer.byteLength(value) <= 512 &&
          !/[\u0000-\u001f\u007f]/u.test(value),
      )
    )
      throw new ComfyApiError("comfy_network_binding_invalid");
    this.#tenantId = config.tenantId;
    this.#bindingId = config.bindingId;
    this.#egress = new NetworkEgressResolver({
      dns: config.dns,
      policy: new ProductionNetworkEgressPolicy(),
    });
    this.#transport = config.transport ?? new PinnedNodeHttpTransport();
  }

  async request(
    input: Parameters<ComfyJsonHttpPort["request"]>[0],
  ): Promise<unknown> {
    if (
      !(
        input.method === "POST" &&
        input.path === "/prompt" &&
        input.body !== undefined
      ) &&
      !(
        input.method === "GET" &&
        input.body === undefined &&
        (input.path === "/queue" ||
          /^\/history\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
            input.path,
          ))
      )
    )
      throw new ComfyApiError("comfy_request_not_allowed");
    const body =
      input.body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(input.body));
    if (body !== undefined && body.length > 128 * 1024)
      throw new ComfyApiError("comfy_request_too_large");
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
    const target = await this.#egress.resolve(
      {
        tenantId: this.#tenantId,
        scopeId: this.#bindingId,
        endpoint: new URL(input.path, this.#baseUrl),
      },
      signal,
    );
    const response = await this.#transport.request(
      {
        method: input.method,
        target,
        body,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        maxRequestBytes: 128 * 1024,
        maxResponseBytes: 1024 * 1024,
      },
      signal,
    );
    // Redirects and provider response text must never become trusted destinations or model errors.
    if (response.status !== 200) throw new ComfyApiError("comfy_http_failed");
    if (response.body.byteLength > 1024 * 1024)
      throw new ComfyApiError("comfy_response_too_large");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(response.body),
      );
    } catch {
      throw new ComfyApiError("comfy_response_invalid");
    }
  }
}

export function comfyServiceUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new ComfyApiError("comfy_service_url_invalid");
  return url.href;
}
