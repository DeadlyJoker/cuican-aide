import type {
  ApplicationClock,
  ApplicationIdGenerator,
  AuthorizationPort,
  ContentDigester,
  ExtensionCreditQuotePort,
  PluginTaskUnmeteredAuthorityPort,
  PluginInstallationHostProfilePort,
  PluginUiAuthorizationPort,
  ExtensionConfigurationApplicationService,
  ExtensionTaskApplicationService,
  ExtensionReadApplicationService,
  ProjectGenerationReadApplicationService,
} from "@crewon/application";
import type { SqliteRunStore, PostgresDomainStore } from "@crewon/store";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import type { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import type {
  InstalledPluginTaskActionOwner,
  InstalledPluginTaskActionOwnerDependencies,
} from "./installed-plugin-task-action-owner.ts";
import type { InstalledPluginProjectGenerationOwner } from "./installed-plugin-project-generation-owner.ts";
import type { InstalledPluginProjectQueryOwner } from "./installed-plugin-project-query-owner.ts";
import type { InstalledPluginProjectHistoricalQueryOwner } from "./installed-plugin-project-historical-query-owner.ts";
import type { InstalledProjectMediaInputRuntime } from "./installed-project-media-input-runtime.ts";
import type { InstalledProjectMediaInputConfiguration } from "./installed-project-media-input-configuration.ts";
import type { InstalledPluginTaskCompositionPolicy } from "./installed-plugin-task-composition-policy.ts";
import type { DesktopPluginTaskServiceBinding } from "./desktop-plugin-task-service-binding.ts";
import type { PreparedCreativeProjects } from "./creative-project-composition.ts";
import type { ProjectHistoricalQueryPublication } from "@crewon/domain";

export type InstalledPluginTaskRuntimeCore = Readonly<{
  owner: InstalledPluginTaskActionOwner;
  projectGenerations?: InstalledPluginProjectGenerationOwner;
  projectQueries?: InstalledPluginProjectQueryOwner;
  historicalQueries?: InstalledPluginProjectHistoricalQueryOwner;
  projectGenerationReads?: ProjectGenerationReadApplicationService;
  projectMediaInputs?: InstalledProjectMediaInputRuntime;
  requests: InstalledPluginRequestOwner;
  extensions: ExtensionConfigurationApplicationService;
  extensionTasks: ExtensionTaskApplicationService;
  modelSelection?: import("@crewon/application").PluginTaskModelSelectionPort;
  extensionReads: ExtensionReadApplicationService;
  close(): Promise<void>;
}>;

export type InstalledPluginTaskRuntimeCoreInput = Readonly<{
  store: SqliteRunStore | PostgresDomainStore;
  requests: InstalledPluginRequestOwner;
  installRoot: string;
  maximumPackages: number;
  publications: readonly Readonly<{
    pluginId: string;
    packageDigest: string;
  }>[];
  profiles: PluginInstallationHostProfilePort;
  businessAuthorization: AuthorizationPort;
  uiAuthorization: PluginUiAuthorizationPort;
  authorizePackage: InstalledPluginTaskActionOwnerDependencies["authorizePackage"];
  creditQuotes?: ExtensionCreditQuotePort;
  unmeteredTasks?: PluginTaskUnmeteredAuthorityPort;
  modelSelection?: import("@crewon/application").PluginTaskModelSelectionPort;
  compositionPolicy?: InstalledPluginTaskCompositionPolicy;
  sharedBinding?: DesktopPluginTaskServiceBinding;
  clock: ApplicationClock;
  ids: ApplicationIdGenerator;
  digester: ContentDigester;
  creativeProjects?: PreparedCreativeProjects;
  projectMediaInputs?: InstalledProjectMediaInputConfiguration;
  /** Prepares only the original admission adapter. Does not authorize material I/O or expose a UI action. */
  projectMediaGenerationStorage?: Readonly<{
    version: "crewon.project-media-generation-storage.v1";
  }>;
  metadataHostUiServices?: PluginUiHostServiceAvailabilityPort;
  assertHistoricalTarget?(publication: ProjectHistoricalQueryPublication): void;
}>;
