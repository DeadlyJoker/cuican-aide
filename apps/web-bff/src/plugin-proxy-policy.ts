const PREFIX = "/api/v1/plugins";
export const PLUGIN_PROXY_DEADLINE_MS = 10_000;
export const PLUGIN_JSON_RESPONSE_MAX_BYTES = 128 * 1024;
export const PLUGIN_LEASE_RESPONSE_MAX_BYTES = 512 * 1024;
export const PLUGIN_CATALOG_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
export const PLUGIN_ASSET_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_MAX_BYTES = 64 * 1024;

export type PluginProxyPolicy =
  | Readonly<{
      outcome: "allow";
      responseKind: "json" | "asset";
      responseMaxBytes: number;
    }>
  | Readonly<{
      outcome: "deny";
      status: 400 | 404 | 405;
      code: "plugin_query_invalid" | "route_not_found" | "method_not_allowed";
    }>;

/** Receives the original HTTP pathname when available, before URL dot-segment normalization. */
export function pluginProxyPolicy(input: {
  pathname: string;
  search: string;
  method: string;
}): PluginProxyPolicy | null {
  let decoded = input.pathname;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // A malformed encoded family must still be rejected by the route match below.
  }
  const family = (path: string) =>
    path === PREFIX || path.startsWith(`${PREFIX}/`);
  let decodedPrefix = "";
  try {
    decodedPrefix = decodeURIComponent(
      input.pathname.split("/").slice(0, 4).join("/"),
    );
  } catch {
    /* Invalid prefixes never become an allowed route. */
  }
  const normalized = new URL(input.pathname, "https://bff.invalid").pathname;
  if (
    !family(input.pathname) &&
    !family(decoded) &&
    !family(normalized) &&
    decodedPrefix !== PREFIX &&
    !input.pathname.startsWith(`${PREFIX}%`)
  )
    return null;
  if (
    !family(input.pathname) ||
    /[\\\u0000-\u0020\u007f?#]/u.test(input.pathname) ||
    input.pathname.split("/").some((part) => part === "." || part === "..")
  )
    return denied(404, "route_not_found");
  const suffix = input.pathname.slice(PREFIX.length);
  let methods: readonly string[];
  let query: "packages" | "selections" | "sources" | "empty" = "empty";
  let responseKind: "json" | "asset" = "json";
  let responseMaxBytes = PLUGIN_JSON_RESPONSE_MAX_BYTES;
  if (suffix === "/sources") {
    methods = ["GET"];
    query = "sources";
  } else if (suffix === "/packages") {
    methods = ["GET"];
    query = "packages";
  } else if (suffix === "/selections") {
    methods = ["GET"];
    query = "selections";
  } else if (suffix === "/installations") methods = ["POST"];
  else if (suffix === "/ui/catalog") {
    methods = ["GET"];
    query = "selections";
    responseMaxBytes = PLUGIN_CATALOG_RESPONSE_MAX_BYTES;
  } else if (suffix === "/ui/mounts") {
    methods = ["POST"];
    responseMaxBytes = PLUGIN_LEASE_RESPONSE_MAX_BYTES;
  } else {
    const parts = suffix.slice(1).split("/");
    if (
      parts[0] === "packages" &&
      parts.length === 2 &&
      digest(segment(parts[1]!))
    )
      methods = ["GET"];
    else if (
      parts[0] === "selections" &&
      parts.length === 2 &&
      namespace(segment(parts[1]!))
    )
      methods = ["GET", "PUT"];
    else if (
      parts[0] === "ui" &&
      parts[1] === "mounts" &&
      mountRef(parts[2] ?? "")
    ) {
      if (parts.length === 3) {
        methods = ["GET", "DELETE"];
        responseMaxBytes =
          input.method === "GET"
            ? PLUGIN_LEASE_RESPONSE_MAX_BYTES
            : PLUGIN_JSON_RESPONSE_MAX_BYTES;
      } else if (parts.length === 4 && parts[3] === "actions")
        methods = ["POST"];
      else if (
        parts.length >= 5 &&
        parts[3] === "assets" &&
        assetPath(parts.slice(4))
      ) {
        methods = ["GET"];
        responseKind = "asset";
        responseMaxBytes = PLUGIN_ASSET_RESPONSE_MAX_BYTES;
      } else return denied(404, "route_not_found");
    } else return denied(404, "route_not_found");
  }
  if (!methods.includes(input.method)) return denied(405, "method_not_allowed");
  if (!validQuery(input.search, query))
    return denied(400, "plugin_query_invalid");
  return Object.freeze({ outcome: "allow", responseKind, responseMaxBytes });
}

