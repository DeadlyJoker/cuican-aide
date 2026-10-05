import { createHash } from "node:crypto";
import type { ProjectConversationStore } from "@crewon/application";
import {
  extensionCanonicalJson,
  parseProjectStageRunAdmission,
  type ProjectStageRunAdmission,
  type PluginTaskAdmission,
  type ExtensionRunBinding,
} from "@crewon/domain";
const digester = {
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
};
export async function readProjectStageRuntimeScope(
  input: Readonly<{
    conversations: Pick<
      ProjectConversationStore,
      "loadStageAdmission" | "readRequiredStageDigest"
    >;
    admission: PluginTaskAdmission;
    binding: ExtensionRunBinding;
    signal: AbortSignal;
  }>,
): Promise<ProjectStageRunAdmission | null> {
  input.signal.throwIfAborted();
  const locator = {
    tenantId: input.binding.tenantId,
    spaceId: input.binding.spaceId,
    runId: input.binding.runId,
  };
  const required = await input.conversations.readRequiredStageDigest(locator),
    raw = await input.conversations.loadStageAdmission(locator);
  input.signal.throwIfAborted();
  if (raw === null) {
    if (required !== null)
      throw new Error("installed_plugin_project_stage_missing");
    return null;
  }
  const s = parseProjectStageRunAdmission(raw, digester),
    a = input.admission,
    b = input.binding;
  if (
    required !== s.contentDigest ||
    s.runId !== a.runId ||
    s.threadId !== a.threadId ||
    s.extensionBindingDigest !== b.bindingDigest ||
    s.userContentDigest !== b.inputDigest ||
    s.requestDigest !== a.requestDigest ||
    s.idempotencyKey !== a.idempotencyKey ||
    s.pluginTaskAdmissionDigest !==
      digester.sha256(extensionCanonicalJson(a)) ||
    b.source !== null ||
    a.action !== "project.execute" ||
    Object.keys(s.installation).some(
      (k) =>
        s.installation[k as keyof typeof s.installation] !==
        a[k as keyof typeof a],
    ) ||
    Object.keys(s.actor).some(
      (k) => s.actor[k as keyof typeof s.actor] !== a[k as keyof typeof a],
    )
  )
    throw new Error("installed_plugin_project_stage_mismatch");
  return s;
}
