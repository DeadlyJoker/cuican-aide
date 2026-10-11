import type { ThreadApplicationService } from "@crewon/application";
import type { RunLifecycleEvent } from "@crewon/domain";
import type {
  PluginInstallationControlService,
  PluginSourceControlService,
  PluginUiControlService,
} from "./plugin-control-route.ts";
import type { DesktopPluginInstallationRuntime } from "./desktop-plugin-installation-runtime.ts";
import type { DesktopPluginConfigurationRuntime } from "./desktop-plugin-configuration-runtime.ts";
import type { DesktopPluginTaskServiceBinding } from "./desktop-plugin-task-service-binding.ts";
import type { InstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import type { InstalledProjectMediaGenerationRuntime } from "./installed-project-media-generation-runtime.ts";
import type { InstalledProjectMediaResultRuntime } from "./installed-project-media-result-runtime.ts";
import type { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";
import type { ProjectMediaInputStageControlOwner } from "./project-media-input-stage-control-owner.ts";
import type { ProjectAssetStageControlOwner } from "./project-asset-stage-control-owner.ts";

export type DesktopPluginRuntime = Readonly<{
  /** Trusted in-process deployment wiring only; not exposed by HTTP or UI props. */
  taskHostServices?: DesktopPluginTaskServiceBinding["catalog"]["registrations"];
  assertTaskHostServicesOwner?: DesktopPluginTaskServiceBinding["assertWorkerOwner"];
  installation: PluginInstallationControlService;
  compositionState: DesktopPluginInstallationRuntime["compositionState"];
  compositionStatus: DesktopPluginInstallationRuntime["compositionStatus"];
  sources: PluginSourceControlService;
  ui: PluginUiControlService;
  configuration: DesktopPluginConfigurationRuntime;
  tasks?: InstalledPluginTaskRuntimeCore;
  projectMediaGenerations?: InstalledProjectMediaGenerationRuntime;
  projectMediaResults?: InstalledProjectMediaResultRuntime;
  bindProjectConversations?(
    threads: ThreadApplicationService,
  ): ProjectConversationControlOwner | undefined;
  projectMediaInputStages?(): ProjectMediaInputStageControlOwner | undefined;
  projectAssetStages?(): ProjectAssetStageControlOwner | undefined;
  startProjectTextPlans?(): void;
  consumeProjectTextPlanRunEvents?(
    events: readonly RunLifecycleEvent[],
  ): Promise<void>;
  close(): Promise<void>;
}>;
