import {
  ProjectStructuredOutlineApplicationService,
  type ActorContext,
  type CreativeProjectAuthorizationPort,
} from "@crewon/application";
import type { DesktopNativePluginPackageIdentity } from "@crewon/contracts/plugins";
import type { DesktopProjectOutlineToolsConfiguration } from "@crewon/contracts/plugins";
import type { PluginProfileScope, PluginTaskAdmission } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store/sqlite-run-store";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "../standalone-adapters.ts";
import type { InstalledPluginProjectOutlineToolsConfig } from "./installed-plugin-project-outline-tools.ts";

export type NativeProjectOutlineToolsDeclaration =
  DesktopProjectOutlineToolsConfiguration;
type Owner = Readonly<{
  declaration: NativeProjectOutlineToolsDeclaration | undefined;
  scope: PluginProfileScope;
  packages: readonly DesktopNativePluginPackageIdentity[];
  current(signal?: AbortSignal): void;
  actor(input: unknown): ActorContext;
  operate<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}>;

/** Independent Main approval for the new Node service, never inferred from the UI metadata
 * publication. The Worker borrows its actual parent SQLite store and original project identity. */
export function createNativeProjectOutlineTools(
  owner: Owner,
): InstalledPluginProjectOutlineToolsConfig | undefined {
  const declared = owner.declaration;
  if (declared === undefined) return undefined;
  owner.current();
  if (
    declared.version !== "crewon.project-outline-tools.v2" ||
    declared.publications.length === 0 ||
    declared.publications.some(
      (p) =>
        !owner.packages.some(
          (pkg) =>
            pkg.pluginId === p.pluginId &&
            pkg.packageDigest === p.packageDigest,
        ),
    )
  )
    denied();
  const authorization: CreativeProjectAuthorizationPort = Object.freeze({
    authorize: (
      permission: Parameters<CreativeProjectAuthorizationPort["authorize"]>[0],
    ) =>
      owner.operate(async () => {
        owner.current();
        owner.actor(permission.actor);
        return ["creativeProject:read", "creativeProject:write"].includes(
          permission.action,
        ) &&
          permission.resource.kind === "creativeProject" &&
          permission.resource.tenantId === owner.scope.tenantId &&
          permission.resource.spaceId === owner.scope.spaceId &&
          typeof permission.resource.projectId === "string"
          ? { outcome: "allow" as const }
          : {
              outcome: "deny" as const,
              reasonCode: "native_outline_policy_denied",
            };
      }),
  });
  return Object.freeze({
    version: "crewon.project-outline-tools.v2",
    authorization,
    authorizeService: (admission: PluginTaskAdmission, signal: AbortSignal) =>
      owner.operate(async () => {
        owner.current(signal);
        owner.actor({
          tenantId: admission.tenantId,
          spaceId: admission.spaceId,
          principalId: admission.principalId,
          actorId: admission.actorId,
        });
        if (
          admission.action !== "project.execute" ||
          admission.profileId !== owner.scope.profileId ||
          !declared.publications.some(
            (p) =>
              p.pluginId === admission.pluginId &&
              p.packageDigest === admission.packageDigest &&
              p.contributionId === admission.contributionId,
          ) ||
          !owner.packages.some(
            (p) =>
              p.pluginId === admission.pluginId &&
              p.publisherId === admission.publisherId &&
              p.version === admission.version &&
              p.packageDigest === admission.packageDigest,
          )
        )
          denied();
        owner.current(signal);
      }, signal),
    createOutlines: ({
      store,
    }: Parameters<
      InstalledPluginProjectOutlineToolsConfig["createOutlines"]
    >[0]) => {
      owner.current();
      if (!(store instanceof SqliteRunStore)) denied();
      return new ProjectStructuredOutlineApplicationService({
        projects: store.creativeProjectStore(),
        store: store.projectTextStore(),
        foundations: store.projectFoundationStore(),
        authorization,
        clock: new SystemApplicationClock(),
        ids: new UuidV7ApplicationIdGenerator(),
        digester: new NodeSha256ContentDigester(),
      });
    },
  });
}
function denied(): never {
  throw new Error("native_project_outline_service_denied");
}
