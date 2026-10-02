import type {
  ActorContext,
  AuthorizationDecision,
} from "./authorization-port.ts";

export type CreativeProjectAuthorizationAction =
  | "creativeProject:create"
  | "creativeProject:list"
  | "creativeProject:read"
  | "creativeProject:write";

/** Required trusted policy integration; ownership alone does not establish current access. */
export interface CreativeProjectAuthorizationPort {
  authorize(
    input: Readonly<{
      actor: ActorContext;
      action: CreativeProjectAuthorizationAction;
      resource: Readonly<{
        kind: "creativeProject";
        tenantId: string;
        spaceId: string;
        projectId: string | null;
      }>;
    }>,
  ): Promise<AuthorizationDecision>;
}
