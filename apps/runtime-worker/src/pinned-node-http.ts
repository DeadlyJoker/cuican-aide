import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, SocketAddress } from "node:net";

import type { PinnedNetworkEndpoint } from "./network-egress.ts";

const HARD_MAX_REQUEST_BYTES = 1024 * 1024;
const HARD_MAX_RESPONSE_BYTES = 1024 * 1024;

export type PinnedHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
}>;

export type PinnedHttpRequest = Readonly<{
  method: "GET" | "POST";
  target: PinnedNetworkEndpoint;
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  maxRequestBytes: number;
  maxResponseBytes: number;
}>;

export class PinnedNodeHttpError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "PinnedNodeHttpError";
    this.code = code;
  }
}

export interface PinnedHttpPort {
  request(
    input: PinnedHttpRequest,
    signal: AbortSignal,
  ): Promise<PinnedHttpResponse>;
}

/** Bounded Node HTTP transport with a policy-approved address pinned per request. */
export class PinnedNodeHttpTransport implements PinnedHttpPort {
  readonly #certificateAuthority: string | undefined;
  readonly #remoteAddressMatches: typeof sameRemoteAddress;

  constructor(
    options: {
      certificateAuthority?: string;
      remoteAddressMatches?: typeof sameRemoteAddress;
    } = {},
  ) {
    this.#certificateAuthority = options.certificateAuthority;
    this.#remoteAddressMatches =
      options.remoteAddressMatches ?? sameRemoteAddress;
  }

  async request(
    input: PinnedHttpRequest,
    signal: AbortSignal,
  ): Promise<PinnedHttpResponse> {
    try {
      validateBounds(input);
    } catch (error) {
      if (error instanceof PinnedNodeHttpError) throw error;
      throw new PinnedNodeHttpError("request_invalid");
    }
    try {
      return await new Promise((resolve, reject) => {
        const options: RequestOptions = {
          method: input.method,
          agent: false,
          headers: input.headers,
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all === true) {
              callback(null, [
                { address: input.target.address, family: input.target.family },
              ]);
            } else {
              callback(null, input.target.address, input.target.family);
            }
          },
          signal,
        };
        if (input.target.endpoint.protocol === "https:") {
          const hostname = unbracket(input.target.endpoint.hostname);
          options.servername = isIP(hostname) === 0 ? hostname : undefined;
          options.ca = this.#certificateAuthority;
        }
        const request = (
          input.target.endpoint.protocol === "https:"
            ? httpsRequest
            : httpRequest
        )(input.target.endpoint, options);
        request.once("response", (response) => {
          let remoteAddressMatches = false;
          try {
            remoteAddressMatches = this.#remoteAddressMatches(
              response.socket.remoteAddress,
              input.target.address,
              input.target.family,
            );
          } catch {
            response.destroy(new PinnedNodeHttpError("transport_failed"));
            return;
          }
          if (!remoteAddressMatches) {
            response.destroy(
              new PinnedNodeHttpError("remote_address_mismatch"),
            );
            return;
          }
          const declared = response.headers["content-length"];
          if (
            typeof declared === "string" &&
            (!/^\d+$/u.test(declared) ||
              Number(declared) > input.maxResponseBytes)
          ) {
            response.destroy(new PinnedNodeHttpError("body_too_large"));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += bytes.byteLength;
            if (total > input.maxResponseBytes) {
              response.destroy(new PinnedNodeHttpError("body_too_large"));
            } else {
              chunks.push(bytes);
            }
          });
          response.once("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: Object.fromEntries(
                Object.entries(response.headers).map(([name, value]) => [
                  name,
                  header(value),
                ]),
              ),
              body: Buffer.concat(chunks, total),
            }),
          );
          response.once("error", reject);
        });
        request.once("error", reject);
        request.end(input.body);
      });
    } catch (error) {
      if (error instanceof PinnedNodeHttpError) throw error;
      throw new PinnedNodeHttpError(
        signal.aborted ? "request_aborted" : "transport_failed",
      );
    }
  }
}

function validateBounds(input: PinnedHttpRequest): void {
  if (
    !Number.isSafeInteger(input.maxRequestBytes) ||
    input.maxRequestBytes < 0 ||
    input.maxRequestBytes > HARD_MAX_REQUEST_BYTES ||
    !Number.isSafeInteger(input.maxResponseBytes) ||
    input.maxResponseBytes < 0 ||
    input.maxResponseBytes > HARD_MAX_RESPONSE_BYTES ||
    (input.body?.byteLength ?? 0) > input.maxRequestBytes
  ) {
    throw new PinnedNodeHttpError("body_too_large");
  }
  if (
    (input.method !== "GET" && input.method !== "POST") ||
    (input.method === "GET" && input.body !== undefined) ||
    (input.body !== undefined && !(input.body instanceof Uint8Array)) ||
    (input.target.endpoint.protocol !== "http:" &&
      input.target.endpoint.protocol !== "https:") ||
    input.target.endpoint.username !== "" ||
    input.target.endpoint.password !== ""
  ) {
    throw new PinnedNodeHttpError("request_invalid");
  }
}

export function sameRemoteAddress(
  remoteAddress: string | undefined,
  approvedAddress: string,
  family: 4 | 6,
): boolean {
  if (remoteAddress === undefined) return false;
  if (remoteAddress === approvedAddress) return true;
  if (
    family === 4 &&
    remoteAddress === `::ffff:${approvedAddress.toLowerCase()}`
  ) {
    return true;
  }
  const remote = parseSocketAddress(remoteAddress);
  const approved = parseSocketAddress(approvedAddress);
  return (
    remote !== undefined &&
    approved !== undefined &&
    remote.family === approved.family &&
    remote.address === approved.address
  );
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

function parseSocketAddress(address: string): SocketAddress | undefined {
  return SocketAddress.parse(
    isIP(address) === 6 ? `[${address}]:0` : `${address}:0`,
  );
}

function unbracket(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, "");
}
