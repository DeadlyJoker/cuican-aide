import {
  parsePluginUiLease,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import { uiFailure } from "./pluginUiValidation";

/** Only observed account-owned intent state is shared. Each action retains its own source and grant. */
export function assertInstalledPluginQueryLaneAvailable(
  input: PluginUiLease,
  other:
    | Readonly<{
        snapshot(): readonly Readonly<{ familyKey: string; phase: string }>[];
      }>
    | undefined,
): void {
  const lease = parsePluginUiLease(input);
  const familyKey = JSON.stringify([
    lease.descriptor.pluginId,
    lease.contributionId,
  ]);
  if (
    other
      ?.snapshot()
      .some(
        (intent) =>
          intent.familyKey === familyKey &&
          (intent.phase === "pending" || intent.phase === "uncertain"),
      )
  )
    uiFailure("plugin_ui_query_lane_unresolved");
}
