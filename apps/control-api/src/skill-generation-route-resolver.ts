import { parseAgentVersionAsset } from "@crewon/agent-version";
import {
  ApplicationError,
  type AgentVersionStore,
  type ContentDigester,
  type RunRouteResolverPort,
} from "@crewon/application";

/** Uses a published immutable role; it never grants tools or publishes a new version. */
export function createConfiguredSkillGenerationRouteResolver(dependencies: {
  routes: RunRouteResolverPort;
  store: Pick<AgentVersionStore, "loadAgentVersion">;
  digester: ContentDigester;
  generationAgentVersionId?: string;
}): RunRouteResolverPort {
  return {
    async resolveRoute(input) {
      const configured = dependencies.generationAgentVersionId;
      if (
        configured !== undefined &&
        input.agentVersionId !== null &&
        input.agentVersionId !== configured
      )
        throw new ApplicationError(
          "authorization",
          "skill_generation_agent_selection_invalid",
        );
      // Preserve all existing actor, workspace, and release/runtime admission checks.
      const route = await dependencies.routes.resolveRoute({
        ...input,
        agentVersionId: configured ?? input.agentVersionId,
      });
      if (configured !== undefined && route.agentVersionId !== configured)
        throw new ApplicationError(
          "authorization",
          "skill_generation_route_mismatch",
        );
      const asset = await dependencies.store.loadAgentVersion({
        tenantId: input.actor.tenantId,
        agentVersionId: route.agentVersionId,
      });
      if (asset === null)
        throw new ApplicationError(
          "notFound",
          "skill_generation_agent_unavailable",
        );
      let version;
      try {
        version = parseAgentVersionAsset(asset, dependencies.digester);
      } catch {
        throw new ApplicationError(
          "authorization",
          "skill_generation_agent_invalid",
        );
      }
      if (
        asset.tenantId !== input.actor.tenantId ||
        version.agentVersionId !== route.agentVersionId ||
        version.runtimeGeneration !== route.runtimeGeneration ||
        version.policySnapshotId !== route.policySnapshotId ||
        (version.resources.workspaceRequired &&
          !route.workspaceBindingId?.trim())
      )
        throw new ApplicationError(
          "authorization",
          "skill_generation_route_mismatch",
        );
      // Provider-owned agents can execute internal tools outside CrewON's kernel fence.
      if (
        version.model.adapterName !== "direct-responses" ||
        version.tools.length !== 0 ||
        version.execution.maxToolRounds !== 0
      )
        throw new ApplicationError(
          "authorization",
          "skill_generation_tool_free_agent_required",
        );
      return route;
    },
  };
}
