import { createHash, randomBytes } from "node:crypto";
import type {
  WebIdentitySession,
  WebIdentitySessionPort,
} from "./identity-session-adapter.ts";
import type {
  PimAccountAuthority,
  PimAccountScope,
} from "./pim-account-authority.ts";
import { pimControlPolicy } from "./pim-control-policy.ts";

export type PimControlActor = Readonly<{
  tenantId: string;
  spaceId: string;
  principalId: string;
  actorId: string;
}>;
type Profile = Readonly<{
  scope: Readonly<{ tenantId: string; spaceId: string; profileId: string }>;
  authorityEpoch: string;
  membershipDigest: string;
  revoked: boolean;
}>;
export interface PimPluginProfilePort {
  resolveVerifiedAccount(input: {
    actor: PimControlActor;
    membershipDigest: string;
  }): Promise<Profile>;
}
type Session = Readonly<{
  web: WebIdentitySession;
  accountToken: string;
  actor: PimControlActor;
  issuedAt: number;
}>;
const COOKIE_NAME = "__Host-crewon-control";

/** Exchanges a real PIM account for a bounded, Control-only opaque credential.
 * This is an opt-in server authority. It never returns a Control token to browser code.
 */
export class PimControlSessions implements WebIdentitySessionPort {
  readonly #accounts: Pick<PimAccountAuthority, "verify">;
  readonly #profiles: PimPluginProfilePort;
  readonly #actorBindings:
    | {
        resolveVerifiedAccountActor(
          account: PimAccountScope,
        ): Promise<PimControlActor>;
      }
    | undefined;
  readonly #issuer: string;
  readonly #now: () => number;
  readonly #capacity: number;
  readonly #sessions = new Map<string, Session>();
  readonly #tokens = new Map<string, Session>();
  readonly #packages: ReadonlyMap<string, ReadonlySet<string>>;
  constructor(input: {
    accounts: Pick<PimAccountAuthority, "verify">;
    profiles: PimPluginProfilePort;
    actorBindings?: {
      resolveVerifiedAccountActor(
        account: PimAccountScope,
      ): Promise<PimControlActor>;
    };
    issuer: string;
    packages: ReadonlyMap<string, string | readonly string[]>;
    now?: () => number;
    capacity?: number;
  }) {
    const issuer = new URL(input.issuer);
    if (
      issuer.protocol !== "https:" ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash
    )
      throw new Error("pim_control_issuer_invalid");
    this.#accounts = input.accounts;
    this.#profiles = input.profiles;
    this.#actorBindings = input.actorBindings;
    this.#issuer = input.issuer;
    this.#now = input.now ?? Date.now;
    this.#capacity = input.capacity ?? 1000;
    if (
      !Number.isSafeInteger(this.#capacity) ||
      this.#capacity < 1 ||
      this.#capacity > 10000
    )
      throw new Error("pim_control_session_capacity_invalid");
    const packages = new Map<string, ReadonlySet<string>>();
    let count = 0;
    for (const [id, value] of input.packages) {
      const digests = typeof value === "string" ? [value] : [...value];
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(id) ||
        digests.length === 0 ||
        new Set(digests).size !== digests.length ||
        digests.some((digest) => !/^sha256:[a-f0-9]{64}$/u.test(digest)) ||
        (count += digests.length) > 32
      )
        throw new Error("pim_control_package_invalid");
      packages.set(id, new Set(digests));
    }
    this.#packages = packages;
  }
  async exchange(
    accountToken: string,
    signal: AbortSignal,
  ): Promise<{ session: WebIdentitySession; setCookie: string }> {
    this.#prune();
    if (
      this.#sessions.size >= this.#capacity &&
      ![...this.#sessions.values()].some(
        (session) => session.accountToken === accountToken,
      )
    )
      throw new Error("pim_control_session_capacity_exceeded");
    const account = await this.#accounts.verify(accountToken, signal);
    const actor = await this.#accountActor(account);
    const profile = await this.#profiles.resolveVerifiedAccount({
      actor,
      membershipDigest: membershipDigest(account),
    });
    assertProfile(profile, actor);
    signal.throwIfAborted();
    // Recheck after both awaits: concurrent exchanges cannot overrun the limit.
    this.#prune();
    const existing = [...this.#sessions.values()].find(
      (session) =>
        session.accountToken === accountToken &&
        sameActor(session.actor, actor) &&
        Date.parse(session.web.expiresAt) - this.#now() >= 1000,
    );
    if (existing)
      return {
        session: existing.web,
        setCookie: `${COOKIE_NAME}=${existing.web.sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor((Date.parse(existing.web.expiresAt) - this.#now()) / 1000)}`,
      };
    if (this.#sessions.size >= this.#capacity)
      throw new Error("pim_control_session_capacity_exceeded");
    const issuedAt = this.#now();
    const expiresAt = Math.min(issuedAt + 8 * 60 * 1000, account.expiresAt);
    if (expiresAt <= issuedAt) throw new Error("pim_control_account_expired");
    const web = Object.freeze({
      sessionId: randomBytes(32).toString("base64url"),
      controlAccessToken: randomBytes(32).toString("base64url"),
      expiresAt: new Date(expiresAt).toISOString(),
    });
    const session = Object.freeze({ web, accountToken, actor, issuedAt });
    this.#sessions.set(web.sessionId, session);
    this.#tokens.set(web.controlAccessToken, session);
    return {
      session: web,
      setCookie: `${COOKIE_NAME}=${web.sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor((expiresAt - issuedAt) / 1000)}`,
    };
  }
  async resolve(input: {
    cookie: string | null;
    userAgent: string | null;
    pimAccessToken?: string | null;
  }): Promise<WebIdentitySession | null> {
    this.#prune();
    const id = cookieSessionId(input.cookie);
    if (id === null) return null;
    const current = this.#sessions.get(id);
    // A stale cookie can never switch the new browser account back to an old one.
    // Missing credentials after logout cannot authorize through the remaining cookie.
    if (!current || input.pimAccessToken !== current.accountToken) return null;
    return current.web;
  }
  async resolvePublicPluginAsset(input: {
    cookie: string | null;
    signal: AbortSignal;
  }): Promise<WebIdentitySession | null> {
    this.#prune();
    const id = cookieSessionId(input.cookie);
    const session = id === null ? undefined : this.#sessions.get(id);
    if (!session) return null;
    await this.#current(session, input.signal);
    return session.web;
  }
  async verifyControlToken(accessToken: string, signal: AbortSignal) {
    this.#prune();
    const session = this.#tokens.get(accessToken);
    if (!session) throw new Error("pim_control_session_required");
    await this.#current(session, signal);
    return Object.freeze({
      issuer: this.#issuer,
      audience: "crewon-control",
      ...session.actor,
      issuedAt: new Date(session.issuedAt).toISOString(),
      expiresAt: session.web.expiresAt,
    });
  }
  async pluginProfile(actor: PimControlActor, signal: AbortSignal) {
    return (await this.#current(this.#forActor(actor), signal)).profile.scope;
  }
  async controlPolicy(
    input: {
      actor: PimControlActor;
      action: string;
      resource: Record<string, unknown>;
    },
    signal: AbortSignal,
  ) {
    const { account } = await this.#current(
      this.#forActor(input.actor),
      signal,
    );
    return pimControlPolicy({ ...input, spaceRole: account.spaceRole });
  }
  async pluginPolicy(
    input: {
      actor: PimControlActor;
      action: string;
      resource: Record<string, unknown>;
    },
    signal: AbortSignal,
  ) {
    const { profile, account } = await this.#current(
      this.#forActor(input.actor),
      signal,
    );
    const resource = input.resource;
    if (
      resource.tenantId !== input.actor.tenantId ||
      resource.spaceId !== input.actor.spaceId ||
      resource.profileId !== profile.scope.profileId
    )
      return denied("plugin_profile_scope_mismatch");
    const allowedActions =
      resource.kind === "pluginInstallation"
        ? [
            "pluginInstallation:read",
            "pluginInstallation:install",
            "pluginInstallation:select",
          ]
        : resource.kind === "pluginUi"
          ? [
              "pluginUi:catalog",
              "pluginUi:mount",
              "pluginUi:asset",
              "pluginUi:invoke",
            ]
          : [];
    if (!allowedActions.includes(input.action))
      return denied("plugin_policy_action_denied");
    const pluginId = resource.pluginId;
    const digest = resource.packageDigest;
    if (pluginId === null) {
      if (
        digest !== null ||
        !["pluginUi:catalog", "pluginInstallation:read"].includes(input.action)
      )
        return denied("plugin_policy_package_denied");
    } else if (
      typeof pluginId !== "string" ||
      !this.#packages.has(pluginId) ||
      (digest !== null &&
        (typeof digest !== "string" ||
          !this.#packages.get(pluginId)?.has(digest)))
    )
      return denied("plugin_policy_package_denied");
    if (
      !["owner", "admin", "developer", "editor", "member"].includes(
        account.spaceRole,
      ) &&
      [
        "pluginInstallation:install",
        "pluginInstallation:select",
        "pluginUi:invoke",
      ].includes(input.action)
    )
      return denied("plugin_policy_read_only");
    return Object.freeze({
      outcome: "allow" as const,
      authorityEpoch: profile.authorityEpoch,
    });
  }
  revokeCookie(cookie: string | null): void {
    const id = cookieSessionId(cookie);
    if (id === null) return;
    const session = this.#sessions.get(id);
    if (session) this.#remove(session);
  }
  close(): void {
    this.#sessions.clear();
    this.#tokens.clear();
  }
  async #current(session: Session, signal: AbortSignal) {
    const account = await this.#accounts.verify(session.accountToken, signal);
    const actor = await this.#accountActor(account);
    if (!sameActor(actor, session.actor))
      throw new Error("pim_control_account_changed");
    const profile = await this.#profiles.resolveVerifiedAccount({
      actor,
      membershipDigest: membershipDigest(account),
    });
    assertProfile(profile, actor);
    signal.throwIfAborted();
    if (
      this.#sessions.get(session.web.sessionId) !== session ||
      Date.parse(session.web.expiresAt) <= this.#now()
    )
      throw new Error("pim_control_session_required");
    return { account, profile };
  }
  #forActor(actor: PimControlActor): Session {
    this.#prune();
    const matches = [...this.#sessions.values()].filter((s) =>
      sameActor(s.actor, actor),
    );
    const latest = matches.sort((a, b) => b.issuedAt - a.issuedAt)[0];
    if (!latest) throw new Error("pim_control_session_required");
    return latest;
  }
  #accountActor(account: PimAccountScope): Promise<PimControlActor> {
    return (
      this.#actorBindings?.resolveVerifiedAccountActor(account) ??
      Promise.resolve(accountActor(account))
    );
  }
  #prune(): void {
    for (const session of this.#sessions.values())
      if (Date.parse(session.web.expiresAt) <= this.#now())
        this.#remove(session);
  }
  #remove(session: Session): void {
    this.#sessions.delete(session.web.sessionId);
    this.#tokens.delete(session.web.controlAccessToken);
  }
}
export function pimControlAccountActor(
  account: PimAccountScope,
): PimControlActor {
  return accountActor(account);
}
function accountActor(account: PimAccountScope): PimControlActor {
  return Object.freeze({
    tenantId: `pim-tenant-${account.tenantId}`,
    spaceId: `pim-space-${account.spaceId}`,
    principalId: `pim-user-${account.userId}`,
    actorId: `pim-user-${account.userId}`,
  });
}
function membershipDigest(account: PimAccountScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        account.userId,
        account.tenantId,
        account.spaceId,
        account.userRole,
        account.tenantRole,
        account.spaceRole,
      ]),
    )
    .digest("hex");
}
function sameActor(a: PimControlActor, b: PimControlActor): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.spaceId === b.spaceId &&
    a.principalId === b.principalId &&
    a.actorId === b.actorId
  );
}
function assertProfile(profile: Profile, actor: PimControlActor): void {
  if (
    profile.revoked ||
    profile.scope.tenantId !== actor.tenantId ||
    profile.scope.spaceId !== actor.spaceId ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(profile.authorityEpoch) ||
    !profile.scope.profileId
  )
    throw new Error("pim_control_profile_denied");
}
function cookieSessionId(cookie: string | null): string | null {
  if (cookie === null) return null;
  if (
    Buffer.byteLength(cookie) > 16 * 1024 ||
    /[\u0000-\u001f\u007f]/u.test(cookie)
  )
    return null;
  const values = cookie
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}
function denied(reasonCode: string) {
  return Object.freeze({ outcome: "deny" as const, reasonCode });
}
