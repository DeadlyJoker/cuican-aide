import type { ExternalOperationStore } from "@crewon/application";
import type {
  ExtensionConfiguration,
  ExtensionExecutionTarget,
  PluginProfileScope,
} from "@crewon/domain";
import type { PluginExecutionServiceRequirement } from "@crewon/plugin-sdk/node";
import type { InstalledPluginBusinessRegistration } from "./installed-plugin-business-registration.ts";
import type { InstalledPluginExecutionIoConfig } from "./installed-plugin-execution-io-config.ts";

/** Host metadata from the actual installed package and attested materialization; no synthetic Run or command. */
export type InstalledPluginExecutionReadinessMetadata = Readonly<{
  identity: InstalledPluginBusinessRegistration["identity"];
  scope: PluginProfileScope;
  configuration: ExtensionConfiguration;
  target: ExtensionExecutionTarget;
  purpose: "submit" | "observe";
}>;
export type InstalledPluginExecutionReadinessInput = Readonly<{
  metadata: InstalledPluginExecutionReadinessMetadata;
  requiredServices: readonly PluginExecutionServiceRequirement[];
}>;
/** Borrowed by readiness hosts. Current caller/package authority remains the host's responsibility. */
export interface InstalledPluginExecutionReadinessPort {
  assertReady(
    input: InstalledPluginExecutionReadinessInput,
    signal: AbortSignal,
  ): Promise<void>;
}
export type InstalledPluginExecutionReadinessDependencies = Readonly<{
  configuration?: InstalledPluginExecutionIoConfig;
  /** The actual deployment-owned store. Readiness never creates a fake locator or operation. */
  operations?: ExternalOperationStore;
  maximumChecks?: number;
  timeoutMs?: number;
}>;