function segment(value: string): string {
  try {
    const result = decodeURIComponent(value);
    return /[/%\\]/u.test(result) ? "" : result;
  } catch {
    return "";
  }
}
function namespace(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    /^[a-z][a-z0-9._-]*$/u.test(value)
  );
}
function digest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}
function mountRef(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/u.test(value);
}
function assetPath(parts: readonly string[]): boolean {
  const decoded = parts.map(segment);
  const path = decoded.join("/");
  return (
    new TextEncoder().encode(path).byteLength <= 256 &&
    [...path].every((point) => {
      const code = point.codePointAt(0)!;
      return code < 0xd800 || code > 0xdfff;
    }) &&
    decoded.every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        !/[:?#\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(part),
    )
  );
}
function validQuery(
  search: string,
  kind: "packages" | "selections" | "sources" | "empty",
): boolean {
  if (search === "") return true;
  if (kind === "empty" || search.length > 2048 || !search.startsWith("?"))
    return false;
  const query = new URLSearchParams(search);
  const keys =
    kind === "packages"
      ? ["pluginId", "afterPackageDigest", "limit"]
      : kind === "sources"
        ? ["afterSourceId", "limit"]
        : ["afterPluginId", "limit"];
  if (
    [...query].length === 0 ||
    search
      .slice(1)
      .split("&")
      .some((part) => part === "")
  )
    return false;
  for (const [key, value] of query) {
    if (!keys.includes(key) || query.getAll(key).length !== 1) return false;
    if (key === "limit") {
      if (!/^[1-9][0-9]?$/u.test(value) || Number(value) > 50) return false;
    } else if (key === "afterPackageDigest") {
      if (!digest(value)) return false;
    } else if (key === "afterSourceId") {
      if (!sourceId(value)) return false;
    } else if (!namespace(value)) return false;
  }
  return true;
}
function sourceId(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 128 &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
    [...value].every((point) => {
      const code = point.codePointAt(0)!;
      return code < 0xd800 || code > 0xdfff;
    })
  );
}
function denied(
  status: 400 | 404 | 405,
  code: "plugin_query_invalid" | "route_not_found" | "method_not_allowed",
): PluginProxyPolicy {
  return Object.freeze({ outcome: "deny", status, code });
}

/** Finite plugin replies use a separate byte path; JavaScript assets never pass a JSON reader. */
export async function boundedPluginProxyResponse(input: {
  upstream: Response;
  signal: AbortSignal;
  policy: Extract<PluginProxyPolicy, { outcome: "allow" }>;
}): Promise<Response> {
  const { upstream, signal, policy } = input;
  const success = upstream.status >= 200 && upstream.status < 300;
  if (
    (success && upstream.status !== 200 && upstream.status !== 201) ||
    upstream.status < 200 ||
    (upstream.status >= 300 && upstream.status < 400)
  ) {
    cancelBody(upstream);
    throw new Error("plugin_response_invalid");
  }
  const asset = success && policy.responseKind === "asset";
  const maximumBytes = asset
    ? policy.responseMaxBytes
    : success
      ? policy.responseMaxBytes
      : PLUGIN_JSON_RESPONSE_MAX_BYTES;
  const contentType = upstream.headers.get("content-type") ?? "";
  if (
    asset
      ? !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*charset=utf-8)?$/iu.test(
          contentType,
        )
      : !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
  ) {
    cancelBody(upstream);
    throw new Error("plugin_response_invalid");
  }
  const bytes = await readFiniteBody(
    upstream.body,
    upstream.headers.get("content-length"),
    maximumBytes,
    signal,
  );
  if (!asset) {
    try {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error();
    } catch {
      throw new Error("plugin_response_invalid");
    }
  }
  const headers = new Headers(upstream.headers);
  headers.set("content-length", String(bytes.byteLength));
  return new Response(bytes, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export async function boundedPluginProxyRequest(
  request: Request,
  signal: AbortSignal,
  options: Readonly<{ maximumBytes: number }> = {
    maximumBytes: REQUEST_MAX_BYTES,
  },
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.method === "GET") return null;
  if (request.method === "DELETE" && request.body === null) return null;
  if (
    !Number.isSafeInteger(options.maximumBytes) ||
    options.maximumBytes < 1 ||
    options.maximumBytes > REQUEST_MAX_BYTES
  )
    throw new Error("plugin_request_invalid");
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new Error("plugin_request_invalid");
  return readFiniteBody(
    request.body,
    request.headers.get("content-length"),
    options.maximumBytes,
    signal,
  );
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}
async function readFiniteBody(
  body: ReadableStream<Uint8Array> | null,
  declaredLength: string | null,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    declaredLength !== null &&
    (!/^(0|[1-9][0-9]*)$/u.test(declaredLength) ||
      !Number.isSafeInteger(Number(declaredLength)) ||
      Number(declaredLength) > maximumBytes)
  ) {
    void body?.cancel().catch(() => undefined);
    throw new Error("plugin_body_too_large");
  }
  if (body === null) throw new Error("plugin_body_missing");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes || chunks.length >= 8192)
        throw new Error("plugin_body_too_large");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    signal.throwIfAborted();
    return bytes;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let aborted!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(new Error("plugin_proxy_cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}
