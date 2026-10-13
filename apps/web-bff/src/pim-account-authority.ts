import { createHash } from "node:crypto";

/** Validates the existing PIM credential and its current tenant/space membership.
 * Decoding a JWT is never an authentication decision: both upstream checks must succeed.
 */
export type PimAccountScope = Readonly<{
  userId: number;
  tenantId: number;
  spaceId: number;
  userRole: string;
  tenantRole: string;
  spaceRole: string;
  expiresAt: number;
}>;

const MAX_TOKEN_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;

export class PimAccountAuthority {
  readonly #origin: URL;
  readonly #permissionOrigin: URL | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #cache = new Map<
    string,
    { account: PimAccountScope; until: number }
  >();

  constructor(input: {
    origin: string;
    permissionOrigin?: string;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    timeoutMs?: number;
    /** Explicit bounded directory freshness window; zero preserves uncached validation. */
    cacheTtlMs?: number;
  }) {
    this.#origin = authorityOrigin(input.origin);
    this.#permissionOrigin =
      input.permissionOrigin === undefined
        ? undefined
        : authorityOrigin(input.permissionOrigin);
    this.#fetch = input.fetch ?? globalThis.fetch;
    this.#now = input.now ?? Date.now;
    this.#timeoutMs = input.timeoutMs ?? 5_000;
    this.#cacheTtlMs = input.cacheTtlMs ?? 0;
    if (
      !Number.isSafeInteger(this.#cacheTtlMs) ||
      this.#cacheTtlMs < 0 ||
      this.#cacheTtlMs > 250
    )
      throw new Error("pim_authority_cache_invalid");
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > 30_000
    )
      throw new Error("pim_authority_timeout_invalid");
  }

  async verify(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<PimAccountScope> {
    signal.throwIfAborted();
    // Expiry and envelope checks are never cached. Tokens themselves are not map keys.
    claims(accessToken, this.#now());
    const key = createHash("sha256").update(accessToken).digest("hex");
    const cached = this.#cache.get(key);
    if (cached !== undefined && cached.until > this.#now())
      return cached.account;
    this.#cache.delete(key);
    const verifiedAt = this.#now();
    const account = await this.#verifyCurrent(accessToken, signal);
    signal.throwIfAborted();
    if (this.#cacheTtlMs > 0) {
      const now = this.#now();
      for (const [entry, value] of this.#cache)
        if (value.until <= now) this.#cache.delete(entry);
      if (this.#cache.size >= 1000)
        this.#cache.delete(this.#cache.keys().next().value!);
      // Slow upstream work cannot extend freshness; profile/epoch lookups remain live.
      const until = Math.min(account.expiresAt, verifiedAt + this.#cacheTtlMs);
      if (until > now) this.#cache.set(key, { account, until });
    }
    return account;
  }

  async #verifyCurrent(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<PimAccountScope> {
    const original = claims(accessToken, this.#now());
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.#timeoutMs),
    ]);
    const user = await this.#json("/api/v1/auth/me", {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: deadline,
    });
    if (
      user.id !== original.userId ||
      user.is_active !== true ||
      user.approval_status !== "approved" ||
      user.role !== original.userRole
    )
      throw new Error("pim_account_inactive_or_changed");

    // PIM checks the live membership before reissuing the same context.
    // Never request a browser-supplied tenant or another/default workspace.
    const refreshed = await this.#json("/api/v1/auth/switch-context", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tenant_id: original.tenantId,
        space_id: original.spaceId,
      }),
      signal: deadline,
    });
    const current = claims(refreshed.access_token, this.#now());
    if (
      current.userId !== original.userId ||
      current.tenantId !== original.tenantId ||
      current.spaceId !== original.spaceId ||
      current.userRole !== user.role
    )
      throw new Error("pim_account_scope_mismatch");
    signal.throwIfAborted();
    let spaceRole = current.spaceRole;
    if (this.#permissionOrigin !== undefined) {
      // The existing PIM space-list serializer omits member roles. Read the current
      // authenticated policy decision instead of promoting a JWT's fallback "viewer".
      const decision = await this.#json(
        `/api/v1/permissions/check?space_id=${current.spaceId}&action=space%3Aread`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: deadline,
        },
        this.#permissionOrigin,
      );
      const matched =
        typeof decision.reason === "string"
          ? /^space_role:(owner|admin|developer|member|viewer)$/u.exec(
              decision.reason,
            )
          : null;
      if (
        decision.allowed !== true ||
        matched === null ||
        !Array.isArray(decision.permissions) ||
        !decision.permissions.includes("space:read")
      )
        throw new Error("pim_account_membership_denied");
      spaceRole = matched[1]!;
    }
    signal.throwIfAborted();
    return Object.freeze({
      ...current,
      spaceRole,
      expiresAt: Math.min(original.expiresAt, current.expiresAt),
    });
  }

  async #json(
    path: string,
    init: RequestInit,
    origin = this.#origin,
  ): Promise<Record<string, unknown>> {
    const response = await this.#fetch(new URL(path, origin), {
      ...init,
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 401 || response.status === 403
          ? "pim_account_denied"
          : "pim_account_authority_unavailable",
      );
    }
    if (
      !/^application\/json(?:;|$)/iu.test(
        response.headers.get("content-type") ?? "",
      ) ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new Error("pim_account_response_invalid");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_RESPONSE_BYTES)
          throw new Error("pim_account_response_invalid");
        chunks.push(part.value);
      }
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } catch {
        // Never include an upstream response fragment (possibly a credential) in an error.
        throw new Error("pim_account_response_invalid");
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("pim_account_response_invalid");
      return value as Record<string, unknown>;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

function authorityOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("pim_authority_origin_invalid");
  return url;
}

function claims(token: unknown, now: number): PimAccountScope {
  if (
    typeof token !== "string" ||
    Buffer.byteLength(token) > MAX_TOKEN_BYTES ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
  )
    throw new Error("pim_account_token_invalid");
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    );
  } catch {
    throw new Error("pim_account_token_invalid");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.sub !== "string" ||
    !/^[1-9][0-9]{0,14}$/u.test(value.sub) ||
    !positive(value.tenant_id) ||
    !positive(value.space_id) ||
    !positive(value.exp) ||
    !Number.isSafeInteger(value.exp * 1000) ||
    value.exp * 1000 <= now ||
    value.type !== "access"
  )
    throw new Error("pim_account_token_invalid");
  return {
    userId: Number(value.sub),
    tenantId: value.tenant_id,
    spaceId: value.space_id,
    userRole: role(value.user_role),
    tenantRole: role(value.tenant_role),
    spaceRole: role(value.space_role),
    expiresAt: value.exp * 1000,
  };
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function role(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value))
    throw new Error("pim_account_role_invalid");
  return value;
}
