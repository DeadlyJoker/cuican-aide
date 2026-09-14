import type { ControlApiClient } from "@crewon/control-client";
import type { SettingsCatalogState } from "./controlSettingsPanels";

/** A read belongs to one visible page; late results never update another page. */
export async function readControlSettingsCatalog(params: {
  client: Pick<ControlApiClient, "getActiveAgentVersionCatalog">;
  signal: AbortSignal;
  onState: (state: SettingsCatalogState) => void;
}): Promise<void> {
  const { client, signal, onState } = params;
  if (signal.aborted) return;
  onState({ status: "loading" });
  try {
    const catalog = await client.getActiveAgentVersionCatalog({ signal });
    if (signal.aborted) return;
    if (
      catalog.data.filter(
        (item) => item.agentVersionId === catalog.defaultAgentVersionId,
      ).length !== 1
    ) {
      onState({ status: "error" });
      return;
    }
    onState({ status: "ready", catalog });
  } catch {
    if (!signal.aborted) onState({ status: "error" });
  }
}
