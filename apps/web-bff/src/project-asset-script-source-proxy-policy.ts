import { parseThreadId } from "@crewon/contracts";
import {
  MAX_PROJECT_ASSET_SCRIPT_SOURCE_BYTES,
  parseProjectAssetScriptSourceQuery,
  parseProjectAssetScriptSourceResponse,
  type ProjectAssetScriptSourceRequest,
} from "@crewon/contracts/project-asset-stages";
import { boundedProjectConversationProxyResponse } from "./project-conversation-proxy-policy.ts";

type Policy =
  | Readonly<{ outcome: "allow"; request: ProjectAssetScriptSourceRequest }>
  | Readonly<{ outcome: "deny"; status: 400 | 404 | 405; code: string }>;
/** Exact bounded read only. It does not widen project APIs or admit an Asset Run. */
export function projectAssetScriptSourceProxyPolicy(
  input: Readonly<{ pathname: string; search: string; method: string }>,
): Policy | null {
  let decoded = input.pathname;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}
  if (!decoded.includes("project-asset-stage/script-source")) return null;
  const fail = (status: 400 | 404 | 405, code: string): Policy => ({
    outcome: "deny",
    status,
    code,
  });
  const match =
    /^\/api\/v1\/threads\/([^/]+)\/project-asset-stage\/script-source$/u.exec(
      input.pathname,
    );
  if (
    match === null ||
    input.pathname.length > 4096 ||
    /[\\\u0000-\u0020\u007f?#]/u.test(input.pathname)
  )
    return fail(404, "route_not_found");
  if (input.method !== "GET") return fail(405, "method_not_allowed");
  try {
    if (
      input.search.length > MAX_PROJECT_ASSET_SCRIPT_SOURCE_BYTES ||
      !input.search.startsWith("?")
    )
      throw new Error();
    const entries = [...new URLSearchParams(input.search)],
      query = Object.fromEntries(entries);
    if (entries.length !== 4 || Object.keys(query).length !== entries.length)
      throw new Error();
    const threadId = parseThreadId(decodeURIComponent(match[1]!));
    if (threadId === "." || threadId === "..") throw new Error();
    return Object.freeze({
      outcome: "allow",
      request: parseProjectAssetScriptSourceQuery(threadId, query),
    });
  } catch {
    return fail(400, "project_asset_stage_request_invalid");
  }
}
export async function boundedProjectAssetScriptSourceProxyResponse(
  input: Readonly<{
    upstream: Response;
    signal: AbortSignal;
    policy: Extract<Policy, { outcome: "allow" }>;
  }>,
): Promise<Response> {
  const response = await boundedProjectConversationProxyResponse({
    upstream: input.upstream,
    signal: input.signal,
    maximumBytes: MAX_PROJECT_ASSET_SCRIPT_SOURCE_BYTES,
  });
  if (response.status === 200)
    parseProjectAssetScriptSourceResponse(
      input.policy.request,
      await response.clone().json(),
    );
  return response;
}
