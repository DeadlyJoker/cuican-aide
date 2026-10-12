import {
  ApplicationError,
  ProjectFoundationApplicationService,
  qualifyPluginProjectReadScope,
  type CreativeProjectAuthorizationPort,
  type PluginProjectReadScope,
} from "@crewon/application";
import type { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "../standalone-adapters.ts";
/** Per-call original service on original stores; an independent Foundation source is mandatory. */
export function projectFoundationBoundReadService(
  input: Readonly<{
    store: PostgresDomainStore | SqliteRunStore;
    authorization: CreativeProjectAuthorizationPort;
  }>,
  scope: PluginProjectReadScope,
): ProjectFoundationApplicationService {
  const source = qualifyPluginProjectReadScope(scope);
  const q = source.foundationRunAuthority;
  if (q === undefined || source.purpose !== "read")
    throw new ApplicationError(
      "authorization",
      "plugin_project_foundation_read_source_required",
    );
  const denied = async (): Promise<never> => {
    throw new ApplicationError(
      "authorization",
      "plugin_project_foundation_read_cannot_mutate",
    );
  };
  const reads = input.store.projectFoundationStore().bindProjectReads(scope);
  return new ProjectFoundationApplicationService({
    projects: input.store.creativeProjectStore().bindProjectReads(scope),
    store: {
      ...reads,
      loadMutationReceipt: denied,
      commitCreation: denied,
      commitFoundationChange: denied,
      commitProposal: denied,
    },
    sourcePreparation: { loadPrepared: denied },
    authorization: {
      authorize: async (request) => {
        source.assertActive();
        if (
          request.action !== "creativeProject:read" ||
          request.resource.projectId !== q.foundationAdmission.projectId ||
          request.resource.tenantId !== source.scope.tenantId ||
          request.resource.spaceId !== source.scope.spaceId ||
          (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
            (key) => request.actor[key] !== source.scope[key],
          )
        )
          return {
            outcome: "deny" as const,
            reasonCode: "plugin_project_foundation_read_actor_mismatch",
          };
        const decision = await input.authorization.authorize(request);
        source.assertActive();
        return decision;
      },
    },
    clock: new SystemApplicationClock(),
    ids: new UuidV7ApplicationIdGenerator(),
    digester: new NodeSha256ContentDigester(),
  });
}
