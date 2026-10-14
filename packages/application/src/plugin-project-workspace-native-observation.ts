import {
  parseDesktopNativeProjectWorkspaceResponse,
  type DesktopNativeProjectWorkspaceResponse,
} from "@crewon/contracts/plugins";
import { ApplicationError } from "./application-error.ts";
import {
  qualifyPluginProjectWorkspacePreparation,
  type PluginProjectWorkspacePreparation,
} from "./plugin-project-workspace-preparation.ts";
export type PluginProjectWorkspaceNativeObservation = Readonly<{
  version: "crewon.plugin-project-workspace-native-observation.v1";
}>;
type Source = Readonly<{
  preparation: PluginProjectWorkspacePreparation;
  assertProducerActive(): void;
  expiresAt: number;
}>;
const references = new WeakMap<object, Source>();
/** Trusted Host producer. No plugin SDK/UI/HTTP entrypoint; the Control client must first verify its actual parent response. */
export function issuePluginProjectWorkspaceNativeObservation(
  preparation: PluginProjectWorkspacePreparation,
  input: DesktopNativeProjectWorkspaceResponse,
  assertProducerActive: () => void,
): PluginProjectWorkspaceNativeObservation {
  const source = qualifyPluginProjectWorkspacePreparation(preparation);
  assertProducerActive();
  const response = parseDesktopNativeProjectWorkspaceResponse(input);
  if (
    response.outcome !== "observed" ||
    response.allocation.workspaceId !== source.expectedWorkspaceId ||
    response.allocation.phase !== "registered" ||
    response.allocation.observation !== "registered" ||
    response.allocation.failureCode !== null
  )
    unavailable();
  const reference = Object.freeze({
    version: "crewon.plugin-project-workspace-native-observation.v1" as const,
  });
  references.set(
    reference,
    Object.freeze({
      preparation,
      assertProducerActive,
      expiresAt: Date.now() + 5000,
    }),
  );
  return reference;
}
/** Trusted in-process Host producer. The callback observes the actual shared allocator; no Desktop IPC response is synthesized. */
export function issuePluginProjectWorkspaceHostObservation(
  preparation: PluginProjectWorkspacePreparation,
  inspectAllocation: () => Readonly<{
    workspaceId: string;
    phase: string;
    observation: string;
    failureCode: string | null;
  }>,
  assertProducerActive: () => void,
): PluginProjectWorkspaceNativeObservation {
  const source = qualifyPluginProjectWorkspacePreparation(preparation);
  const active = () => {
    assertProducerActive();
    source.assertActive();
    const allocation = inspectAllocation();
    if (
      allocation.workspaceId !== source.expectedWorkspaceId ||
      allocation.phase !== "registered" ||
      allocation.observation !== "registered" ||
      allocation.failureCode !== null
    )
      unavailable();
  };
  active();
  const reference = Object.freeze({
    version: "crewon.plugin-project-workspace-native-observation.v1" as const,
  });
  references.set(
    reference,
    Object.freeze({
      preparation,
      assertProducerActive: active,
      expiresAt: Date.now() + 5000,
    }),
  );
  return reference;
}

/** Original Store consumer. Detached response JSON cannot mint this reference. */
export function qualifyPluginProjectWorkspaceNativeObservation(
  reference: PluginProjectWorkspaceNativeObservation,
) {
  const captured =
    reference !== null && typeof reference === "object"
      ? references.get(reference)
      : undefined;
  if (captured === undefined) unavailable();
  const q = qualifyPluginProjectWorkspacePreparation(captured.preparation);
  const active = () => {
    if (Date.now() >= captured.expiresAt) unavailable();
    captured.assertProducerActive();
    q.assertActive();
  };
  active();
  return Object.freeze({
    ...q,
    assertActive: active,
    assertCurrent: async () => {
      active();
      await q.assertCurrent();
      active();
    },
  });
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_workspace_native_observation_unavailable",
  );
}
