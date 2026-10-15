import {
  ProjectFoundationApplicationService,
  ProjectStructuredOutlineApplicationService,
  type CreativeProjectAuthorizationPort,
} from "@crewon/application";
import { PostgresDomainStore } from "@crewon/store";
import {
  parsePluginTaskAdmission,
  type PluginTaskAdmission,
} from "@crewon/domain";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "../standalone-adapters.ts";
import type { InstalledPluginExecutionConfig } from "./installed-plugin-runtime-composition.ts";
import { ioJson, ioRecord } from "./plugin-execution-io-network.ts";

type ProjectServices = Pick<
  InstalledPluginExecutionConfig,
  | "projectTools"
  | "projectFoundationTools"
  | "projectOutlineTools"
  | "projectAssetTools"
>;
type Service =
  | "project-tools"
  | "foundation-tools"
  | "outline-tools"
  | "asset-tools";

/** Explicit production opt-in. These ports borrow the original PostgreSQL stores and commit authorities. */
export function createRemoteProjectServices(
  post: (body: unknown, signal?: AbortSignal) => Promise<unknown>,
): ProjectServices {
  const authorization: CreativeProjectAuthorizationPort = Object.freeze({
    async authorize(
      input: Parameters<CreativeProjectAuthorizationPort["authorize"]>[0],
    ) {
      const permission = ioRecord(ioJson(input, 16384), [
        "actor",
        "action",
        "resource",
      ]);
      const actor = ioRecord(permission.actor, [
        "tenantId",
        "spaceId",
        "principalId",
        "actorId",
      ]);
      const resource = ioRecord(permission.resource, [
        "kind",
        "tenantId",
        "spaceId",
        "projectId",
      ]);
      if (
        resource.kind !== "creativeProject" ||
        resource.tenantId !== actor.tenantId ||
        resource.spaceId !== actor.spaceId ||
        ![
          "creativeProject:list",
          "creativeProject:create",
          "creativeProject:read",
          "creativeProject:write",
        ].includes(String(permission.action))
      )
        denied();
      const result = ioRecord(
        await post({
          schemaVersion: "crewon.plugin-project-service-policy.v1",
          kind: "permission",
          permission,
        }),
        ["outcome"],
      );
      if (result.outcome !== "allow" && result.outcome !== "deny") denied();
      return result.outcome === "allow"
        ? { outcome: "allow" as const }
        : {
            outcome: "deny" as const,
            reasonCode: "remote_project_service_denied",
          };
    },
  });
  const authorizeService =
    (service: Service) =>
    async (admission: PluginTaskAdmission, signal: AbortSignal) => {
      signal.throwIfAborted();
      const parsed = parsePluginTaskAdmission(admission);
      const response = ioRecord(
        await post(
          {
            schemaVersion: "crewon.plugin-project-service-policy.v1",
            kind: "service",
            service,
            admission: parsed,
          },
          signal,
        ),
        ["outcome"],
      );
      if (response.outcome !== "allow") denied();
      signal.throwIfAborted();
    };
  const common = Object.freeze({
    authorization,
    clock: new SystemApplicationClock(),
    ids: new UuidV7ApplicationIdGenerator(),
    digester: new NodeSha256ContentDigester(),
  });
  return Object.freeze({
    projectTools: Object.freeze({
      version: "crewon.project-tools.v1" as const,
      projectOwnership: "plugin-project-v1" as const,
      authorization,
      authorizeService: authorizeService("project-tools"),
    }),
    projectAssetTools: Object.freeze({
      version: "crewon.project-asset-tools.v1" as const,
      authorization,
      authorizeService: authorizeService("asset-tools"),
    }),
    projectFoundationTools: Object.freeze({
      version: "crewon.project-foundation-tools.v1" as const,
      projectOwnership: "plugin-project-v1" as const,
      authorization,
      authorizeService: authorizeService("foundation-tools"),
      createFoundations({
        store,
      }: Parameters<
        NonNullable<
          ProjectServices["projectFoundationTools"]
        >["createFoundations"]
      >[0]) {
        if (!(store instanceof PostgresDomainStore)) denied();
        return new ProjectFoundationApplicationService({
          ...common,
          projects: store.creativeProjectStore(),
          store: store.projectFoundationStore(),
          sourcePreparation: { loadPrepared: async () => denied() },
        });
      },
    }),
    projectOutlineTools: Object.freeze({
      version: "crewon.project-outline-tools.v2" as const,
      authorization,
      authorizeService: authorizeService("outline-tools"),
      createOutlines({
        store,
      }: Parameters<
        NonNullable<ProjectServices["projectOutlineTools"]>["createOutlines"]
      >[0]) {
        if (!(store instanceof PostgresDomainStore)) denied();
        return new ProjectStructuredOutlineApplicationService({
          ...common,
          projects: store.creativeProjectStore(),
          store: store.projectTextStore(),
          foundations: store.projectFoundationStore(),
        });
      },
    }),
  });
}
function denied(): never {
  throw new Error("remote_project_service_denied");
}
