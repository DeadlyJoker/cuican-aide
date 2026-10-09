import { notifyAgentPlatformSessionChanged } from "./agentPlatformSessionEvents";

export const AGENT_PLATFORM_TOKEN_STORAGE_KEY = "crewon-agent-platform-token";
export const AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY =
  "crewon-agent-platform-refresh-token";

export type AgentPlatformSessionSnapshot = Readonly<{
  generation: number;
  signal: AbortSignal;
}>;
export type AgentPlatformAccessSession = Readonly<{
  accessToken: string | null;
  session: AgentPlatformSessionSnapshot;
}>;

type Dependencies = Readonly<{
  baseUrl(): string;
  envValue(key: string): string | undefined;
  unifiedSsoEnabled(): boolean;
  pimToken(): string | null;
  unavailableError(message: string): Error;
}>;
type TokenOperation = {
  readonly session: AgentPlatformSessionSnapshot;
  readonly physical: Promise<AgentPlatformAccessSession>;
  accepted: AgentPlatformAccessSession | null;
};

/** One page owns one account epoch and at most one actual automatic token operation. */
export class AgentPlatformAccessTokenOwner {
  readonly #dependencies: Dependencies;
  #generation = 0;
  #epoch = new AbortController();
  #cachedToken: string | null = null;
  #cachedTokenExpiresAt = 0;
  #cachedRefreshToken: string | null = null;
  #credentialsLoaded = false;
  #explicitOpaqueToken = false;
  #cachedBffUser: Record<string, unknown> | null = null;
  #pending: TokenOperation | null = null;
  #automaticRestoreBlocked = false;

  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  capture(): AgentPlatformSessionSnapshot {
    return Object.freeze({
      generation: this.#generation,
      signal: this.#epoch.signal,
    });
  }

  assertCurrent(session: AgentPlatformSessionSnapshot): void {
    if (!this.#isCurrent(session))
      throw new Error("agent_platform_session_changed");
  }

  async accessSession(): Promise<AgentPlatformAccessSession> {
    const session = this.capture();
    let access: AgentPlatformAccessSession;
    try {
      access = await this.#token(session);
    } catch (error) {
      this.assertCurrent(session);
      throw error;
    }
    this.assertCurrent(access.session);
    return access;
  }

  async accessToken(): Promise<string | null> {
    const session = this.capture();
    try {
      const access = await this.#token(session);
      return this.#isCurrent(access.session) ? access.accessToken : null;
    } catch (error) {
      if (!this.#isCurrent(session)) return null;
      throw error;
    }
  }

  bffUser(): Record<string, unknown> | null {
    return this.#dependencies.unifiedSsoEnabled() ? this.#cachedBffUser : null;
  }

  /** Explicit login replaces the whole account, including any previous refresh credential. */
  store(accessToken: string, refreshToken?: string | null): void {
    this.#store(accessToken, refreshToken);
    notifyAgentPlatformSessionChanged();
  }

  publish(
    input: Readonly<{
      session: AgentPlatformSessionSnapshot;
      accessToken: string;
      refreshToken?: string | null;
    }>,
  ): AgentPlatformSessionSnapshot {
    this.assertCurrent(input.session);
    const session = this.#store(input.accessToken, input.refreshToken);
    notifyAgentPlatformSessionChanged();
    this.assertCurrent(session);
    return session;
  }

  #store(
    accessToken: string,
    refreshToken?: string | null,
  ): AgentPlatformSessionSnapshot {
    this.#withdraw(false);
    this.#cachedToken = accessToken;
    this.#cachedTokenExpiresAt = jwtExpiryMilliseconds(accessToken);
    this.#cachedRefreshToken = refreshToken || null;
    this.#explicitOpaqueToken = this.#cachedTokenExpiresAt === 0;
    if (this.#dependencies.unifiedSsoEnabled()) {
      removeStoredCredential(AGENT_PLATFORM_TOKEN_STORAGE_KEY);
      removeStoredCredential(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY);
    } else {
      writeStoredCredential(AGENT_PLATFORM_TOKEN_STORAGE_KEY, accessToken);
      if (refreshToken)
        writeStoredCredential(
          AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
          refreshToken,
        );
      else removeStoredCredential(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY);
    }
    return this.capture();
  }

  /** Withdraw first; a logout remains logged out until explicit login or a new page. */
  clear(
    options: Readonly<{ notifySessionChanged?: boolean }> = {},
  ): AgentPlatformSessionSnapshot {
    this.#withdraw(true);
    removeStoredCredential(AGENT_PLATFORM_TOKEN_STORAGE_KEY);
    removeStoredCredential(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY);
    const session = this.capture();
    if (options.notifySessionChanged !== false)
      notifyAgentPlatformSessionChanged();
    return session;
  }

  /** PIM mutations are synchronous account boundaries, separately from UI notifications. */
  pimChanged(): void {
    this.#withdraw(this.#dependencies.pimToken() === null);
  }

  /** A same-account 401 may invalidate only the token actually used by that request. */
  async retryRejectedToken(
    session: AgentPlatformSessionSnapshot,
    accessToken: string | null,
  ): Promise<AgentPlatformAccessSession | null> {
    this.assertCurrent(session);
    if (
      this.#dependencies.unifiedSsoEnabled() ||
      this.#dependencies.pimToken() !== null ||
      !this.#cachedRefreshToken
    )
      return null;
    if (this.#cachedToken === accessToken) {
      this.#cachedToken = null;
      this.#cachedTokenExpiresAt = 0;
      removeStoredCredential(AGENT_PLATFORM_TOKEN_STORAGE_KEY);
    }
    const access = await this.#token(session);
    this.assertCurrent(access.session);
    return access;
  }

  #isCurrent(session: AgentPlatformSessionSnapshot): boolean {
    return (
      session.generation === this.#generation &&
      session.signal === this.#epoch.signal &&
      !session.signal.aborted
    );
  }

