import {
  AgentVersionError,
  parseAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import {
  AgentVersionApplicationService,
  ApplicationError,
  type AgentVersionReleaseStore,
  type ContentDigester,
  type RunRoute,
  type RunStore,
} from "@crewon/application";

import type {
  AgentVersionAdmissionPort,
  ControlApiReadinessPort,
  RunRouteResolverPort,
} from "./control-api-ports.ts";

/** Resolves each tenant's active default without any process-wide Actor authority. */
export class ProductionAgentVersionRunRouteResolver
  implements RunRouteResolverPort
{
  readonly #agentVersions: AgentVersionApplicationService;
  readonly #releases: AgentVersionReleaseStore;
  readonly #digester: ContentDigester;
  readonly #admission: AgentVersionAdmissionPort;

  constructor(dependencies: {
    agentVersions: AgentVersionApplicationService;
    releases: AgentVersionReleaseStore;
    digester: ContentDigester;
    admission: AgentVersionAdmissionPort;
  }) {
    this.#agentVersions = dependencies.agentVersions;
    this.#releases = dependencies.releases;
    this.#digester = dependencies.digester;
    this.#admission = dependencies.admission;
  }

  async resolveRoute(
    input: Parameters<RunRouteResolverPort["resolveRoute"]>[0],
  ): Promise<RunRoute> {
    validateRouteInput(input);
    let agentVersionId = input.agentVersionId;
    if (agentVersionId === null) {
      const active = await this.#releases.loadActiveAgentVersionRelease({
        tenantId: input.actor.tenantId,
      });
      if (active === null) {
        throw new ApplicationError(
          "conflict",
          "agent_version_release_not_active",
        );
      }
      agentVersionId = active.bundle.defaultAgentVersionId;
    }
    const asset = await this.#agentVersions.get(input.actor, agentVersionId);
    let version: CompiledAgentVersion;
    try {
      version = parseAgentVersionAsset(asset, this.#digester);
    } catch (error) {
      if (error instanceof AgentVersionError) {
        throw new ApplicationError(
          "internal",
          "agent_version_definition_invalid",
          { cause: error },
        );
      }
      throw error;
    }
    const decision = await this.#admission.evaluate({
      actor: input.actor,
      version,
    });
    if (decision.outcome !== "allow") {
      throw new ApplicationError("conflict", "agent_version_not_admitted");
    }
    return {
      authorityId: decision.authorityId,
      runtimeGeneration: version.runtimeGeneration,
      agentVersionId: version.agentVersionId,
      policySnapshotId: version.policySnapshotId,
      workspaceBindingId: decision.workspaceBindingId,
    };
  }
}

/** Production readiness checks shared Store connectivity without assuming one tenant. */
export class ProductionStoreReadiness implements ControlApiReadinessPort {
  readonly #store: RunStore;

  constructor(store: RunStore) {
    this.#store = store;
  }

  async checkReady(): Promise<void> {
    await this.#store.listPendingOutbox(1);
  }
}

function validateRouteInput(
  input: Parameters<RunRouteResolverPort["resolveRoute"]>[0],
): void {
  requireBounded(input.actor.principalId, 512);
  requireBounded(input.actor.actorId, 512);
  requireBounded(input.actor.tenantId, 512);
  requireBounded(input.actor.spaceId, 512);
  requireBounded(input.threadId, 512);
  if (input.agentVersionId !== null) {
    requireBounded(input.agentVersionId, 512);
  }
}

function requireBounded(value: string, maximum: number): void {
  if (
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > maximum
  ) {
    throw new ApplicationError("validation", "run_route_input_invalid");
  }
}
