import { extensionToolName, type ExtensionManifest } from "@crewon/domain";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import type { ExternalOperationStore } from "@crewon/application";
import { ProjectMediaExecutionBoundary } from "../project-media-execution-boundary.ts";
import { installedPluginToolOperationPurpose } from "./installed-plugin-run-runtime.ts";
import { installedPluginHasExternalOperation } from "./installed-plugin-execution-io-config.ts";
import { fail } from "./installed-plugin-runtime-resolver-package.ts";
import type { PluginToolRuntimeAdapterInput } from "./plugin-tool-runtime-adapter.ts";

type Operation = Parameters<PluginToolRuntimeAdapterInput["authorize"]>[0];
export async function authorizeInstalledPluginRuntimeTool(
  input: Readonly<{
    operation: Operation;
    context: PluginToolRuntimeContext;
    tools: ExtensionManifest["tools"];
    approvalRequirement: "none" | "perAction";
    operations: ExternalOperationStore | undefined;
    media: ProjectMediaExecutionBoundary | null;
    authorize(
      purpose: "submit" | "observe",
      signal: AbortSignal,
    ): Promise<void>;
  }>,
): Promise<void> {
  const operation = input.operation,
    declared = input.tools.find(
      (tool) =>
        extensionToolName(input.context.identity.pluginId, tool.operationId) ===
        operation.command.name,
    ),
    intent = operation.command.actionIntent;
  if (
    !declared ||
    intent.effect !== declared.effect ||
    intent.recovery !== declared.recovery ||
    intent.capability !== declared.capability ||
    intent.approvalRequirement !==
      (declared.effect === "mutation" ? input.approvalRequirement : "none") ||
    (input.context.run.source !== null && declared.effect !== "readOnly")
  )
    fail("installed_plugin_runtime_policy_mismatch");
  let purpose = installedPluginToolOperationPurpose(operation);
  if (
    purpose === "submit" &&
    operation.method === "execute" &&
    input.operations &&
    input.context.run.source === null
  ) {
    const observed = input.media
      ? intent.capability === "extension.image.generate" &&
        (await ProjectMediaExecutionBoundary.prototype.hasOperation.call(
          input.media,
          operation.signal,
        ))
      : await installedPluginHasExternalOperation({
          context: input.context,
          command: operation.command,
          operations: input.operations,
          signal: operation.signal,
        });
    if (observed) purpose = "observe";
  }
  await input.authorize(purpose, operation.signal);
}
