import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import { isPluginOperationPathPrefix } from "@crewon/contracts/plugins";
import {
  NetworkEgressResolver,
  ProductionNetworkEgressPolicy,
  type NetworkDnsResolver,
} from "../network-egress.ts";
import {
  PinnedNodeHttpTransport,
  type PinnedHttpPort,
} from "../pinned-node-http.ts";

export type PluginExecutionNetworkApproval = Readonly<{
  /** Name of a URL parameter in the actual immutable Run configuration. */
  baseUrlParameter: string;
  paths: readonly (
    | Readonly<{ method: "GET" | "POST"; path: string }>
    | Readonly<{ method: "GET"; operationPathPrefix: string }>
  )[];
}>;
export type PluginIoHttpRequest = Readonly<{
  method: "GET" | "POST";
  path: string;
  body?: PluginJsonValue;
}>;

export function ioFailure(code: string): never {
  if (code === "request_not_approved") throw new PluginExecutionIoPolicyError();
  throw new Error(`plugin_execution_io_${code}`);
}

/** A deterministic route denial cannot improve by replaying the same frozen request. */
export class PluginExecutionIoPolicyError extends Error {
  readonly code = "plugin_execution_io_request_not_approved";
  constructor() {
    super("plugin_execution_io_request_not_approved");
    this.name = "PluginExecutionIoPolicyError";
  }
}

/** A missing/gone HTTP resource requires service repair, not replaying the frozen tool call. */
export class PluginExecutionIoHttpResourceError extends Error {
  readonly code:
    | "plugin_execution_io_http_404"
    | "plugin_execution_io_http_410";
  readonly status: 404 | 410;
  constructor(status: 404 | 410) {
    const code =
      status === 404
        ? "plugin_execution_io_http_404"
        : "plugin_execution_io_http_410";
    super(code);
    this.code = code;
    this.status = status;
    this.name = "PluginExecutionIoHttpResourceError";
  }
}

/** Pure data only; do not execute plugin accessors while checking an IO request. */
export function ioRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    ioFailure("input_invalid");
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) ioFailure("input_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== "string" || ![...required, ...optional].includes(key),
    ) ||
    required.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some(
      (field) => !field.enumerable || !Object.hasOwn(field, "value"),
    )
  )
    ioFailure("input_invalid");
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, field]) => [key, field.value]),
  );
}

export function ioJson(input: unknown, maximumBytes: number): PluginJsonValue {
  return jsonData(input, maximumBytes).value;
}

function jsonData(
  input: unknown,
  maximumBytes: number,
): Readonly<{ value: PluginJsonValue; text: string }> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 1024 * 1024
  )
    ioFailure("json_limit");
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const fragments: string[] = [];
  const charge = (size: number) => {
    bytes += size;
    if (bytes > maximumBytes) ioFailure("json_limit");
  };
  const token = (text: string) => {
    charge(text.length);
    fragments.push(text);
  };
  const quoted = (value: string) => {
    if (value.length + 2 > maximumBytes - bytes) ioFailure("json_limit");
    charge(2);
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) ioFailure("json_invalid");
        charge(4);
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        ioFailure("json_invalid");
      } else if (unit === 0x22 || unit === 0x5c) {
        charge(2);
      } else if (unit < 0x20) {
        charge([0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(unit) ? 2 : 6);
      } else {
        charge(unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3);
      }
    }
    fragments.push(JSON.stringify(value));
  };
  const dataValue = (value: object, key: string) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !("value" in property))
      ioFailure("json_invalid");
    return property.value;
  };
  const visit = (value: unknown, depth: number): PluginJsonValue => {
    if (++nodes > 65_536 || depth > 64) ioFailure("json_limit");
    if (value === null || typeof value === "boolean") {
      token(JSON.stringify(value));
      return value;
    }
    if (typeof value === "string") {
      quoted(value);
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      token(JSON.stringify(value));
      return Object.is(value, -0) ? 0 : value;
    }
    if (!value || typeof value !== "object") ioFailure("json_invalid");
    if (ancestors.has(value)) ioFailure("json_invalid");
    ancestors.add(value);
    try {
      const prototype = Object.getPrototypeOf(value);
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype) ioFailure("json_invalid");
        const length = Object.getOwnPropertyDescriptor(value, "length")!.value;
        if (length > 65_536) ioFailure("json_limit");
        if (Reflect.ownKeys(value).length !== length + 1)
          ioFailure("json_invalid");
        token("[");
        const copied: PluginJsonValue[] = [];
        for (let i = 0; i < length; i++) {
          if (i !== 0) token(",");
          copied.push(visit(dataValue(value, String(i)), depth + 1));
        }
        token("]");
        return Object.freeze(copied);
      }
      if (prototype !== Object.prototype && prototype !== null)
        ioFailure("json_invalid");
      const keys = Reflect.ownKeys(value);
      if (keys.length > 65_536) ioFailure("json_limit");
      token("{");
      const entries: [string, PluginJsonValue][] = [];
      for (const key of keys) {
        if (typeof key !== "string") ioFailure("json_invalid");
        if (entries.length !== 0) token(",");
        quoted(key);
        token(":");
        entries.push([key, visit(dataValue(value, key), depth + 1)]);
      }
      token("}");
      return Object.freeze(Object.fromEntries(entries));
    } finally {
      ancestors.delete(value);
    }
  };
  const value = visit(input, 0);
  const text = fragments.join("");
  if (Buffer.byteLength(text) !== bytes || bytes > maximumBytes)
    ioFailure("json_limit");
  return { value, text };
}

