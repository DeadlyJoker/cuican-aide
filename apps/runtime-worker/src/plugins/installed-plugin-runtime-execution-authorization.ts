import type { ActorContext, AuthorizationPort } from "@crewon/application";
import {
  extensionCanonicalJson,
  type ExtensionRunBinding,
  type PluginQueryTaskAdmission,
  type ExtensionActivation,
  type PluginSelection,
} from "@crewon/domain";
import type { PluginCompositionLock } from "@crewon/contracts/plugins";
import {
  assertInstalledPluginCompositionAuthority,
  type InstalledPluginCompositionAuthority,
} from "./installed-plugin-composition-authority.ts";
import { InstalledPluginRunContextError } from "./installed-plugin-run-context-error.ts";
function fail(code: string): never {
  throw new InstalledPluginRunContextError(code);
}
/** Original root activation/selection/actor PDP checks, reusable before paired startup metadata and before publication. */
export async function authorizeInstalledRuntimeExecution(
  input: Readonly<{
    binding: ExtensionRunBinding;
    query: PluginQueryTaskAdmission | null;
    composition: PluginCompositionLock | null;
    compositionAuthority: InstalledPluginCompositionAuthority | undefined;
    authorization: AuthorizationPort;
    activation(
      purpose: "submit" | "observe",
      signal: AbortSignal,
    ): Promise<ExtensionActivation>;
    selection(
      purpose: "submit" | "observe",
      signal: AbortSignal,
    ): Promise<PluginSelection>;
    actor(signal: AbortSignal): Promise<ActorContext>;
  }>,
  purpose: "submit" | "observe",
  signal: AbortSignal,
) {
  const { binding } = input;
  if (input.query !== null) purpose = "observe";
  assertInstalledPluginCompositionAuthority(
    input.compositionAuthority,
    input.composition,
    purpose,
  );
  const initial = await input.activation(purpose, signal);
  const selection = await input.selection(purpose, signal);
  const actor = await input.actor(signal);
  for (const request of [
    {
      actor,
      action: "run:execute" as const,
      resource: {
        kind: "run" as const,
        tenantId: binding.tenantId,
        spaceId: binding.spaceId,
        threadId: binding.threadId,
        runId: binding.runId,
      },
    },
    {
      actor,
      action:
        purpose === "submit"
          ? ("extension:run" as const)
          : ("extension:query" as const),
      resource: {
        kind: "extension" as const,
        tenantId: binding.tenantId,
        spaceId: binding.spaceId,
        pluginId: binding.pluginId,
      },
    },
  ]) {
    signal.throwIfAborted();
    const decision = await input.authorization.authorize(request);
    signal.throwIfAborted();
    const outcome = Object.getOwnPropertyDescriptor(decision, "outcome");
    if (
      !outcome?.enumerable ||
      !Object.hasOwn(outcome, "value") ||
      outcome.value !== "allow"
    )
      fail("installed_plugin_execution_access_denied");
  }
  const latest = await input.activation(purpose, signal);
  if (extensionCanonicalJson(initial) !== extensionCanonicalJson(latest))
    fail("installed_plugin_activation_changed");
  const latestSelection = await input.selection(purpose, signal);
  if (
    extensionCanonicalJson(selection) !==
    extensionCanonicalJson(latestSelection)
  )
    fail("installed_plugin_selection_changed");
  const currentActor = await input.actor(signal);
  if (extensionCanonicalJson(currentActor) !== extensionCanonicalJson(actor))
    fail("installed_plugin_execution_identity_unavailable");
  assertInstalledPluginCompositionAuthority(
    input.compositionAuthority,
    input.composition,
    purpose,
  );
  return actor;
}
