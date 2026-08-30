import type { ActorContext, AuthorizationPort } from "@crewon/application";

import { environmentOr } from "./runtime-process-environment.ts";

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

export function loadRuntimeReleaseActor(): ActorContext {
  return {
    principalId: environmentOr(
      "CREWON_RELEASE_PRINCIPAL_ID",
      "standalone-release-principal",
    ),
    actorId: environmentOr("CREWON_RELEASE_ACTOR_ID", "standalone-release"),
    tenantId: environmentOr("CREWON_TENANT_ID", "standalone-tenant"),
    spaceId: environmentOr("CREWON_SPACE_ID", "standalone-space"),
  };
}
