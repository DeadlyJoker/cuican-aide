const EXTENSIONS_PREFIX = "/api/v1/extensions";
export const EXTENSION_PROXY_RESPONSE_MAX_BYTES = 128 * 1024;
export const EXTENSION_CATALOG_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const EXTENSION_PROXY_DEADLINE_MS = 10_000;

export type ExtensionProxyPolicy =
  | Readonly<{ outcome: "allow"; responseMaxBytes: number }>
  | Readonly<{
      outcome: "deny";
      status: 400 | 404 | 405;
      code:
        | "extension_query_invalid"
        | "route_not_found"
        | "method_not_allowed";
    }>;

/** Add plugin routes explicitly while leaving the existing chat/team surface unchanged. */
export function extensionProxyPolicy(input: {
  pathname: string;
  search: string;
  method: string;
}): ExtensionProxyPolicy | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(input.pathname);
  } catch {
    decoded = input.pathname;
  }
  const isFamily = (path: string) =>
    path === EXTENSIONS_PREFIX || path.startsWith(`${EXTENSIONS_PREFIX}/`);
  if (!isFamily(input.pathname) && !isFamily(decoded)) return null;
  if (input.pathname === EXTENSIONS_PREFIX) {
    if (input.method !== "GET") return denied(405, "method_not_allowed");
    if (input.search !== "") return denied(400, "extension_query_invalid");
    return Object.freeze({
      outcome: "allow",
      responseMaxBytes: EXTENSION_CATALOG_RESPONSE_MAX_BYTES,
    });
  }
  const match =
    /^\/api\/v1\/extensions\/([^/]+)\/(configuration|activation|runtime|tasks)(?:\/([^/]+))?$/u.exec(
      input.pathname,
    );
  if (match === null || !pluginId(match[1]!))
    return denied(404, "route_not_found");
  const resource = match[2]!;
  const runSegment = match[3];
  if (
    runSegment !== undefined &&
    (resource !== "tasks" || !runPathSegment(runSegment))
  )
    return denied(404, "route_not_found");
  const allowedMethods =
    resource === "runtime" || runSegment !== undefined
      ? ["GET"]
      : resource === "tasks"
        ? ["POST"]
        : ["GET", "PUT"];
  if (!allowedMethods.includes(input.method))
    return denied(405, "method_not_allowed");
  if (input.search.length > 512) return denied(400, "extension_query_invalid");
  const query = new URLSearchParams(input.search);
  if (resource === "runtime") {
    const entries = [...query.entries()];
    const agentVersionId = query.get("agentVersionId");
    const configurationRevision = query.get("configurationRevision");
    if (
      entries.length !== 2 ||
      !entries.every(
        ([key]) => key === "agentVersionId" || key === "configurationRevision",
      ) ||
      query.getAll("agentVersionId").length !== 1 ||
      query.getAll("configurationRevision").length !== 1 ||
      agentVersionId === null ||
      !boundedText(agentVersionId, 128) ||
      configurationRevision === null ||
      !revision(configurationRevision)
    )
      return denied(400, "extension_query_invalid");
  } else if (resource === "configuration" && input.method === "GET") {
    const entries = [...query.entries()];
    if (
      entries.length > 1 ||
      (entries.length === 0 && input.search !== "") ||
      (entries.length === 1 &&
        (entries[0]![0] !== "revision" || !revision(entries[0]![1])))
    )
      return denied(400, "extension_query_invalid");
  } else if (input.search !== "") return denied(400, "extension_query_invalid");
  return Object.freeze({
    outcome: "allow",
    responseMaxBytes: EXTENSION_PROXY_RESPONSE_MAX_BYTES,
  });
}

function revision(value: string): boolean {
  return /^[1-9][0-9]{0,9}$/u.test(value) && Number(value) <= 2_147_483_647;
}

function boundedText(value: string, maximum: number): boolean {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value) > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    return false;
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}

function runPathSegment(value: string): boolean {
  try {
    const runId = decodeURIComponent(value);
    return (
      boundedText(runId, 128) &&
      runId !== "." &&
      runId !== ".." &&
      !/[\\/]/u.test(runId)
    );
  } catch {
    return false;
  }
}

function pluginId(value: string): boolean {
  return (
    value.length <= 48 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(value)
  );
}

function denied(
  status: 400 | 404 | 405,
  code: "extension_query_invalid" | "route_not_found" | "method_not_allowed",
): ExtensionProxyPolicy {
  return Object.freeze({ outcome: "deny", status, code });
}

/** Plugin replies are finite JSON; Run event streams keep their existing streaming proxy. */
export async function boundedExtensionProxyResponse(input: {
  upstream: Response;
  signal: AbortSignal;
  maximumBytes?: number;
}): Promise<Response> {
  const { upstream, signal } = input;
  const maximumBytes = input.maximumBytes ?? EXTENSION_PROXY_RESPONSE_MAX_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > EXTENSION_CATALOG_RESPONSE_MAX_BYTES
  )
    throw new Error("extension_response_limit_invalid");
  const declaredLength = upstream.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^(0|[1-9][0-9]*)$/u.test(declaredLength) ||
      !Number.isSafeInteger(Number(declaredLength)) ||
      Number(declaredLength) > maximumBytes)
  ) {
    void upstream.body?.cancel().catch(() => {});
    throw new Error("extension_response_invalid");
  }
  if (upstream.body === null) return upstream;
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
      upstream.headers.get("content-type") ?? "",
    )
  ) {
    void upstream.body.cancel().catch(() => {});
    throw new Error("extension_response_invalid");
  }
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes || chunks.length >= maximumBytes)
        throw new Error("extension_response_invalid");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const headers = new Headers(upstream.headers);
    headers.set("content-length", String(total));
    return new Response(bytes, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    void reader.cancel().catch(() => {});
    throw new Error("extension_response_invalid");
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
  const cancellation = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(new Error("extension_proxy_cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    return await Promise.race([promise, cancellation]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}
