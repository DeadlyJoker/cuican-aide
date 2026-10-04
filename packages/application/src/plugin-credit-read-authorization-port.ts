import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";

export type PluginCreditReadAuthorizationResource = Readonly<{
  kind: "pluginCredit";
  tenantId: string;
  spaceId: string;
  principalId: string;
  poolId: string | null;
}>;
export type PluginCreditReadAuthorizationRequest = Readonly<{
  actor: ActorContext;
  action: "pluginCredit:read";
  resource: PluginCreditReadAuthorizationResource;
}>;

/** Current personal-ledger read permission; no installation, funding, or execution authority. */
export interface PluginCreditReadAuthorizationPort {
  authorize(
    input: PluginCreditReadAuthorizationRequest,
  ): Promise<AuthorizationDecision>;
}
