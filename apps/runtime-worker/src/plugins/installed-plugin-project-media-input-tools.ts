import { types } from "node:util";
import {
  ProjectMediaInputApplicationService,
  materialPreparationFields,
  projectMediaInputBound,
  type CreativeProjectAuthorizationPort,
} from "@crewon/application";
import type { PluginTaskAdmission } from "@crewon/domain";
import type { SqliteRunStore, PostgresDomainStore } from "@crewon/store";
import type { ProjectMediaInputToolsServiceOwnerDependencies } from "./project-media-input-tools-service-owner.ts";
import type { InstalledPluginRunContextDependencies } from "./installed-plugin-run-context.ts";

/** Trusted deployment factory for metadata services on the actual parent; it owns no runtime or I/O lifetime. */
export type InstalledPluginProjectMediaInputToolsConfig = Readonly<{
  version: "crewon.project-media-input-tools.v1";
  createInputs(
    input: Readonly<{ store: SqliteRunStore | PostgresDomainStore }>,
  ): ProjectMediaInputApplicationService;
  authorization: CreativeProjectAuthorizationPort;
  authorizeService(
    admission: PluginTaskAdmission,
    signal: AbortSignal,
  ): Promise<void>;
}>;
export type InstalledPluginProjectMediaInputToolsDependencies = Pick<
  ProjectMediaInputToolsServiceOwnerDependencies,
  | "inputs"
  | "stages"
  | "conversations"
  | "runs"
  | "installations"
  | "authorization"
  | "resolveActor"
> &
  Readonly<{
    authorizeService: InstalledPluginProjectMediaInputToolsConfig["authorizeService"];
  }>;

export function captureInstalledPluginProjectMediaInputToolsConfig(
  input: InstalledPluginProjectMediaInputToolsConfig,
): InstalledPluginProjectMediaInputToolsConfig {
  const v = materialPreparationFields(input, [
    "version",
    "createInputs",
    "authorization",
    "authorizeService",
  ]);
  if (v.version !== "crewon.project-media-input-tools.v1")
    throw new Error("installed_plugin_media_input_configuration_invalid");
  const service = projectMediaInputBound<
    InstalledPluginProjectMediaInputToolsConfig["authorizeService"]
  >(input, "authorizeService");
  return Object.freeze({
    version: "crewon.project-media-input-tools.v1",
    createInputs: projectMediaInputBound<
      InstalledPluginProjectMediaInputToolsConfig["createInputs"]
    >(input, "createInputs"),
    authorization: Object.freeze({
      authorize: projectMediaInputBound<
        CreativeProjectAuthorizationPort["authorize"]
      >(v.authorization, "authorize"),
    }),
    authorizeService: async (admission, signal) => {
      if ((await service(admission, signal)) !== undefined)
        throw new Error("installed_plugin_media_input_service_denied");
    },
  });
}

export function composeInstalledPluginProjectMediaInputTools(
  input: Readonly<{
    store: SqliteRunStore | PostgresDomainStore;
    config: InstalledPluginProjectMediaInputToolsConfig;
    resolveActor: InstalledPluginRunContextDependencies["resolveActor"];
  }>,
): InstalledPluginProjectMediaInputToolsDependencies {
  const config = captureInstalledPluginProjectMediaInputToolsConfig(
      input.config,
    ),
    inputs = config.createInputs(Object.freeze({ store: input.store }));
  if (
    !(inputs instanceof ProjectMediaInputApplicationService) ||
    types.isProxy(inputs)
  )
    throw new Error("installed_plugin_media_input_service_invalid");
  return Object.freeze({
    inputs,
    stages: input.store.projectMediaInputStageStore(),
    conversations: input.store.projectConversationStore(),
    runs: input.store,
    installations: input.store.pluginInstallationStore(),
    authorization: config.authorization,
    resolveActor: input.resolveActor,
    authorizeService: config.authorizeService,
  });
}
