import type { PluginHostService } from "@crewon/plugin-host";
import type { ProjectMediaInputStageRunAdmission } from "@crewon/domain";
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

/** A media-input task gets its independently scoped service, never the unrestricted text/task owner. */
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
    return new ProjectMediaInputToolsServiceOwner({
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
