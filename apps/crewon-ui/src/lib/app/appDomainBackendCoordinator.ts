import type { AppServerClient } from "../app-server/appServer";
import {
  createBackendWorkspaceAccess,
} from "../backend/backendWorkspace";
import type { Locale } from "../i18n";
import {
  createAppDomainBackendHandlers,
} from "./handlers/appDomainBackendHandlers";

type AppDomainBackendCoordinatorParams = {
  client: AppServerClient | null;
  currentCwd: string;
  isConnected: boolean;
  isDemoPreview: boolean;
  locale: Locale;
  platformResourcesEnabled: boolean;
  selectedThreadId: string | null;
  threads: Parameters<typeof createAppDomainBackendHandlers>[0]["threads"];
};

export function createAppDomainBackendCoordinator(
  params: AppDomainBackendCoordinatorParams,
) {
  const domainBackend = createAppDomainBackendHandlers(params);
  const backendWorkspaceAccess = createBackendWorkspaceAccess({
    getClient: () => params.client,
    locale: params.locale,
    resolveBackendCwd: domainBackend.resolveBackendCwd,
  });

  return {
    ...domainBackend,
    optionalBackendWorkspace: backendWorkspaceAccess.optionalWorkspace,
    requireBackendWorkspace: backendWorkspaceAccess.requireWorkspace,
    startBackendDomainThread: backendWorkspaceAccess.startDomainThread,
  };
}
