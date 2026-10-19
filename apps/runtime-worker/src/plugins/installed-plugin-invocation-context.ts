import type { ContextHistoryItem } from "@crewon/context";
import type { PluginTaskAdmission, RunState } from "@crewon/domain";
import { InstalledPluginRuntimeError } from "./installed-plugin-run-runtime.ts";

/** Stable per-Run host facts; never replaces history or supplies dispatch authority. */
export function installedPluginInvocationContext(
  run: RunState,
  admission: PluginTaskAdmission,
): readonly ContextHistoryItem[] {
  if (
    admission.runId !== run.runId ||
    admission.threadId !== run.threadId ||
    admission.tenantId !== run.tenantId ||
    admission.spaceId !== run.spaceId ||
    admission.actorId !== run.createdByActorId
  )
    throw new InstalledPluginRuntimeError(
      "installed_plugin_invocation_context_mismatch",
    );
  if (
    admission.action !== "image.generate" &&
    admission.action !== "image.query"
  )
    return [];
  const identity = JSON.stringify({
    schemaVersion: "crewon.installed-plugin-invocation-context.v1",
    runId: run.runId,
    action: admission.action,
    requestDigest: admission.requestDigest,
  });
  const instruction =
    admission.action === "image.generate"
      ? "The host admitted this distinct generation request through an explicit plugin action. Execute this Run's frozen input using its approved tools. Unknown operations from earlier Runs do not cancel or revoke this request. Check this Run's own durable execution receipts: if it already submitted an operation, only observe that operation; never submit it again. Do not ask the user to authorize this already-admitted request again. Report generation only when actual tool evidence confirms it."
      : "The host admitted a read-only query of the original operation for this Run. Observe only the source operation pinned by the runtime. Never submit a generation or substitute another operation. Report only actual tool evidence.";
  return Object.freeze([
    Object.freeze({
      type: "message" as const,
      role: "developer" as const,
      content: identity + "\n" + instruction,
    }),
  ]);
}
