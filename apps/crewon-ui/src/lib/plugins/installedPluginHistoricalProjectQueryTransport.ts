import { assertInstalledPluginQueryLaneAvailable } from "./installedPluginQueryLaneAvailability";
import type { InstalledPluginProjectQueryJournal } from "./installedPluginProjectQueryJournal";
import {
  parseProjectHistoricalQueryUiActionRequest,
  type ProjectHistoricalQueryUiAction,
} from "@crewon/contracts/project-historical-queries";
import type {
  PluginUiJsonValue,
  PluginUiLease,
} from "@crewon/contracts/plugins";
import type { ControlApiClient } from "@crewon/control-client";
import {
  assertPluginUiCurrent,
  type PluginUiCurrentScope,
} from "./controlPluginUiSupport";
import type { InstalledPluginProjectHistoricalQueryJournal } from "./installedPluginProjectHistoricalQueryJournal";
import { uiFailure } from "./pluginUiValidation";

/** This actual mounted invocation is independent of the frozen SDK query and recovery lanes. */
export async function invokeInstalledPluginHistoricalProjectQuery(
  ports: Readonly<{
    client: ControlApiClient;
    assertCurrent: PluginUiCurrentScope;
    journal: InstalledPluginProjectHistoricalQueryJournal | undefined;
    otherJournal: InstalledPluginProjectQueryJournal | undefined;
  }>,
  lease: PluginUiLease,
  input: Readonly<{ action: string; input: unknown; signal: AbortSignal }>,
): Promise<PluginUiJsonValue> {
  if (!ports.journal)
    uiFailure("plugin_ui_project_historical_query_journal_unavailable");
  assertInstalledPluginQueryLaneAvailable(lease, ports.otherJournal);
  const request = parseProjectHistoricalQueryUiActionRequest({
    action: input.action as ProjectHistoricalQueryUiAction,
    input: input.input,
  });
  const response = await ports.journal.invoke({
    lease,
    input: request.input,
    signal: input.signal,
    assertCurrent: ports.assertCurrent,
    request: (signal) =>
      ports.client.plugins.invoke(lease.mountRef, request, { signal }),
  });
  assertPluginUiCurrent(ports.assertCurrent, input.signal);
  return response.output;
}
