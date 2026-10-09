import type { PluginHostService } from "@crewon/plugin-host";
import {
  extensionToolName,
  type ProjectMediaInputStageRunAdmission,
} from "@crewon/domain";
import {
  assertInstalledPluginProjectToolsExternalCurrent,
  createInstalledPluginProjectToolsOwner,
} from "./installed-plugin-project-tools.ts";
import type { InstalledPluginProjectMediaInputToolsDependencies } from "./installed-plugin-project-media-input-tools.ts";
import { ProjectMediaInputToolsServiceOwner } from "./project-media-input-tools-service-owner.ts";
import type { ProjectToolsDispatchInvocation } from "./project-tools-service-owner.ts";
import { installedPluginToolOperationPurpose } from "./installed-plugin-run-runtime.ts";
import {
  CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE,
  PROJECT_FOUNDATION_TOOL_OPERATION_IDS,
} from "@crewon/contracts/project-foundation-tools";
import type { ProjectFoundationRunAdmission } from "@crewon/domain";
import {
  createInstalledPluginProjectFoundationToolsOwner,
  type InstalledPluginProjectFoundationToolsDependencies,
} from "./installed-plugin-project-foundation-tools.ts";
import {
  createInstalledPluginProjectOutlineToolsOwner,
  type InstalledPluginProjectOutlineToolsDependencies,
} from "./installed-plugin-project-outline-tools.ts";
import { CREWON_PROJECT_OUTLINE_TOOLS_SERVICE } from "@crewon/contracts/project-outline-tools";

export type InstalledPluginProjectServices = Readonly<{
  hostServices(): readonly PluginHostService[];
  withInvocation<T>(
    invocation: ProjectToolsDispatchInvocation,
    delegate: () => Promise<T>,
  ): Promise<T>;
  canRetire(): boolean;
  close(): Promise<void>;
}>;

/** Independent Foundation commands never enter the legacy stage allowedOperations guard. */
export function createInstalledPluginProjectServices(
  input: Parameters<typeof createInstalledPluginProjectToolsOwner>[0] &
    Readonly<{
      mediaInputDependencies:
        | InstalledPluginProjectMediaInputToolsDependencies
        | undefined;
      mediaInputStage: ProjectMediaInputStageRunAdmission | null;
      foundationDependencies?: InstalledPluginProjectFoundationToolsDependencies;
      foundationAdmission?: ProjectFoundationRunAdmission | null;
      outlineDependencies?: InstalledPluginProjectOutlineToolsDependencies;
    }>,
): InstalledPluginProjectServices | null {
  const declared = input.tools.some(
    (tool) =>
      tool.adapterId === CREWON_PROJECT_FOUNDATION_TOOLS_SERVICE &&
      PROJECT_FOUNDATION_TOOL_OPERATION_IDS.some(
        (operation) => operation === tool.operationId,
      ),
  );
  const outlineDeclared = input.tools.some(
    (tool) =>
      tool.adapterId === CREWON_PROJECT_OUTLINE_TOOLS_SERVICE &&
      tool.operationId === "outline_change",
  );
  if (!declared && !outlineDeclared) return createLegacyProjectServices(input);
  const outline = outlineDeclared
    ? createInstalledPluginProjectOutlineToolsOwner({
        ...input,
        dependencies: input.outlineDependencies,
        stageAdmission: input.stageAdmission ?? null,
      })
    : null;
  const foundationAdmission = input.foundationAdmission ?? null;
  const foundation =
    !declared || foundationAdmission === null
      ? null
      : createInstalledPluginProjectFoundationToolsOwner({
          ...input,
          dependencies: input.foundationDependencies,
          stageAdmission: input.stageAdmission ?? null,
          foundationAdmission,
        });
  const legacy =
    input.dependencies === undefined &&
    (foundation !== null || outline !== null)
      ? null
      : createLegacyProjectServices(input);
  return Object.freeze({
    hostServices: () => [
      ...(legacy?.hostServices() ?? []),
      ...(foundation === null ? [] : [foundation.hostService()]),
      ...(outline === null ? [] : [outline.hostService()]),
    ],
    withInvocation: <T>(
      invocation: ProjectToolsDispatchInvocation,
      delegate: () => Promise<T>,
    ) => {
      if (
        outlineDeclared &&
        ["outline_change", "outline_context"].some(
          (operation) =>
            invocation.command.name ===
            extensionToolName(input.admission.pluginId, operation),
        )
      ) {
        if (outline === null)
          throw new Error(
            "installed_plugin_project_outline_services_unavailable",
          );
        return outline.withInvocation(invocation, delegate);
      }
      const isFoundation = PROJECT_FOUNDATION_TOOL_OPERATION_IDS.some(
        (operation) =>
          invocation.command.name ===
          extensionToolName(input.admission.pluginId, operation),
      );
      if (isFoundation) {
        if (foundation === null)
          throw new Error(
            "installed_plugin_project_foundation_services_unavailable",
          );
        return foundation.withInvocation(invocation, delegate);
      }
      return legacy === null
        ? delegate()
        : legacy.withInvocation(invocation, delegate);
    },
    canRetire: () =>
      (outline?.canRetire() ?? true) &&
      (foundation?.canRetire() ?? true) &&
      (legacy?.canRetire() ?? true),
    close: async () => {
      const settled = await Promise.allSettled([
        foundation?.close(),
        outline?.close(),
        legacy?.close(),
      ]);
      const failures = settled.filter(
        (item): item is PromiseRejectedResult => item.status === "rejected",
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((item) => item.reason),
          "installed_plugin_project_services_close_failed",
        );
    },
  });
}

