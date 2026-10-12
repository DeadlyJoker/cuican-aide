import {
  ApplicationError,
  qualifyPluginProjectReadScope,
  ProjectTextApplicationService,
  ProjectStructuredOutlineApplicationService,
  type CreativeProjectAuthorizationPort,
  type PluginProjectReadScope,
} from "@crewon/application";
import type { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "../standalone-adapters.ts";
/** Per-call projections of original services and stores; no new project manager or persistence. */
export function projectToolBoundReadServices(
  input: Readonly<{
    store: PostgresDomainStore | SqliteRunStore;
    authorization: CreativeProjectAuthorizationPort;
  }>,
  scope: PluginProjectReadScope,
) {
  const source = qualifyPluginProjectReadScope(scope);
  if (source.runAuthority === undefined || source.purpose !== "read")
    throw new ApplicationError(
      "authorization",
      "plugin_project_text_read_source_required",
    );
  const projects = input.store.creativeProjectStore().bindProjectReads(scope);
  const texts = input.store.projectTextStore();
  if (texts.bindProjectReads === undefined)
    throw new Error("plugin_project_text_read_binding_unavailable");
  const store = texts.bindProjectReads(scope);
  const common = {
    authorization: {
      authorize: async (
        request: Parameters<CreativeProjectAuthorizationPort["authorize"]>[0],
      ) => {
        source.assertActive();
        if (
          request.action !== "creativeProject:read" ||
          request.resource.tenantId !== source.scope.tenantId ||
          request.resource.spaceId !== source.scope.spaceId ||
          (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
            (key) => request.actor[key] !== source.scope[key],
          ) ||
          request.resource.projectId !==
            source.runAuthority!.projectStageAdmission!.projectId
        )
          return {
            outcome: "deny" as const,
            reasonCode: "plugin_project_text_read_actor_mismatch",
          };
        const decision = await input.authorization.authorize(request);
        source.assertActive();
        return decision;
      },
    },
    clock: new SystemApplicationClock(),
    ids: new UuidV7ApplicationIdGenerator(),
    digester: new NodeSha256ContentDigester(),
  };
  return Object.freeze({
    texts: new ProjectTextApplicationService({ ...common, projects, store }),
    outlines: new ProjectStructuredOutlineApplicationService({
      ...common,
      projects,
      store,
      // This scope has no Foundation/novel source grant yet. Do not fall back to an ordinary reader.
      foundations: {
        loadFoundation: async () => {
          throw new ApplicationError(
            "authorization",
            "plugin_project_foundation_read_binding_unavailable",
          );
        },
      },
    }),
  });
}
