import { useMemo } from "react";

import { createAppServerEventCoordinator } from "./appServerEventCoordinator";

export function useAppServerEventHandlerSet(
  params: Parameters<typeof createAppServerEventCoordinator>[0],
) {
  return useMemo(() => createAppServerEventCoordinator(params), []);
}