  #withdraw(blockAutomaticRestore: boolean): void {
    this.#epoch.abort();
    this.#epoch = new AbortController();
    this.#generation++;
    this.#automaticRestoreBlocked = blockAutomaticRestore;
    this.#cachedToken = null;
    this.#cachedTokenExpiresAt = 0;
    this.#cachedRefreshToken = null;
    this.#credentialsLoaded = true;
    this.#explicitOpaqueToken = false;
    this.#cachedBffUser = null;
    // #pending belongs to the real fetch/body work. Abort does not retire its slot.
  }

  #access(
    accessToken: string | null,
    session: AgentPlatformSessionSnapshot,
  ): AgentPlatformAccessSession {
    return Object.freeze({ accessToken, session });
  }

  async #assertResponseCurrent(
    session: AgentPlatformSessionSnapshot,
    response: Response,
  ): Promise<void> {
    try {
      this.assertCurrent(session);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
  }

  async #token(
    session: AgentPlatformSessionSnapshot,
  ): Promise<AgentPlatformAccessSession> {
    this.assertCurrent(session);
    const pimToken = this.#dependencies.pimToken();
    if (pimToken !== null) return this.#access(pimToken, session);
    if (this.#automaticRestoreBlocked) return this.#access(null, session);
    if (!this.#credentialsLoaded && !this.#dependencies.unifiedSsoEnabled()) {
      this.#credentialsLoaded = true;
      this.#cachedToken = readStoredCredential(
        AGENT_PLATFORM_TOKEN_STORAGE_KEY,
      );
      this.#cachedTokenExpiresAt = this.#cachedToken
        ? jwtExpiryMilliseconds(this.#cachedToken)
        : 0;
      this.#cachedRefreshToken = readStoredCredential(
        AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
      );
      this.assertCurrent(session);
    }
    if (this.#cachedToken && !this.#matchesRequirements(this.#cachedToken))
      return this.#access(null, this.clear());
    if (
      this.#cachedToken &&
      (Date.now() + 30_000 < this.#cachedTokenExpiresAt ||
        (this.#cachedTokenExpiresAt === 0 &&
          (!this.#dependencies.unifiedSsoEnabled() ||
            this.#explicitOpaqueToken)))
    ) {
      return this.#access(this.#cachedToken, session);
    }
    if (this.#pending !== null) {
      const accepted = this.#pending.accepted;
      if (accepted && this.#isCurrent(accepted.session)) return accepted;
      return this.#isCurrent(this.#pending.session)
        ? this.#pending.physical
        : this.#access(null, session);
    }
    return this.#start(session);
  }

  #start(
    session: AgentPlatformSessionSnapshot,
  ): Promise<AgentPlatformAccessSession> {
    const physical = Promise.resolve()
      .then(async () => {
        this.assertCurrent(session);
        return this.#dependencies.unifiedSsoEnabled()
          ? this.#obtainBff(session)
          : this.#restore(session);
      })
      .finally(() => {
        if (this.#pending?.physical === physical) this.#pending = null;
      });
    this.#pending = { session, physical, accepted: null };
    return physical;
  }

  async #restore(
    session: AgentPlatformSessionSnapshot,
  ): Promise<AgentPlatformAccessSession> {
    const refreshed = await this.#refresh(session);
    if (refreshed !== null) return refreshed;
    this.assertCurrent(session);
    return this.#devLogin(session);
  }

  async #refresh(
    session: AgentPlatformSessionSnapshot,
  ): Promise<AgentPlatformAccessSession | null> {
    const refreshToken = this.#cachedRefreshToken;
    if (!refreshToken) {
      if (
        this.#cachedTokenExpiresAt > 0 &&
        this.#cachedTokenExpiresAt <= Date.now() + 30_000
      ) {
        return this.#access(null, this.clear());
      }
      return null;
    }
    const response = await fetch(
      `${this.#dependencies.baseUrl()}/api/v1/auth/refresh`,
      {
        method: "POST",
        body: new URLSearchParams({ refresh_token: refreshToken }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        credentials: "same-origin",
        cache: "no-store",
        signal: session.signal,
      },
    );
    await this.#assertResponseCurrent(session, response);
    if (!response.ok) {
      await response.body?.cancel();
      this.assertCurrent(session);
      if (response.status === 429 || response.status >= 500) {
        throw this.#dependencies.unavailableError(
          "账号服务暂时不可用，请稍后重试。",
        );
      }
      return this.#access(null, this.clear());
    }
    const body = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    this.assertCurrent(session);
    if (!body.access_token || !this.#matchesRequirements(body.access_token)) {
      return this.#access(null, this.clear());
    }
    const publication = this.#publish(
      session,
      body.access_token,
      jwtExpiryMilliseconds(body.access_token),
      null,
      body.refresh_token || refreshToken,
    );
    writeStoredCredential(AGENT_PLATFORM_TOKEN_STORAGE_KEY, body.access_token);
    if (body.refresh_token)
      writeStoredCredential(
        AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY,
        body.refresh_token,
      );
    if (publication.changed) notifyAgentPlatformSessionChanged();
    this.assertCurrent(publication.access.session);
    return publication.access;
  }

  async #devLogin(
    session: AgentPlatformSessionSnapshot,
  ): Promise<AgentPlatformAccessSession> {
    this.assertCurrent(session);
    const username = this.#dependencies.envValue(
      "VITE_AGENT_PLATFORM_DEV_USERNAME",
    );
    const password = this.#dependencies.envValue(
      "VITE_AGENT_PLATFORM_DEV_PASSWORD",
    );
    if (!username || !password) return this.#access(null, session);
    const response = await fetch(
      `${this.#dependencies.baseUrl()}/api/v1/auth/login`,
      {
        method: "POST",
        body: new URLSearchParams({ username, password }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: session.signal,
      },
    );
    await this.#assertResponseCurrent(session, response);
    if (!response.ok) {
      await response.body?.cancel();
      this.assertCurrent(session);
      return this.#access(null, session);
    }
    const body = (await response.json()) as { access_token?: string };
    this.assertCurrent(session);
    if (!body.access_token || !this.#matchesRequirements(body.access_token))
      return this.#access(null, session);
    const publication = this.#publish(
      session,
      body.access_token,
      jwtExpiryMilliseconds(body.access_token),
      null,
    );
    writeStoredCredential(AGENT_PLATFORM_TOKEN_STORAGE_KEY, body.access_token);
    removeStoredCredential(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY);
    if (publication.changed) notifyAgentPlatformSessionChanged();
    this.assertCurrent(publication.access.session);
    return publication.access;
  }

  async #obtainBff(
    session: AgentPlatformSessionSnapshot,
  ): Promise<AgentPlatformAccessSession> {
    removeStoredCredential(AGENT_PLATFORM_TOKEN_STORAGE_KEY);
    removeStoredCredential(AGENT_PLATFORM_REFRESH_TOKEN_STORAGE_KEY);
    const response = await fetch(
      `${this.#dependencies.baseUrl()}/sso/client/crewon/token`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        signal: session.signal,
      },
    );
    await this.#assertResponseCurrent(session, response);
    if (!response.ok) {
      await response.body?.cancel();
      this.assertCurrent(session);
      if (response.status === 401) return this.#access(null, session);
      throw this.#dependencies.unavailableError(
        `SSO session token failed: ${response.status}`,
      );
    }
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      user?: Record<string, unknown>;
    };
    this.assertCurrent(session);
    if (!body.access_token) return this.#access(null, session);
    const publication = this.#publish(
      session,
      body.access_token,
      Date.now() + Math.max(0, Number(body.expires_in ?? 0)) * 1000,
      body.user ?? null,
    );
    if (publication.changed) notifyAgentPlatformSessionChanged();
    this.assertCurrent(publication.access.session);
    return publication.access;
  }

  #publish(
    session: AgentPlatformSessionSnapshot,
    token: string,
    expiresAt: number,
    user: Record<string, unknown> | null,
    refreshToken: string | null = null,
  ): Readonly<{ access: AgentPlatformAccessSession; changed: boolean }> {
    this.assertCurrent(session);
    const changed =
      this.#cachedToken !== token || !sameUser(this.#cachedBffUser, user);
    if (changed) this.#withdraw(false);
    this.#cachedToken = token;
    this.#cachedTokenExpiresAt = expiresAt;
    this.#cachedRefreshToken = refreshToken;
    this.#credentialsLoaded = true;
    this.#explicitOpaqueToken = false;
    this.#cachedBffUser = user;
    const access = this.#access(token, this.capture());
    if (
      this.#pending?.session.generation === session.generation &&
      this.#pending.session.signal === session.signal
    )
      this.#pending.accepted = access;
    return Object.freeze({ access, changed });
  }

  #matchesRequirements(token: string): boolean {
    if (
      this.#dependencies.envValue("VITE_CREWON_PRINCIPAL_SESSION_ENABLED") !==
      "true"
    )
      return true;
    const payload = jwtPayload(token);
    if (!payload) return false;
    if (
      isPositiveInteger(payload.tenant_id) &&
      isPositiveInteger(payload.space_id) &&
      typeof payload.crewon_auth_session_id === "string" &&
      payload.crewon_auth_session_id.length > 0 &&
      isPositiveInteger(payload.crewon_auth_epoch)
    )
      return true;
    // Preserve compatibility with authorities that do not issue auth-session claims.
    return !(
      "crewon_auth_session_id" in payload || "crewon_auth_epoch" in payload
    );
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
function readStoredCredential(key: string): string | null {
  try {
    return browserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writeStoredCredential(key: string, value: string): void {
  try {
    browserStorage()?.setItem(key, value);
  } catch {
    // This page's current memory credential is authoritative when persistence fails.
  }
}
function removeStoredCredential(key: string): void {
  try {
    browserStorage()?.removeItem(key);
  } catch {
    // Withdrawal is already effective; persisted remnants cannot reactivate this owner.
  }
}
function jwtExpiryMilliseconds(token: string): number {
  const payload = jwtPayload(token);
  return typeof payload?.exp === "number" ? payload.exp * 1000 : 0;
}
function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded: unknown = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    );
    return typeof decoded === "object" &&
      decoded !== null &&
      !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function sameUser(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  )
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameUser(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        sameUser(leftRecord[key], rightRecord[key]),
    )
  );
}
