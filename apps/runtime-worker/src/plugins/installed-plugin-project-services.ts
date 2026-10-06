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

export type InstalledPluginProjectServices = Readonly<{
  hostServices(): readonly PluginHostService[];
  withInvocation<T>(
    invocation: ProjectToolsDispatchInvocation,
    delegate: () => Promise<T>,
  ): Promise<T>;
  canRetire(): boolean;
  close(): Promise<void>;
}>;

/** Media-input tasks compose the shared readers under their independent stage guard. */
export function createInstalledPluginProjectServices(
  input: Parameters<typeof createInstalledPluginProjectToolsOwner>[0] &
    Readonly<{
      mediaInputDependencies:
        | InstalledPluginProjectMediaInputToolsDependencies
        | undefined;
      mediaInputStage: ProjectMediaInputStageRunAdmission | null;
    }>,
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
