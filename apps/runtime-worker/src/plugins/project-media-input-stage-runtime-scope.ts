import { createHash } from "node:crypto";
import {
  extensionCanonicalJson,
  parseProjectMediaInputStageRunAdmission,
  type ExtensionRunBinding,
  type PluginTaskAdmission,
  type ProjectMediaInputStageRunAdmission,
} from "@crewon/domain";
import type { ProjectMediaInputStageStore } from "@crewon/application";

/** A real required marker and its exact immutable record, never a prompt hint or old text scope. */
export async function readProjectMediaInputStageRuntimeScope(
  input: Readonly<{
    stages: Pick<
      ProjectMediaInputStageStore,
      "loadMediaInputStageAdmission" | "readRequiredMediaInputStageDigest"
    >;
    admission: PluginTaskAdmission;
    binding: ExtensionRunBinding;
    signal: AbortSignal;
  }>,
): Promise<ProjectMediaInputStageRunAdmission | null> {
  const locator = {
    tenantId: input.binding.tenantId,
    spaceId: input.binding.spaceId,
    runId: input.binding.runId,
  };
  input.signal.throwIfAborted();
  const required =
      await input.stages.readRequiredMediaInputStageDigest(locator),
    actual = await input.stages.loadMediaInputStageAdmission(locator);
  input.signal.throwIfAborted();
  if (actual === null) {
    if (required !== null) denied();
    return null;
  }
  const d = {
    sha256: (text: string) =>
      `sha256:${createHash("sha256").update(text).digest("hex")}`,
  };
  const stage = parseProjectMediaInputStageRunAdmission(actual, d),
    a = input.admission,
    b = input.binding;
  if (
    required !== stage.contentDigest ||
    stage.stage.configurationRevision !== b.configurationRevision ||
    stage.runId !== b.runId ||
    stage.threadId !== b.threadId ||
    stage.extensionBindingDigest !== b.bindingDigest ||
    stage.userContentDigest !== b.inputDigest ||
    stage.requestDigest !== a.requestDigest ||
    stage.idempotencyKey !== a.idempotencyKey ||
    stage.pluginTaskAdmissionDigest !== d.sha256(extensionCanonicalJson(a)) ||
    b.source !== null ||
    a.action !== "project.execute" ||
    (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
      (key) => stage.actor[key] !== a[key],
    ) ||
    (
      [
        "tenantId",
        "spaceId",
        "profileId",
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
        "selectionRevision",
      ] as const
    ).some((key) => stage.installation[key] !== a[key])
  )
    denied();
  return stage;
}
function denied(): never {
  throw new Error("project_media_input_stage_admission_invalid");
}