export function ioPath(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 2_048 ||
    !input.startsWith("/") ||
    input.startsWith("//") ||
    /[\\#\s\u0000-\u001f\u007f]/u.test(input)
  )
    ioFailure("path_invalid");
  const parsed = new URL(input, "https://io.invalid/");
  if (
    parsed.origin !== "https://io.invalid" ||
    parsed.pathname + parsed.search !== input
  )
    ioFailure("path_invalid");
  return input;
}

export function captureNetworkApproval(
  input: unknown,
): PluginExecutionNetworkApproval {
  const record = ioRecord(ioJson(input, 16_384), ["baseUrlParameter", "paths"]);
  if (
    typeof record.baseUrlParameter !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(record.baseUrlParameter) ||
    !Array.isArray(record.paths) ||
    record.paths.length < 1 ||
    record.paths.length > 32
  )
    ioFailure("network_approval_invalid");
  const paths = record.paths.map((input: unknown) => {
    const rule = ioRecord(input, ["method"], ["path", "operationPathPrefix"]);
    if (rule.path !== undefined && rule.operationPathPrefix === undefined) {
      if (rule.method !== "GET" && rule.method !== "POST")
        ioFailure("network_approval_invalid");
      return Object.freeze({ method: rule.method, path: ioPath(rule.path) });
    }
    if (
      rule.path === undefined &&
      rule.method === "GET" &&
      isPluginOperationPathPrefix(rule.operationPathPrefix)
    )
      return Object.freeze({
        method: "GET" as const,
        operationPathPrefix: ioPath(rule.operationPathPrefix),
      });
    return ioFailure("network_approval_invalid");
  });
  return Object.freeze({
    baseUrlParameter: record.baseUrlParameter,
    paths: Object.freeze(paths),
  });
}

/** Uses the same DNS policy, pinned address, TLS and finite transport as the original Comfy adapter. */
export class PluginExecutionJsonHttp {
  readonly #url: string;
  readonly #tenantId: string;
  readonly #bindingId: string;
  readonly #egress: NetworkEgressResolver;
  readonly #transport: PinnedHttpPort;
  constructor(
    input: Readonly<{
      baseUrl: string;
      tenantId: string;
      bindingId: string;
      dns?: NetworkDnsResolver;
      transport?: PinnedHttpPort;
    }>,
  ) {
    let url: URL;
    if (
      typeof input.baseUrl !== "string" ||
      input.baseUrl.trim() !== input.baseUrl ||
      /[\u0000-\u001f\u007f]/u.test(input.baseUrl)
    )
      ioFailure("service_url_invalid");
    try {
      url = new URL(input.baseUrl);
    } catch {
      ioFailure("service_url_invalid");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      ioFailure("service_url_invalid");
    if (
      ![input.tenantId, input.bindingId].every(
        (value) =>
          typeof value === "string" &&
          value.trim() === value &&
          value.length > 0 &&
          Buffer.byteLength(value) <= 512 &&
          !/[\u0000-\u001f\u007f]/u.test(value),
      )
    )
      ioFailure("network_binding_invalid");
    this.#url = url.href;
    this.#tenantId = input.tenantId;
    this.#bindingId = input.bindingId;
    this.#egress = new NetworkEgressResolver({
      dns: input.dns,
      policy: new ProductionNetworkEgressPolicy(),
    });
    this.#transport = input.transport ?? new PinnedNodeHttpTransport();
  }

  async request(
    request: PluginIoHttpRequest,
    signal: AbortSignal,
    beforeDispatch: () => Promise<void>,
  ): Promise<PluginJsonValue> {
    const captured = ioRecord(request, ["method", "path"], ["body"]);
    if (
      (captured.method !== "GET" && captured.method !== "POST") ||
      (captured.method === "GET" && captured.body !== undefined) ||
      typeof beforeDispatch !== "function"
    )
      ioFailure("request_invalid");
    const path = ioPath(captured.path);
    const method = captured.method;
    const body =
      captured.body === undefined
        ? undefined
        : Buffer.from(jsonData(captured.body, 128 * 1024).text);
    signal.throwIfAborted();
    const target = await this.#egress.resolve(
      {
        tenantId: this.#tenantId,
        scopeId: this.#bindingId,
        endpoint: new URL(path, this.#url),
      },
      signal,
    );
    await beforeDispatch();
    signal.throwIfAborted();
    const response = await this.#transport.request(
      {
        method,
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
    if (response.status === 404 || response.status === 410)
      throw new PluginExecutionIoHttpResourceError(response.status);
    if (response.status < 200 || response.status >= 300)
      ioFailure("http_failed");
    if (response.body.byteLength > 1024 * 1024) ioFailure("response_limit");
    let result: unknown;
    try {
      result = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(response.body),
      );
    } catch {
      ioFailure("response_invalid");
    }
    return ioJson(result, 1024 * 1024);
  }
}
