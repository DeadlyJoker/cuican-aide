import { useMemo } from "react";

import { createAppServerEventCoordinator } from "./appServerEventCoordinator";

export function useAppServerEventHandlerSet(
  params: Parameters<typeof createAppServerEventCoordinator>[0],
) {
  /*
   * The App Server connection is shared by the Control and legacy coding
   * scenes. Rebuild its notification handlers when scene authority changes so
   * a Code turn can consume its own turn/completed event instead of retaining
   * the Control scene's legacy-event filter forever.
   */
  return useMemo(
    () => createAppServerEventCoordinator(params),
    [params.controlThreadAuthority],
  );
}
