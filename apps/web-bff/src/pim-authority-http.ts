import { timingSafeEqual } from "node:crypto";
import type {
  PimControlActor,
  PimControlSessions,
} from "./pim-control-sessions.ts";

const paths = new Map<string, "identity" | "policy">([
  ["/internal/crewon/pim/verify", "identity"],
  ["/internal/crewon/pim/profile", "policy"],
  ["/internal/crewon/pim/plugin-policy", "policy"],
  ["/internal/crewon/pim/control-policy", "policy"],
] as const);
/** Private server-to-server protocol, hosted by the same BFF authority. Every
 * call authenticates its independent service credential before reading its body.
 */
export function createPimAuthorityHttp(input: {
  sessions: PimControlSessions;
  identityServiceToken: string;
  policyServiceToken: string;
}) {
  for (const token of [input.identityServiceToken, input.policyServiceToken])
    if (!/^[\x21-\x7e]{32,8192}$/u.test(token))
      throw new Error("pim_authority_service_token_invalid");
  return {
    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const kind = paths.get(url.pathname);
      if (kind === undefined) return null;
      if (request.method !== "POST" || url.search !== "" || url.hash !== "")
        return error(405, "method_not_allowed");
      const actual = request.headers.get("authorization");
      const expected = `Bearer ${kind === "identity" ? input.identityServiceToken : input.policyServiceToken}`;
      if (
        actual === null ||
        Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
      )
        return error(401, "pim_authority_service_required");
      try {
        const value = await body(request);
        if (url.pathname.endsWith("/verify")) {
          exact(value, ["accessToken"]);
          if (
            typeof value.accessToken !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/u.test(value.accessToken)
          )
            return error(401, "pim_control_token_invalid");
          return json(
            await input.sessions.verifyControlToken(
              value.accessToken,
              request.signal,
            ),
          );
        }
        if (url.pathname.endsWith("/profile")) {
          exact(value, ["actor"]);
          return json(
            await input.sessions.pluginProfile(
              actor(value.actor),
              request.signal,
            ),
          );
        }
        exact(value, ["actor", "action", "resource"]);
        if (
          typeof value.action !== "string" ||
          !/^[A-Za-z][A-Za-z0-9_:]{0,127}$/u.test(value.action)
        )
          throw new Error("pim_authority_request_invalid");
        if (
          !value.resource ||
          typeof value.resource !== "object" ||
          Array.isArray(value.resource)
        )
          throw new Error("pim_authority_request_invalid");
        const checked = {
          actor: actor(value.actor),
          action: value.action,
          resource: value.resource as Record<string, unknown>,
        };
        return json(
          url.pathname.endsWith("/plugin-policy")
            ? await input.sessions.pluginPolicy(checked, request.signal)
            : await input.sessions.controlPolicy(checked, request.signal),
        );
      } catch (e) {
        if (e instanceof Error && e.message === "pim_authority_request_invalid")
          return error(400, "pim_authority_request_invalid");
        if (
          e instanceof Error &&
          /^(pim_account_denied|pim_account_token_invalid|pim_account_membership_denied|pim_control_session_required|pim_control_profile_denied|web_plugin_profile_revoked)$/u.test(
            e.message,
          )
        )
          return error(403, "pim_authority_access_denied");
        return error(503, "pim_authority_unavailable");
      }
    },
  };
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0"))
    throw new Error("pim_authority_request_invalid");
}
function actor(value: unknown): PimControlActor {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("pim_authority_request_invalid");
  const record = value as Record<string, unknown>;
  exact(record, ["tenantId", "spaceId", "principalId", "actorId"]);
  if (
    Object.values(record).some(
      (x) =>
        typeof x !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(x),
    )
  )
    throw new Error("pim_authority_request_invalid");
  return Object.freeze(record) as PimControlActor;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (
    !/^application\/json(?:;|$)/iu.test(
      request.headers.get("content-type") ?? "",
    ) ||
    !request.body
  )
    throw new Error("pim_authority_request_invalid");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) throw new Error("pim_authority_request_invalid");
      chunks.push(part.value);
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw new Error("pim_authority_request_invalid");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("pim_authority_request_invalid");
    return value as Record<string, unknown>;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function json(value: unknown): Response {
  return Response.json(value, {
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
function error(status: number, code: string): Response {
  return Response.json(
    { error: { code } },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
