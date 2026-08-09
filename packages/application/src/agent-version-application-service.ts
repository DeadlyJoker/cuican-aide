import { ApplicationError } from "./application-error.ts";
import type {
  AgentVersionAsset,
  AgentVersionStore,
  RegisterAgentVersionResult,
} from "./agent-version-store-port.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { RunStoreError } from "./run-store-port.ts";

/** Tenant-scoped publication and discovery boundary for immutable AgentVersions. */
export class AgentVersionApplicationService {
  readonly #store: AgentVersionStore;
  readonly #authorization: AuthorizationPort;

  constructor(dependencies: {
    store: AgentVersionStore;
    authorization: AuthorizationPort;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
  }

  async publish(
    actor: ActorContext,
    asset: AgentVersionAsset,
  ): Promise<RegisterAgentVersionResult> {
    validateActor(actor);
    if (asset.tenantId !== actor.tenantId) {
      throw new ApplicationError("authorization", "authorization_denied");
    }
    await this.#authorize(actor, "agentVersion:publish", asset.agentVersionId);
    try {
      return await this.#store.registerAgentVersion(asset);
    } catch (error) {
      if (error instanceof RunStoreError) {
        throw new ApplicationError(
          error.code === "agent_version_id_conflict"
            ? "conflict"
            : error.code.startsWith("agent_version_")
              ? "validation"
              : "internal",
          error.code,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async get(
    actor: ActorContext,
    agentVersionId: string,
  ): Promise<AgentVersionAsset> {
    validateActor(actor);
    await this.#authorize(actor, "agentVersion:read", agentVersionId);
    const asset = await this.#store.loadAgentVersion({
      tenantId: actor.tenantId,
      agentVersionId,
    });
    if (asset === null) {
      throw new ApplicationError("notFound", "agent_version_not_found");
    }
    return asset;
  }

  async list(
    actor: ActorContext,
    input: { afterAgentVersionId: string | null; limit: number },
  ): Promise<readonly AgentVersionAsset[]> {
    validateActor(actor);
    await this.#authorize(actor, "agentVersion:list", null);
    return this.#store.listAgentVersions({
      tenantId: actor.tenantId,
      afterAgentVersionId: input.afterAgentVersionId,
      limit: input.limit,
    });
  }

  async #authorize(
    actor: ActorContext,
    action: "agentVersion:publish" | "agentVersion:read" | "agentVersion:list",
    agentVersionId: string | null,
  ): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action,
        resource: {
          kind: "agentVersion",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          agentVersionId,
        },
      });
      if (decision.outcome !== "allow") {
        throw new ApplicationError("authorization", "authorization_denied");
      }
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
      throw new ApplicationError("authorization", "authorization_unavailable", {
        cause: error,
      });
    }
  }
}

function validateActor(actor: ActorContext): void {
  for (const value of [
    actor.principalId,
    actor.actorId,
    actor.tenantId,
    actor.spaceId,
  ]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ApplicationError("validation", "actor_invalid");
    }
  }
}
