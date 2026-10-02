import type {
  ActorContext,
  AuthorizationDecision,
  PluginInstallationAuthorizationPort,
  PluginInstallationHostProfilePort,
  PluginUiAuthorizationPort,
  PluginUiAuthorizationResource,
} from "@crewon/application";
import {
  parsePluginProfileScope,
  type PluginProfileScope,
} from "@crewon/domain";
import {
  AbortSecurityDeadline,
  DynamicPolicyAuthorization,
  type PolicyDecisionPort,
  type SecurityDeadlinePort,
} from "./production-security-adapters.ts";
import {
  pluginSecurityActor,
  pluginSecurityInstallationRequest,
  pluginSecurityInstallationDecision,
  pluginSecurityUiDecision,
  pluginSecurityUiRequest,
} from "./plugin-security-validation.ts";

export type PluginUiPolicyAction =
  | "pluginUi:catalog"
  | "pluginUi:mount"
  | "pluginUi:asset"
  | "pluginUi:invoke";

export interface PluginUiPolicyDecisionPort {
  /**
   * Returns the current decision. An allow epoch must remain stable across mount/asset/invoke for
   * the same authority domain and change on revocation/regrant; it is not a generated request ID.
   */
  decide(
    input: Readonly<{
      actor: ActorContext;
      action: PluginUiPolicyAction;
      resource: PluginUiAuthorizationResource;
      signal: AbortSignal;
    }>,
  ): Promise<unknown>;
}

export interface PluginProfileAuthorityPort {
  /** Resolves current server-owned profile authority, not a client-selected or derived profile. */
  resolve(
    input: Readonly<{ actor: ActorContext; signal: AbortSignal }>,
  ): Promise<unknown>;
}

export class DynamicPluginInstallationAuthorization
  implements PluginInstallationAuthorizationPort
{
  readonly #authorization: DynamicPolicyAuthorization;

  constructor(config: {
    policy: PolicyDecisionPort;
    timeoutMs: number;
    deadline?: SecurityDeadlinePort;
  }) {
    requireMethod(
      config.policy,
      "decide",
      "plugin_installation_policy_required",
    );
    const policy = config.policy;
    this.#authorization = new DynamicPolicyAuthorization({
      policy: {
        decide: async (input) =>
          pluginSecurityInstallationDecision(await policy.decide(input)),
      },
      timeoutMs: config.timeoutMs,
      deadline: securityDeadline(config),
    });
  }

  async authorize(
    input: Parameters<PluginInstallationAuthorizationPort["authorize"]>[0],
  ): Promise<AuthorizationDecision> {
    const request = pluginSecurityInstallationRequest(input);
    return pluginSecurityInstallationDecision(
      await this.#authorization.authorize(request),
    );
  }
}

export class DynamicPluginUiAuthorization implements PluginUiAuthorizationPort {
  readonly #policy: PluginUiPolicyDecisionPort;
  readonly #deadline: SecurityDeadlinePort;
  readonly #timeoutMs: number;

  constructor(config: {
    policy: PluginUiPolicyDecisionPort;
    timeoutMs: number;
    deadline?: SecurityDeadlinePort;
  }) {
    requireMethod(config.policy, "decide", "plugin_ui_policy_required");
    this.#policy = config.policy;
    this.#deadline = securityDeadline(config);
    this.#timeoutMs = config.timeoutMs;
  }

  async authorize(
    input: Parameters<PluginUiAuthorizationPort["authorize"]>[0],
  ): ReturnType<PluginUiAuthorizationPort["authorize"]> {
    const request = pluginSecurityUiRequest(input);
    if (!sameActorScope(request.actor, request.resource))
      return Object.freeze({
        outcome: "deny",
        reasonCode: "actor_scope_mismatch",
      });
    const action: PluginUiPolicyAction = `pluginUi:${request.action}`;
    const response = await this.#deadline.run(this.#timeoutMs, (signal) =>
      this.#policy.decide(
        Object.freeze({
          ...request,
          action,
          signal,
        }),
      ),
    );
    return pluginSecurityUiDecision(response);
  }
}

export class AuthorityPluginHostProfile
  implements PluginInstallationHostProfilePort
{
  readonly #authority: PluginProfileAuthorityPort;
  readonly #deadline: SecurityDeadlinePort;
  readonly #timeoutMs: number;

  constructor(config: {
    authority: PluginProfileAuthorityPort;
    timeoutMs: number;
    deadline?: SecurityDeadlinePort;
  }) {
    requireMethod(
      config.authority,
      "resolve",
      "plugin_profile_authority_required",
    );
    this.#authority = config.authority;
    this.#deadline = securityDeadline(config);
    this.#timeoutMs = config.timeoutMs;
  }

  async resolve(input: ActorContext): Promise<PluginProfileScope> {
    const actor = pluginSecurityActor(input);
    const response = await this.#deadline.run(this.#timeoutMs, (signal) =>
      this.#authority.resolve(Object.freeze({ actor, signal })),
    );
    const scope = parsePluginProfileScope(response);
    if (!sameActorScope(actor, scope))
      throw new Error("plugin_profile_scope_mismatch");
    return scope;
  }
}

function sameActorScope(
  actor: ActorContext,
  scope: Readonly<{ tenantId: string; spaceId: string }>,
): boolean {
  return actor.tenantId === scope.tenantId && actor.spaceId === scope.spaceId;
}

function securityDeadline(config: {
  timeoutMs: number;
  deadline?: SecurityDeadlinePort;
}): SecurityDeadlinePort {
  if (
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs < 1 ||
    config.timeoutMs > 30_000
  )
    throw new Error("plugin_security_timeout_invalid");
  const deadline = config.deadline ?? new AbortSecurityDeadline();
  requireMethod(deadline, "run", "plugin_security_deadline_required");
  return deadline;
}

function requireMethod(input: unknown, method: string, code: string): void {
  if (
    input === null ||
    (typeof input !== "object" && typeof input !== "function") ||
    typeof (input as Record<string, unknown>)[method] !== "function"
  )
    throw new Error(code);
}
