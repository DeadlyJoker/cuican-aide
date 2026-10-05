import {
  CREWON_PROJECT_HISTORICAL_QUERIES_API_VERSION,
  CREWON_PROJECT_HISTORICAL_QUERIES_SERVICE,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import type { PluginUiActionContext } from "@crewon/application";
import type { PluginTaskAdmissionPin } from "@crewon/domain";
import {
  bridgeFailure,
  bridgeFields,
} from "./plugin-task-action-bridge-support.ts";

export function assertPluginProjectHistoricalQuerySource(
  context: PluginUiActionContext,
  pin: PluginTaskAdmissionPin,
): void {
  if (
    !context.lease.descriptor.requires.some(
      (requirement) =>
        requirement.service === CREWON_PROJECT_HISTORICAL_QUERIES_SERVICE &&
        requirement.apiVersion ===
          CREWON_PROJECT_HISTORICAL_QUERIES_API_VERSION,
    ) ||
    !context.lease.descriptor.contributions.some(
      (contribution) =>
        contribution.id === pin.contributionId &&
        contribution.kind === "module" &&
        contribution.slot === "main.content",
    )
  )
    bridgeFailure("plugin_project_generation_query_source_unsupported");
}
