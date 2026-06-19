import type { AppServerClient } from "../app-server/appServer";
import {
  createAppLibraryOpenHandlers,
} from "./handlers/appLibraryOpenHandlers";

type LibraryLoadRequestRef = {
  current: number;
};

type LibraryOpenHandlerParams = Parameters<
  typeof createAppLibraryOpenHandlers
>[0];

export type AppLibraryOpenCoordinatorParams = Omit<
  LibraryOpenHandlerParams,
  "beginLibraryLoad" | "client" | "markLibraryLoad" | "setThreadGoal"
> & {
  getClient: () => AppServerClient | null;
  libraryLoadRequestRef: LibraryLoadRequestRef;
};

export function createAppLibraryOpenCoordinator(
  params: AppLibraryOpenCoordinatorParams,
) {
  return createAppLibraryOpenHandlers({
    ...params,
    beginLibraryLoad: () => {
      const requestId = params.libraryLoadRequestRef.current + 1;
      params.libraryLoadRequestRef.current = requestId;
      return () => params.libraryLoadRequestRef.current === requestId;
    },
    client: params.getClient(),
    markLibraryLoad: () => {
      params.libraryLoadRequestRef.current += 1;
    },
    setThreadGoal: async (threadId, goal, tokenBudget) => {
      await params.getClient()?.setThreadGoal(threadId, goal, tokenBudget ?? null);
    },
  });
}
