import { parseThreadId } from "@crewon/contracts";
import {
  MAX_PROJECT_CONVERSATIONS_BYTES,
  MAX_PROJECT_CONVERSATION_CONTEXT_BYTES,
  PROJECT_CONVERSATIONS_METHOD_ACTIONS,
  parseProjectConversationsActionRequest,
} from "@crewon/contracts/project-conversations";
import { boundedPluginProxyRequest } from "./plugin-proxy-policy.ts";
import { boundedExtensionProxyResponse } from "./extension-proxy-policy.ts";

export const PROJECT_CONVERSATION_PROXY_DEADLINE_MS = 30_000;
type Policy =
  | Readonly<{ outcome: "allow"; threadId: string; responseMaxBytes: number }>
  | Readonly<{
      outcome: "deny";
      status: 400 | 404 | 405;
      code:
        | "project_conversation_request_invalid"
        | "route_not_found"
        | "method_not_allowed";
    }>;
/** Inspect the unnormalized target; malformed members cannot enter the ordinary unbounded proxy. */
export function projectConversationProxyPolicy(
  input: Readonly<{ pathname: string; search: string; method: string }>,
): Policy | null {
  let decoded = input.pathname;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}
  if (
    !/(?:^|\/)project-conversation(?:\/|$|%)/u.test(input.pathname) &&
    !/(?:^|\/)project-conversation(?:\/|$)/u.test(decoded)
  )
    return null;
  const fail = (
    status: 400 | 404 | 405,
    code:
      | "project_conversation_request_invalid"
      | "route_not_found"
      | "method_not_allowed",
  ): Policy => ({ outcome: "deny", status, code });
  if (
    input.pathname.length > 4096 ||
    /[\\\u0000-\u0020\u007f?#]/u.test(input.pathname)
  )
    return fail(404, "route_not_found");
  const match =
    /^\/api\/v1\/threads\/([^/]+)\/project-conversation(\/stages|\/context)?$/u.exec(
      input.pathname,
    );
  if (match === null) return fail(404, "route_not_found");
  let threadId: string;
  try {
    threadId = parseThreadId(decodeURIComponent(match[1]!));
    if (threadId === "." || threadId === "..") throw new Error();
  } catch {
    return fail(404, "route_not_found");
  }
  if (input.method !== (match[2] === "/stages" ? "POST" : "GET"))
    return fail(405, "method_not_allowed");
  if (input.search !== "")
    return fail(400, "project_conversation_request_invalid");
  return Object.freeze({
    outcome: "allow",
    threadId,
    responseMaxBytes:
      match[2] === "/context"
        ? MAX_PROJECT_CONVERSATION_CONTEXT_BYTES
        : MAX_PROJECT_CONVERSATIONS_BYTES,
  });
}
export async function boundedProjectConversationProxyRequest(
  request: Request,
  signal: AbortSignal,
  policy: Extract<Policy, { outcome: "allow" }>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.method === "GET") return null;
  const bytes = await boundedPluginProxyRequest(request, signal, {
    maximumBytes: MAX_PROJECT_CONVERSATIONS_BYTES,
  });
  if (bytes === null) throw new Error("project_conversation_request_invalid");
  const parsed = parseProjectConversationsActionRequest({
    action: PROJECT_CONVERSATIONS_METHOD_ACTIONS.startStage,
    input: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  });
  if (
    parsed.action !== PROJECT_CONVERSATIONS_METHOD_ACTIONS.startStage ||
    parsed.input.threadId !== policy.threadId ||
    parsed.input.idempotencyKey !== request.headers.get("idempotency-key")
  )
    throw new Error("project_conversation_request_invalid");
  signal.throwIfAborted();
  return bytes;
}
/** Keep this route's declared context budget independent from ordinary project metadata. */
export async function boundedProjectConversationProxyResponse(
  input: Readonly<{
    upstream: Response;
    signal: AbortSignal;
    maximumBytes?: number;
  }>,
): Promise<Response> {
  const maximumBytes = input.maximumBytes ?? MAX_PROJECT_CONVERSATIONS_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_PROJECT_CONVERSATION_CONTEXT_BYTES
  )
    throw new Error("project_conversation_response_invalid");
  const { upstream, signal } = input;
  if (
    upstream.body === null ||
    upstream.status < 200 ||
    (upstream.status < 300 &&
      upstream.status !== 200 &&
      upstream.status !== 201) ||
    (upstream.status >= 300 && upstream.status < 400)
  ) {
    void upstream.body?.cancel().catch(() => {});
    throw new Error("project_conversation_response_invalid");
  }
  try {
    const finite = await boundedExtensionProxyResponse({
      upstream,
      signal,
      maximumBytes,
    });
    const bytes = await finite.arrayBuffer();
    signal.throwIfAborted();
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("project_conversation_response_invalid");
    return new Response(bytes, {
      status: finite.status,
      statusText: finite.statusText,
      headers: finite.headers,
    });
  } catch (cause) {
    throw new Error("project_conversation_response_invalid", { cause });
  }
}
