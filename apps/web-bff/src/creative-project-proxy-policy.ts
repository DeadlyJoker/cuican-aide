import {
  MAX_CREATIVE_PROJECT_RESPONSE_BYTES,
  MAX_PROJECT_GENERATION_SELECTION_BYTES,
  parseConceptAssetListQuery,
  parseConceptRevisionListQuery,
  parseCreativeProjectEmptyQuery,
  parseCreativeProjectId,
  parseCreativeProjectIdempotencyKey,
  parseCreativeProjectListQuery,
  parseCreativeProjectRevision,
  parseProjectBriefListQuery,
  parseSelectConceptImageRequest,
  parseProjectTextArtifactListQuery,
  parseProjectTextRevisionListQuery,
} from "@crewon/contracts";
import { boundedExtensionProxyResponse } from "./extension-proxy-policy.ts";
import { boundedPluginProxyRequest } from "./plugin-proxy-policy.ts";
import {
  assertProjectTextProxyBody,
  projectTextProxyRoute,
  type ProjectTextProxyQueryKind,
} from "./project-text-proxy-policy.ts";

const PREFIX = "/api/v1/creative-projects";
export const CREATIVE_PROJECT_PROXY_DEADLINE_MS = 10_000;
export const CREATIVE_PROJECT_PROXY_RESPONSE_MAX_BYTES =
  MAX_CREATIVE_PROJECT_RESPONSE_BYTES;

export type CreativeProjectProxyPolicy =
  | Readonly<{ outcome: "allow"; responseMaxBytes: number }>
  | Readonly<{
      outcome: "deny";
      status: 400 | 404 | 405;
      code:
        | "creative_project_query_invalid"
        | "route_not_found"
        | "method_not_allowed";
    }>;

type QueryKind =
  | "projects"
  | "briefs"
  | "concepts"
  | "revisions"
  | ProjectTextProxyQueryKind;

/** Inspect the HTTP adapter's original target before URL dot-segment normalization. */
export function creativeProjectProxyPolicy(input: {
  pathname: string;
  search: string;
  method: string;
}): CreativeProjectProxyPolicy | null {
  let decoded = input.pathname;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // An encoded family with malformed suffixes must not fall back to the ordinary proxy.
  }
  const family = (path: string) =>
    path === PREFIX || path.startsWith(`${PREFIX}/`);
  let decodedPrefix = "";
  try {
    decodedPrefix = decodeURIComponent(
      input.pathname.split("/").slice(0, 4).join("/"),
    );
  } catch {
    // Invalid prefixes cannot become declared project routes.
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
    input.pathname.length > 4_096 ||
    /[\\\u0000-\u0020\u007f?#]/u.test(input.pathname) ||
    input.pathname.split("/").some((part) => {
      try {
        const value = decodeURIComponent(part);
        return value === "." || value === "..";
      } catch {
        return true;
      }
    })
  )
    return denied(404, "route_not_found");

  const suffix = input.pathname.slice(PREFIX.length);
  const parts = suffix === "" ? [] : suffix.slice(1).split("/");
  let methods: readonly string[];
  let responseMaxBytes = CREATIVE_PROJECT_PROXY_RESPONSE_MAX_BYTES;
  let query: QueryKind = "empty";
  if (parts.length === 0) {
    methods = ["GET", "POST"];
    query = "projects";
  } else if (!opaqueSegment(parts[0]!)) return denied(404, "route_not_found");
  else if (parts.length === 1) methods = ["GET"];
  else if (parts[1] === "text-artifacts") {
    const text = projectTextProxyRoute(parts);
    if (text === null) return denied(404, "route_not_found");
    methods = text.methods;
    query = text.query;
  } else if (
    parts.length === 2 &&
    (parts[1] === "title" || parts[1] === "state")
  )
    methods = ["PUT"];
  else if (parts.length === 2 && parts[1] === "briefs") {
    methods = ["GET", "POST"];
    query = "briefs";
  } else if (
    parts.length === 3 &&
    parts[1] === "briefs" &&
    positiveRevision(parts[2]!)
  )
    methods = ["GET"];
  else if (parts.length === 2 && parts[1] === "concepts") {
    methods = ["GET", "POST"];
    query = "concepts";
  } else if (parts[1] === "concepts" && opaqueSegment(parts[2] ?? "")) {
    if (parts.length === 3) methods = ["GET"];
    else if (parts.length === 4 && parts[3] === "selection") {
      methods = ["GET", "PUT"];
      responseMaxBytes = MAX_PROJECT_GENERATION_SELECTION_BYTES;
    } else if (parts.length === 4 && parts[3] === "revisions") {
      methods = ["GET", "POST"];
      query = "revisions";
    } else if (
      (parts.length === 5 ||
        (parts.length === 6 && parts[5] === "generation")) &&
      parts[3] === "revisions" &&
      positiveRevision(parts[4]!)
    )
      methods = ["GET"];
    else return denied(404, "route_not_found");
  } else return denied(404, "route_not_found");
  if (!methods.includes(input.method)) return denied(405, "method_not_allowed");
  if (!validQuery(input.search, input.method === "GET" ? query : "empty"))
    return denied(400, "creative_project_query_invalid");
  return Object.freeze({
    outcome: "allow",
    responseMaxBytes,
  });
}

