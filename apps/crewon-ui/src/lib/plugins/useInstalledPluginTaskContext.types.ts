import type { ExtensionTaskView } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import type { PluginJsonValue } from "@crewon/plugin-sdk/contracts";
import type { ControlThreadRuntime } from "../control-runtime/controlThreadRuntime";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";
import type { InstalledPluginTaskReceiptEvent } from "./installedPluginTaskReceipt";

export type InstalledPluginTaskReceiptSource = Readonly<{
  subscribe(
    listener: (event: InstalledPluginTaskReceiptEvent) => void,
  ): () => void;
  snapshot(): readonly InstalledPluginTaskReceiptEvent[];
}>;
export type InstalledPluginTaskPorts = Readonly<{
  client: Pick<
    ControlApiClient,
    "getThread" | "createThread" | "listThreadRuns" | "getExtensionTask"
  >;
  runtime: Pick<ControlThreadRuntime, "adoptExtensionTask">;
  receiptSource: InstalledPluginTaskReceiptSource;
  /** Checks the captured host session; the callback never supplies HTTP authority. */
  assertSessionCurrent(): void;
}>;
export type InstalledPluginTaskThread = Readonly<{
  threadId: string;
  revision: number;
  provisional: boolean;
}>;
export type InstalledPluginTaskSource = Readonly<{
  sourceRunId: string;
  operationId: string;
}>;
export type InstalledPluginTaskContextInput = Readonly<{
  ports: InstalledPluginTaskPorts | null;
  module: ControlPluginUiModule;
  active: boolean;
  selectedThreadId: string | null;
  runIds: readonly string[];
}>;
export type InstalledPluginTaskContextState = Readonly<{
  phase: "idle" | "loading" | "ready" | "preparing" | "uncertain" | "error";
  error: string | null;
  thread: InstalledPluginTaskThread | null;
  tasks: readonly ExtensionTaskView[];
  source: InstalledPluginTaskSource | null;
  /** Bounded public projection, never an actor, profile, client or capability. */
  data: PluginJsonValue;
  prepareThread(): void;
  refresh(): void;
  selectSource(source: InstalledPluginTaskSource | null): void;
}>;
