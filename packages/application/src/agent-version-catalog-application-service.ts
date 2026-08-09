import { ApplicationError } from "./application-error.ts";
import type {
  AgentVersionReleaseStore,
  ActiveAgentVersionRelease,
} from "./agent-version-release-store-port.ts";
import type {
  AgentVersionAsset,
  AgentVersionStore,
} from "./agent-version-store-port.ts";
import type { ActorContext, AuthorizationPort } from "./authorization-port.ts";
import { RunStoreError } from "./run-store-port.ts";

export type ActiveAgentVersionCatalog = Readonly<{
  releaseId: string;
  activatedAt: string;
  defaultAgentVersionId: string;
  assets: readonly AgentVersionAsset[];
}>;

/** Read-only safe catalog backed exclusively by the active release bundle. */
export class AgentVersionCatalogApplicationService {
  readonly #store: AgentVersionStore & AgentVersionReleaseStore;
  readonly #authorization: AuthorizationPort;

  constructor(dependencies: {
    store: AgentVersionStore & AgentVersionReleaseStore;
    authorization: AuthorizationPort;
  }) {
    this.#store = dependencies.store;
    this.#authorization = dependencies.authorization;
  }

  async getActive(actor: ActorContext): Promise<ActiveAgentVersionCatalog> {
    validateActor(actor);
    await this.#authorize(actor);
    let active: ActiveAgentVersionRelease | null;
    try {
      active = await this.#store.loadActiveAgentVersionRelease({
        tenantId: actor.tenantId,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
    if (active === null) {
      throw new ApplicationError("notFound", "agent_version_release_missing");
    }
    const assets: AgentVersionAsset[] = [];
    for (const deployment of active.bundle.deployments) {
      let asset: AgentVersionAsset | null;
      try {
        asset = await this.#store.loadAgentVersion({
          tenantId: actor.tenantId,
          agentVersionId: deployment.agentVersionId,
        });
      } catch (error) {
        throw mapStoreError(error);
      }
      if (asset === null) {
        throw new ApplicationError(
          "internal",
          "agent_version_release_asset_missing",
        );
      }
      if (
        asset.tenantId !== actor.tenantId ||
        asset.contentDigest !== deployment.contentDigest
      ) {
        throw new ApplicationError(
          "internal",
          "agent_version_release_asset_mismatch",
        );
      }
      assets.push(asset);
    }
    if (
      !assets.some(
        (asset) => asset.agentVersionId === active.bundle.defaultAgentVersionId,
      )
    ) {
      throw new ApplicationError(
        "internal",
        "agent_version_release_default_missing",
      );
    }
    return {
      releaseId: active.bundle.releaseId,
      activatedAt: active.activation.activatedAt,
      defaultAgentVersionId: active.bundle.defaultAgentVersionId,
      assets,
    };
  }

  async #authorize(actor: ActorContext): Promise<void> {
    try {
      const decision = await this.#authorization.authorize({
        actor,
        action: "agentVersion:list",
        resource: {
          kind: "agentVersion",
          tenantId: actor.tenantId,
          spaceId: actor.spaceId,
          agentVersionId: null,
        },
      });
      if (decision.outcome !== "allow") {
        throw new ApplicationError("authorization", "authorization_denied");
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
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

function mapStoreError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof RunStoreError) {
    return new ApplicationError("internal", "store_unavailable", {
      cause: error,
    });
  }
  return new ApplicationError("internal", "application_internal", {
    cause: error,
  });
}
