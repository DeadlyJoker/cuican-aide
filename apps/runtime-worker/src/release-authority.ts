import type { ActorContext, AuthorizationPort } from "@crewon/application";

import {
  resolveRuntimeAuthorityValue,
  type RuntimeProcessSecurityMode,
} from "./runtime-database-environment.ts";

export class RuntimeReleaseAuthorization implements AuthorizationPort {
  readonly #actor: ActorContext;

  constructor(actor: ActorContext) {
    this.#actor = structuredClone(actor);
  }

  async authorize(
    request: Parameters<AuthorizationPort["authorize"]>[0],
  ): Promise<Awaited<ReturnType<AuthorizationPort["authorize"]>>> {
    if (
      (request.action !== "agentVersion:publish" &&
        request.action !== "agentVersion:deploy") ||
      request.resource.kind !== "agentVersion" ||
      request.actor.principalId !== this.#actor.principalId ||
      request.actor.actorId !== this.#actor.actorId ||
      request.actor.tenantId !== this.#actor.tenantId ||
      request.actor.spaceId !== this.#actor.spaceId ||
      request.resource.tenantId !== this.#actor.tenantId ||
      request.resource.spaceId !== this.#actor.spaceId
    ) {
      return { outcome: "deny", reasonCode: "release_scope_mismatch" };
    }
    return { outcome: "allow" };
  }
}

export function loadRuntimeReleaseActor(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  securityMode: RuntimeProcessSecurityMode = "standalone",
): ActorContext {
  return {
    principalId: resolveRuntimeAuthorityValue(
      environment,
      securityMode,
      "CREWON_RELEASE_PRINCIPAL_ID",
      "standalone-release-principal",
    ),
    actorId: resolveRuntimeAuthorityValue(
      environment,
      securityMode,
      "CREWON_RELEASE_ACTOR_ID",
      "standalone-release",
    ),
    tenantId: resolveRuntimeAuthorityValue(
      environment,
      securityMode,
      "CREWON_TENANT_ID",
      "standalone-tenant",
    ),
    spaceId: resolveRuntimeAuthorityValue(
      environment,
      securityMode,
      "CREWON_SPACE_ID",
      "standalone-space",
    ),
  };
}
