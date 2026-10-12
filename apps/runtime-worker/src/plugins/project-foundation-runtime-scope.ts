import type { PluginProjectRuntimeObservation } from "@crewon/application/host-project-workspaces";
import type { ProjectFoundationRunAdmissionStore } from "@crewon/application";
import {
  extensionCanonicalJson,
  parsePluginTaskAdmission,
  parseProjectFoundationRunAdmission,
  parseProjectStageRunAdmission,
  type ExtensionRunBinding,
  type PluginTaskAdmission,
  type ProjectFoundationRunAdmission,
  type ProjectStageRunAdmission,
} from "@crewon/domain";
import type { PluginToolRuntimeContext } from "@crewon/plugin-sdk/node";
import {
  foundationOwnerDenied,
  foundationOwnerDigester as sha,
} from "./project-foundation-owner-support.ts";

/** Exact attached facts for the original discussion Run; this function grants no dispatch. */
export function captureProjectFoundationRuntimeAdmission(
  input: Readonly<{
    foundationAdmission: ProjectFoundationRunAdmission;
    stageAdmission: ProjectStageRunAdmission;
    admission: PluginTaskAdmission;
    context: Pick<PluginToolRuntimeContext, "identity" | "scope" | "run">;
  }>,
): ProjectFoundationRunAdmission {
  const f = parseProjectFoundationRunAdmission(input.foundationAdmission, sha),
    s = parseProjectStageRunAdmission(input.stageAdmission, sha),
    a = parsePluginTaskAdmission(input.admission),
    c = input.context;
  if (
    c.run.source !== null ||
    a.action !== "project.execute" ||
    s.stage.kind !== "discussion" ||
    f.projectStageAdmissionDigest !== s.contentDigest ||
    f.extensionBindingDigest !== c.run.bindingDigest ||
    f.userContentDigest !== c.run.inputDigest ||
    f.runId !== c.run.runId ||
    f.threadId !== c.run.threadId ||
    f.pluginTaskAdmissionDigest !== sha.sha256(extensionCanonicalJson(a)) ||
    (
      [
        "runId",
        "threadId",
        "projectId",
        "bindingId",
        "bindingRevision",
        "workspaceId",
        "userContentDigest",
        "taskInputDigest",
        "pluginTaskAdmissionDigest",
        "extensionBindingDigest",
        "requestDigest",
        "idempotencyKey",
      ] as const
    ).some((key) => f[key] !== s[key]) ||
    (
      [
        "runId",
        "threadId",
        "requestDigest",
        "idempotencyKey",
        "extensionBindingDigest",
      ] as const
    ).some((key) => f[key] !== a[key]) ||
    (["tenantId", "spaceId", "principalId", "actorId"] as const).some(
      (key) => f.actor[key] !== s.actor[key] || f.actor[key] !== a[key],
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
    ).some(
      (key) =>
        f.installation[key] !== s.installation[key] ||
        f.installation[key] !== a[key],
    ) ||
    (["tenantId", "spaceId", "profileId"] as const).some(
      (key) => a[key] !== c.scope[key],
    ) ||
    (["pluginId", "version", "packageDigest"] as const).some(
      (key) => a[key] !== c.identity[key],
    )
  )
    foundationOwnerDenied();
  return f;
}

/** Read both real Store records. Neither an absent marker nor a caller supplied sidecar is enough. */
export async function readProjectFoundationRuntimeScope(
  input: Readonly<{
    foundations: ProjectFoundationRunAdmissionStore;
    admission: PluginTaskAdmission;
    binding: ExtensionRunBinding;
    stageAdmission: ProjectStageRunAdmission | null;
    signal: AbortSignal;
    observation?: PluginProjectRuntimeObservation;
  }>,
): Promise<ProjectFoundationRunAdmission | null> {
  input.signal.throwIfAborted();
  const locator = {
    tenantId: input.binding.tenantId,
    spaceId: input.binding.spaceId,
    runId: input.binding.runId,
  };
  const requiredLegacy =
    input.observation === undefined
      ? await input.foundations.readRequiredFoundationDigest(locator)
      : null;
  if (
    input.observation !== undefined &&
    !input.foundations.loadRuntimeFoundationRunAdmission
  )
    throw new Error("installed_plugin_runtime_foundation_reader_unavailable");
  const raw =
    input.observation === undefined
      ? await input.foundations.loadFoundationRunAdmission(locator)
      : await input.foundations.loadRuntimeFoundationRunAdmission!(
          input.observation,
        );
  const required =
    input.observation === undefined
      ? requiredLegacy
      : (raw?.contentDigest ?? null);
  input.signal.throwIfAborted();
  if (raw === null) {
    if (required !== null)
      throw new Error("installed_plugin_project_foundation_scope_missing");
    return null;
  }
  if (input.stageAdmission === null)
    throw new Error("installed_plugin_project_foundation_stage_missing");
  if (input.binding.actorId !== input.admission.actorId)
    foundationOwnerDenied();
  const result = captureProjectFoundationRuntimeAdmission({
    foundationAdmission: raw,
    stageAdmission: input.stageAdmission,
    admission: input.admission,
    context: {
      identity: {
        pluginId: input.binding.pluginId,
        version: input.admission.version,
        packageDigest: input.admission.packageDigest,
      },
      scope: {
        tenantId: input.binding.tenantId,
        spaceId: input.binding.spaceId,
        profileId: input.admission.profileId,
      },
      run: {
        runId: input.binding.runId,
        threadId: input.binding.threadId,
        bindingDigest: input.binding.bindingDigest,
        inputDigest: input.binding.inputDigest,
        source: input.binding.source,
      },
    },
  });
  if (required !== result.contentDigest)
    throw new Error("installed_plugin_project_foundation_scope_mismatch");
  return result;
}

/** Only the original context reader calls this after its activation/installation/actor PDP. */
export async function readFoundationForVerifiedRuntimeContext(
  input: Readonly<{
    foundations: ProjectFoundationRunAdmissionStore | undefined;
    admission: PluginTaskAdmission;
    binding: ExtensionRunBinding;
    stageAdmission: ProjectStageRunAdmission | null;
    requestKind: "direct" | "query";
    signal: AbortSignal;
    observation?: PluginProjectRuntimeObservation;
  }>,
) {
  if (input.foundations === undefined) return null;
  const result = await readProjectFoundationRuntimeScope({
    ...input,
    foundations: input.foundations,
  });
  if (
    result !== null &&
    (input.requestKind === "query" ||
      input.stageAdmission === null ||
      result.workspaceId !== input.stageAdmission.workspaceId)
  )
    throw new Error("installed_plugin_project_foundation_mismatch");
  return result;
}
