import type { ControlApiClient } from "@crewon/control-client";
import type { ProjectGenerationHostContext } from "@crewon/contracts/plugins";
import type { ControlThreadRuntime } from "../control-runtime/controlThreadRuntime";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";
import type { InstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";

export type InstalledPluginGenerationPorts = Readonly<{
  client: Pick<ControlApiClient, "getThread" | "createThread"> & {
    creativeProjects: Pick<
      ControlApiClient["creativeProjects"],
      "getConceptGeneration"
    >;
  };
  runtime: Pick<ControlThreadRuntime, "adoptExtensionTask">;
  journal: InstalledPluginGenerationJournal;
  /** Captured account/session check, independent of runtime reconnects. */
  assertSessionCurrent(): void;
  onOpenTask(threadId: string): void;
}>;

export type InstalledPluginGenerationContextInput = Readonly<{
  ports: InstalledPluginGenerationPorts | null;
  module: ControlPluginUiModule;
  active: boolean;
  selectedThreadId: string | null;
}>;

export type InstalledPluginGenerationContextState = Readonly<{
  context: ProjectGenerationHostContext;
  error: string | null;
  prepareThread(): void;
  refresh(): void;
  openTask(): Promise<void>;
  canOpenTask: boolean;
}>;