/** Opaque IDs follow Domain's UTF-16 and Unicode rules; encoded separators remain data. */
function opaqueSegment(value: string): boolean {
  try {
    parseCreativeProjectId(decodeURIComponent(value));
    return true;
  } catch {
    return false;
  }
}
function positiveRevision(value: string): boolean {
  try {
    parseCreativeProjectRevision(value);
    return true;
  } catch {
    return false;
  }
}
function validQuery(search: string, kind: QueryKind): boolean {
  if (search.length > 4_096 || (search !== "" && !search.startsWith("?")))
    return false;
  const query: Record<string, string> = Object.create(null);
  if (search !== "") {
    const parts = search.slice(1).split("&");
    if (parts.some((part) => part === "")) return false;
    try {
      // URLSearchParams replaces invalid UTF-8; reject it before the bounded contract parser.
      for (const part of parts) {
        const position = part.indexOf("=");
        if (position < 0) return false;
        const key = decodeURIComponent(
          part.slice(0, position).replaceAll("+", " "),
        );
        const value = decodeURIComponent(
          part.slice(position + 1).replaceAll("+", " "),
        );
        if (Object.hasOwn(query, key)) return false;
        query[key] = value;
      }
    } catch {
      return false;
    }
  }
  try {
    switch (kind) {
      case "projects":
        parseCreativeProjectListQuery(query);
        break;
      case "briefs":
        parseProjectBriefListQuery(query);
        break;
      case "concepts":
        parseConceptAssetListQuery(query);
        break;
      case "revisions":
        parseConceptRevisionListQuery(query);
        break;
      case "text-artifacts":
        parseProjectTextArtifactListQuery(query);
        break;
      case "text-revisions":
        parseProjectTextRevisionListQuery(query);
        break;
      case "empty":
        parseCreativeProjectEmptyQuery(query);
        break;
    }
    return true;
  } catch {
    return false;
  }
}
function denied(
  status: 400 | 404 | 405,
  code:
    | "creative_project_query_invalid"
    | "route_not_found"
    | "method_not_allowed",
): CreativeProjectProxyPolicy {
  return Object.freeze({ outcome: "deny", status, code });
}

export async function boundedCreativeProjectProxyRequest(
  request: Request,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.method === "GET") return null;
  try {
    parseCreativeProjectIdempotencyKey(request.headers.get("idempotency-key"));
    const url = new URL(request.url);
    const policy = creativeProjectProxyPolicy({
      pathname: url.pathname,
      search: url.search,
      method: request.method,
    });
    const selection =
      policy?.outcome === "allow" &&
      policy.responseMaxBytes === MAX_PROJECT_GENERATION_SELECTION_BYTES;
    const bytes = await boundedPluginProxyRequest(
      request,
      signal,
      selection
        ? { maximumBytes: MAX_PROJECT_GENERATION_SELECTION_BYTES }
        : undefined,
    );
    if (bytes === null) throw new Error("creative_project_request_invalid");
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("creative_project_request_invalid");
    assertProjectTextProxyBody(
      url.pathname.slice(PREFIX.length + 1).split("/"),
      value,
    );
    if (selection) {
      const checked = parseSelectConceptImageRequest(value);
      const parts = url.pathname.slice(PREFIX.length + 1).split("/");
      if (
        checked.reference.projectId !== decodeURIComponent(parts[0]!) ||
        checked.reference.assetId !== decodeURIComponent(parts[2]!)
      )
        throw new Error("creative_project_request_invalid");
    }
    signal.throwIfAborted();
    return bytes;
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message === "plugin_body_too_large"
        ? "creative_project_body_too_large"
        : "creative_project_request_invalid",
      { cause: error },
    );
  }
}

/** All project replies, including error envelopes, are finite JSON within the same bound. */
export async function boundedCreativeProjectProxyResponse(input: {
  upstream: Response;
  signal: AbortSignal;
  maximumBytes?: number;
}): Promise<Response> {
  const { upstream, signal } = input;
  const maximumBytes =
    input.maximumBytes ?? CREATIVE_PROJECT_PROXY_RESPONSE_MAX_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > CREATIVE_PROJECT_PROXY_RESPONSE_MAX_BYTES
  )
    throw new Error("creative_project_response_invalid");
  if (
    upstream.body === null ||
    upstream.status < 200 ||
    (upstream.status >= 200 &&
      upstream.status < 300 &&
      upstream.status !== 200 &&
      upstream.status !== 201) ||
    (upstream.status >= 300 && upstream.status < 400)
  ) {
    void upstream.body?.cancel().catch(() => {});
    throw new Error("creative_project_response_invalid");
  }
  try {
    const finite = await boundedExtensionProxyResponse({
      upstream,
      signal,
      maximumBytes,
    });
    signal.throwIfAborted();
    const bytes = await finite.arrayBuffer();
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("creative_project_response_invalid");
    signal.throwIfAborted();
    return new Response(bytes, {
      status: finite.status,
      statusText: finite.statusText,
      headers: finite.headers,
    });
  } catch (cause) {
    throw new Error("creative_project_response_invalid", { cause });
  }
}
