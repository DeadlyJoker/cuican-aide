import type {
  ActorContext,
  ExtensionStore,
  ProjectAssetStageStore,
  ExtensionMutationReceipt,
} from "@crewon/application";
import { issueProjectAssetRuntimeReadObservation } from "@crewon/application/host-project-workspaces";
import {
  extensionCanonicalJson,
  type PluginTaskAdmission,
  type ExtensionRunBinding,
  type RunState,
} from "@crewon/domain";
import { readProjectAssetStageRuntimeScope } from "./project-asset-stage-runtime-scope.ts";

/** Original installed startup only. SQL verifies a pending receipt locator before
 * archive metadata is returned; this scope is never a Tool or mutation authority.
 */
export async function readInstalledRuntimeAssetMetadata(
  input: Readonly<{
    ownership: "plugin-project-v1" | undefined;
    extensions: ExtensionStore;
    stages:
      | Pick<
          ProjectAssetStageStore,
          "loadAssetStageAdmission" | "readRequiredAssetStageDigest"
        >
      | undefined;
    actor: ActorContext | undefined;
    admission: PluginTaskAdmission;
    binding: ExtensionRunBinding;
    run: RunState;
    receipt: ExtensionMutationReceipt;
    purpose: "submit" | "observe";
    requestKind: "direct" | "query";
    signal: AbortSignal;
    authorize(): Promise<ActorContext>;
  }>,
) {
  let active = true;
  const scoped =
    input.ownership !== undefined &&
    input.requestKind === "direct" &&
    input.admission.action === "project.execute" &&
    input.stages !== undefined;
  try {
    const observation = scoped
      ? await issueProjectAssetRuntimeReadObservation({
          version: "crewon.project-asset-runtime-read-observation.v1",
          actor: input.actor!,
          admission: input.admission,
          binding: input.binding,
          run: input.run,
          receipt: input.receipt,
          purpose: input.purpose,
          async assertCurrent() {
            const actor = await input.authorize();
            if (
              extensionCanonicalJson(actor) !==
              extensionCanonicalJson(input.actor)
            )
              throw Error("installed_plugin_runtime_asset_identity_changed");
          },
          assertActive() {
            input.signal.throwIfAborted();
            if (!active)
              throw Error("installed_plugin_runtime_asset_lifetime_ended");
          },
        })
      : undefined;
    const rawReceipt = await input.extensions.loadExtensionTurnReceipt(
      { ...input.binding, receipt: input.receipt },
      observation === undefined
        ? undefined
        : { projectAssetRuntimeReadObservation: observation },
    );
    input.signal.throwIfAborted();
    const projectAssetStage =
      input.stages === undefined
        ? null
        : await readProjectAssetStageRuntimeScope({
            stages: input.stages,
            admission: input.admission,
            binding: input.binding,
            signal: input.signal,
            ...(observation === undefined ? {} : { observation }),
          });
    return { rawReceipt, projectAssetStage };
  } finally {
    active = false;
  }
}
