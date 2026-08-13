import type { ControlApiClient } from "@crewon/control-client";
import { useMemo } from "react";

import { createControlWorkflowAdapter } from "../workflow/controlWorkflowAdapter";

export function useControlWorkflowAdapter(client: ControlApiClient) {
  return useMemo(() => createControlWorkflowAdapter(client), [client]);
}
