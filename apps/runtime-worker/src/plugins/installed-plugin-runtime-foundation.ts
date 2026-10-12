import type {
  ActorContext,
  ProjectFoundationRunAdmissionStore,
} from "@crewon/application";
import { issuePluginProjectRuntimeObservation } from "@crewon/application/host-project-workspaces";
import {
  extensionCanonicalJson,
  type ExtensionRunBinding,
  type PluginTaskAdmission,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
import { readFoundationForVerifiedRuntimeContext } from "./project-foundation-runtime-scope.ts";
import { InstalledPluginRunContextError } from "./installed-plugin-run-context-error.ts";

export function captureRuntimeProjectOwnership(
  input: object,
): "plugin-project-v1" | undefined {
  const d = Object.getOwnPropertyDescriptor(input, "projectOwnership");
  if (d === undefined && !("projectOwnership" in input)) return undefined;
  if (
    !d?.enumerable ||
    !Object.hasOwn(d, "value") ||
    d.value !== "plugin-project-v1"
  )
    throw new InstalledPluginRunContextError(
      "installed_plugin_project_ownership_invalid",
    );
  return d.value;
}

/** Called only after original context authorization; lifetime ends before metadata is published. */
export async function readInstalledRuntimeFoundation(
  input: Readonly<{
    foundations: ProjectFoundationRunAdmissionStore | undefined;
    ownership: "plugin-project-v1" | undefined;
    actor: ActorContext;
    admission: PluginTaskAdmission;
    binding: ExtensionRunBinding;
    stageAdmission: ProjectStageRunAdmission | null;
    requestKind: "direct" | "query";
    purpose: "submit" | "observe";
    signal: AbortSignal;
    authorize(): Promise<ActorContext>;
  }>,
) {
  const scoped =
    input.ownership !== undefined &&
    input.requestKind === "direct" &&
    input.stageAdmission?.stage.kind === "discussion";
  if (!scoped) return readFoundationForVerifiedRuntimeContext(input);
  if (!input.foundations?.loadRuntimeFoundationRunAdmission)
    throw new InstalledPluginRunContextError(
      "installed_plugin_runtime_foundation_reader_unavailable",
    );
  let active = true;
  try {
    const observation = await issuePluginProjectRuntimeObservation({
      version: "crewon.plugin-project-runtime-observation.v1",
      actor: input.actor,
      admission: input.admission,
      binding: input.binding,
      stage: input.stageAdmission!,
      purpose: input.purpose,
      async assertCurrent() {
        const actor = await input.authorize();
        if (
          extensionCanonicalJson(actor) !== extensionCanonicalJson(input.actor)
        )
          throw new InstalledPluginRunContextError(
            "installed_plugin_execution_identity_unavailable",
          );
      },
      assertActive() {
        input.signal.throwIfAborted();
        if (!active)
          throw new InstalledPluginRunContextError(
            "installed_plugin_runtime_foundation_lifetime_ended",
          );
      },
    });
    return await readFoundationForVerifiedRuntimeContext({
      ...input,
      observation,
    });
  } finally {
    active = false;
  }
}
