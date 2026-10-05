import type {
  PluginExecutionPackage,
  PluginExecutionPackageBorrow,
} from "@crewon/plugin-host";
import type { ToolDefinition, ToolRuntimePort } from "@crewon/tool-broker";
import type { PluginProfileScope, PluginTaskAdmission } from "@crewon/domain";
import type { RuntimeExtensionMaterialization } from "../extensions/extension-runtime-proof.ts";
import type { InstalledPluginRunSnapshot } from "./installed-plugin-run-context.ts";
import {
  cleanupMethods,
  fail,
} from "./installed-plugin-runtime-resolver-package.ts";

type ServiceLifetime = Pick<
  import("./project-tools-service-owner.ts").ProjectToolsServiceOwner,
  "canRetire" | "close"
>;
export type InstalledPluginRuntimePrepared = Readonly<{
  admission: PluginTaskAdmission;
  proof: RuntimeExtensionMaterialization;
  snapshot: InstalledPluginRunSnapshot;
  scope: PluginProfileScope;
  names: readonly string[];
  definitions: readonly ToolDefinition[];
  policyContext: Readonly<{
    sandboxMode: "workspace-write" | "danger-full-access";
  }>;
  key: string;
}>;
export type InstalledPluginRuntimeResidentLifetime = {
  package: PluginExecutionPackage;
  borrow: PluginExecutionPackageBorrow | null;
  hasRuntime: boolean;
  cleanup: ReturnType<typeof cleanupMethods>;
  adapter: ToolRuntimePort | null;
  runtimeClosed: boolean;
  io: ServiceLifetime | null;
  projectTools: ServiceLifetime | null;
};

/** Retirement requires positive evidence from the runtime and every independent service owner. */
export function canRetireInstalledPluginRuntimeResident(
  resident: InstalledPluginRuntimeResidentLifetime,
): boolean {
  const cleanup = resident.adapter ?? resident.cleanup;
  return (
    cleanup.canRetire?.() === true &&
    (resident.io === null || resident.io.canRetire()) &&
    (resident.projectTools === null || resident.projectTools.canRetire())
  );
}

/** Withdraw all authorities before physically joining them, then release the immutable package borrow. */
export async function closeInstalledPluginRuntimeResident(
  resident: InstalledPluginRuntimeResidentLifetime,
  mode: "idle" | "explicit",
): Promise<void> {
  if (!resident.runtimeClosed) {
    const cleanup = resident.adapter ?? resident.cleanup;
    if (mode === "idle" && !canRetireInstalledPluginRuntimeResident(resident))
      fail("installed_plugin_runtime_retirement_unproven");
    const ioClose = resident.io?.close(),
      projectClose = resident.projectTools?.close();
    const runtimeClose = resident.hasRuntime
      ? (async () => {
          if (cleanup.close !== undefined) await cleanup.close();
          else if (cleanup.canRetire?.() !== true)
            fail("installed_plugin_runtime_cleanup_unavailable");
        })()
      : undefined;
    const closed = await Promise.allSettled([
      ioClose,
      projectClose,
      runtimeClose,
    ]);
    const failures = closed
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length)
      throw new AggregateError(
        failures,
        "installed_plugin_runtime_cleanup_failed",
      );
    resident.runtimeClosed = true;
  }
  resident.borrow?.release();
  resident.borrow = null;
  await resident.package.close();
}
