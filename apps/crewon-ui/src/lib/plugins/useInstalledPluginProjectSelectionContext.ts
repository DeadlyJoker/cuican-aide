import { useLayoutEffect, useReducer } from "react";
import {
  CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION,
  CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE,
  PROJECT_GENERATION_SELECTION_HOST_CONTEXT_VERSION,
  parseProjectGenerationSelectionHostContext,
  type ProjectGenerationSelectionHostContext,
} from "@crewon/contracts/plugins";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import type { ControlPluginUiModule } from "./controlPluginUiCatalog";
import {
  installedPluginProjectSelectionPinsMatch,
  type InstalledPluginProjectSelectionJournal,
} from "./installedPluginProjectSelectionJournal";

export type InstalledPluginProjectSelectionPorts = Readonly<{
  journal: InstalledPluginProjectSelectionJournal;
  assertSessionCurrent(): void;
}>;
const EMPTY = parseProjectGenerationSelectionHostContext({
  version: PROJECT_GENERATION_SELECTION_HOST_CONTEXT_VERSION,
  intent: null,
});

/** Recovery only. A plugin reads the durable current pointer through its authenticated SDK client. */
export function useInstalledPluginProjectSelectionContext({
  ports,
  module,
  active,
}: Readonly<{
  ports: InstalledPluginProjectSelectionPorts | null;
  module: ControlPluginUiModule;
  active: boolean;
}>): Readonly<{ context: ProjectGenerationSelectionHostContext }> {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const enabled =
    active &&
    ports !== null &&
    module.plugin.descriptor.requires.some(
      (item) =>
        item.service === CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE &&
        item.apiVersion === CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION,
    );
  useLayoutEffect(() => {
    if (!enabled || !ports) return;
    try {
      ports.assertSessionCurrent();
      ports.journal.assertCurrent();
    } catch {
      return;
    }
    const unsubscribe = ports.journal.subscribe(refresh);
    const invalidate = () => {
      ports.journal.invalidate();
      refresh();
    };
    window.addEventListener(AGENT_PLATFORM_SESSION_CHANGED_EVENT, invalidate);
    return () => {
      unsubscribe();
      window.removeEventListener(
        AGENT_PLATFORM_SESSION_CHANGED_EVENT,
        invalidate,
      );
    };
  }, [enabled, ports]);
  if (!enabled || !ports) return { context: EMPTY };
  try {
    ports.assertSessionCurrent();
    ports.journal.assertCurrent();
    const values = ports.journal
      .snapshot()
      .filter((item) => item.familyKey === module.key);
    const intent =
      values.find(
        (item) => item.phase === "pending" || item.phase === "uncertain",
      ) ?? values[0];
    if (!intent) return { context: EMPTY };
    const samePackage = installedPluginProjectSelectionPinsMatch(
      intent.sourcePin,
      {
        pluginId: module.plugin.descriptor.pluginId,
        publisherId: module.plugin.descriptor.publisherId,
        version: module.plugin.descriptor.version,
        packageDigest: module.plugin.packageDigest,
        selectionRevision: module.plugin.selectionRevision,
        contributionId: module.contributionId,
      },
    );
    return {
      context: parseProjectGenerationSelectionHostContext({
        version: PROJECT_GENERATION_SELECTION_HOST_CONTEXT_VERSION,
        intent: {
          request: intent.input,
          phase: intent.phase,
          retryable: intent.retryable && samePackage,
          receipt: intent.receipt,
        },
      }),
    };
  } catch {
    return { context: EMPTY };
  }
}
