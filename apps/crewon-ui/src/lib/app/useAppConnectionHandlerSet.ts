import { useMemo } from "react";

import {
  createAppConnectionHandlers,
} from "./handlers/appConnectionHandlers";

export function useAppConnectionHandlerSet(
  params: Parameters<typeof createAppConnectionHandlers>[0],
) {
  return useMemo(() => createAppConnectionHandlers(params), []);
}