/** Media-input tasks compose the shared readers under their independent stage guard. */
function createLegacyProjectServices(
  input: Parameters<typeof createInstalledPluginProjectServices>[0],
): InstalledPluginProjectServices | null {
  const stage = input.mediaInputStage;
  if (stage !== null) {
    const d = input.mediaInputDependencies;
    if (
      !d ||
      input.context.run.source !== null ||
      input.stageAdmission ||
      input.assetStageAdmission ||
      input.planAdmission
    )
      throw new Error(
        "installed_plugin_media_input_stage_services_unavailable",
      );
    const media = new ProjectMediaInputToolsServiceOwner({
      ...d,
      context: input.context,
      admission: input.admission,
      tools: input.tools,
      mediaInputStageAdmission: stage,
      authorizeCurrent: input.authorizeCurrent,
      authorizeMediaInputService: (signal) =>
        d.authorizeService(input.admission, signal),
      authorizeTransaction: async (operation) => {
        await d.authorizeService(input.admission, operation.signal);
        const candidate = input.candidate();
        if (!candidate)
          throw new Error("installed_plugin_runtime_candidate_missing");
        // This callback runs inside the native write transaction. Never borrow another store connection here.
        await assertInstalledPluginProjectToolsExternalCurrent({
          admission: input.admission,
          candidate,
          scope: input.scope,
          purpose: installedPluginToolOperationPurpose(operation),
          signal: operation.signal,
          resolveActor: d.resolveActor,
          authorizePackage: input.authorizePackage,
          assertActive: input.assertActive,
        });
      },
      assertActive: input.assertActive,
    });
    const reads = createInstalledPluginProjectToolsOwner({
      ...input,
      mediaInputStageAdmission: stage,
    });
    if (reads === null) return media;
    return Object.freeze({
      hostServices: () => [
        ...media.hostServices(),
        reads.hostService(),
        reads.contextHostService(),
        ...reads.assetHostServices(),
      ],
      withInvocation: <T>(
        invocation: ProjectToolsDispatchInvocation,
        delegate: () => Promise<T>,
      ) =>
        media.withInvocation(invocation, () =>
          invocation.command.name ===
          extensionToolName(input.admission.pluginId, "media_input")
            ? delegate()
            : reads.withInvocation(invocation, delegate),
        ),
      canRetire: () => media.canRetire() && reads.canRetire(),
      close: async () => {
        const results = await Promise.allSettled([
          media.close(),
          reads.close(),
        ]);
        const failures = results.filter(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        );
        if (failures.length)
          throw new AggregateError(
            failures.map((r) => r.reason),
            "installed_plugin_media_input_services_close_failed",
          );
      },
    });
  }
  const owner = createInstalledPluginProjectToolsOwner(input);
  if (!owner) {
    if (
      input.stageAdmission ||
      input.assetStageAdmission ||
      input.planAdmission
    )
      throw new Error("installed_plugin_project_stage_services_unavailable");
    return null;
  }
  return Object.freeze({
    hostServices: () => [
      owner.hostService(),
      owner.contextHostService(),
      ...owner.assetHostServices(),
    ],
    withInvocation: owner.withInvocation.bind(owner),
    canRetire: owner.canRetire.bind(owner),
    close: owner.close.bind(owner),
  });
}
