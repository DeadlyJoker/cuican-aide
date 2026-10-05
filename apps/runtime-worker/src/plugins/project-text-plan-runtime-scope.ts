import { createHash } from "node:crypto";
import type { ProjectTextPlanStore } from "@crewon/application";
import {
  extensionCanonicalJson,
  parseProjectTextPlanRunAdmission,
  type ProjectTextPlanRunAdmission,
  type ProjectStageRunAdmission,
  type PluginTaskAdmission,
  type ExtensionRunBinding,
} from "@crewon/domain";
const digester = {
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
};
/** Independent immutable marker: a missing/corrupt plan can never become an ordinary Stage or legacy Run. */
export async function readProjectTextPlanRuntimeScope(
  input: Readonly<{
    plans: Pick<
      ProjectTextPlanStore,
      "readRequiredPlanDigest" | "loadRunAdmission"
    >;
    admission: PluginTaskAdmission;
    binding: ExtensionRunBinding;
    stage: ProjectStageRunAdmission | null;
    signal: AbortSignal;
  }>,
): Promise<ProjectTextPlanRunAdmission | null> {
  input.signal.throwIfAborted();
  const locator = {
    tenantId: input.binding.tenantId,
    spaceId: input.binding.spaceId,
    runId: input.binding.runId,
  };
  const required = await input.plans.readRequiredPlanDigest(locator),
    raw = await input.plans.loadRunAdmission(locator);
  input.signal.throwIfAborted();
  if (raw === null) {
    if (required !== null)
      throw new Error("installed_plugin_project_text_plan_missing");
    return null;
  }
  const p = parseProjectTextPlanRunAdmission(raw, digester),
    s = input.stage,
    b = input.binding,
    a = input.admission;
  if (
    required !== p.contentDigest ||
    s === null ||
    b.source !== null ||
    a.action !== "project.execute" ||
    p.stageAdmissionDigest !== s.contentDigest ||
    p.extensionBindingDigest !== b.bindingDigest ||
    p.inputDigest !== b.inputDigest ||
    p.configurationRevision !== b.configurationRevision ||
    p.configurationDigest !== b.configurationDigest ||
    p.idempotencyKey !== a.idempotencyKey ||
    p.kind !== s.stage.kind ||
    p.episodeId !== (s.stage.kind === "script" ? s.stage.episodeId : null) ||
    extensionCanonicalJson(p.actor) !== extensionCanonicalJson(s.actor) ||
    extensionCanonicalJson(p.installation) !==
      extensionCanonicalJson(s.installation) ||
    extensionCanonicalJson(p.sources) !== extensionCanonicalJson(s.sources)
  )
    throw new Error("installed_plugin_project_text_plan_mismatch");
  for (const key of [
    "runId",
    "threadId",
    "projectId",
    "bindingId",
    "bindingRevision",
    "workspaceId",
  ] as const)
    if (p[key] !== s[key])
      throw new Error("installed_plugin_project_text_plan_mismatch");
  const expectedKey = `plugin-task:${digester.sha256(extensionCanonicalJson([p.actor.tenantId, p.actor.spaceId, p.installation.profileId, p.actor.principalId, p.actor.actorId, p.installation.pluginId, p.taskIdempotencyKey])).slice(7)}`;
  if (p.idempotencyKey !== expectedKey)
    throw new Error("installed_plugin_project_text_plan_mismatch");
  return p;
}
