import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppServerClient } from "../app-server/appServer";
import type { Locale } from "../i18n";

export type BackendWorkspace = {
  client: AppServerClient;
  cwd: string;
};

export type BackendThreadCwd = {
  cwd: string | null | undefined;
};

export type BackendWorkspaceParams<TFallback> = {
  client: AppServerClient | null | undefined;
  fallback: TFallback;
  resolveBackendCwd: () => Promise<string>;
  run: (workspace: BackendWorkspace) => Promise<TFallback>;
};

export type BackendDomainThreadSource = "agent" | "automation" | "office";

export function isPlaceholderBackendCwd(cwd: string | null | undefined): boolean {
  return Boolean(cwd?.includes("/Users/me/"));
}

export function localAppServerUnavailableMessage(locale: Locale): string {
  return locale === "zh"
    ? "未连接本地 app-server"
    : "Local app-server is not connected";
}

export function automationWorkspaceUnavailableMessage(locale: Locale): string {
  return locale === "zh"
    ? "创建自动化需要可用的后端工作区。"
    : "Creating an automation requires an available backend workspace.";
}

export function boundThreadWorkspaceUnavailableMessage(locale: Locale): string {
  return locale === "zh"
    ? "缺少后端工作区，无法创建绑定线程。"
    : "No backend workspace is available for the bound thread.";
}

export function requireAppServerClient(
  client: AppServerClient | null | undefined,
  locale: Locale,
): AppServerClient {
  if (!client) {
    throw new Error(localAppServerUnavailableMessage(locale));
  }
  return client;
}

export function preferredBackendCwd(
  currentCwd: string | null | undefined,
  backendThreads: BackendThreadCwd[],
): string {
  const trimmedCurrentCwd = currentCwd?.trim() ?? "";
  if (trimmedCurrentCwd && !isPlaceholderBackendCwd(trimmedCurrentCwd)) {
    return trimmedCurrentCwd;
  }

  return (
    backendThreads
      .map((thread) => thread.cwd)
      .find((threadCwd) => threadCwd && !isPlaceholderBackendCwd(threadCwd)) ??
    configuredBackendCwd() ??
    ""
  );
}

export function configuredBackendCwd(): string | null {
  const urlCwd =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("cwd")?.trim();
  if (urlCwd) {
    return urlCwd;
  }

  return import.meta.env.VITE_CREWON_DEFAULT_CWD?.trim() || null;
}

export async function resolvePreferredBackendCwd(params: {
  currentCwd: string | null | undefined;
  listThreads: () => Promise<BackendThreadCwd[]>;
}): Promise<string> {
  const trimmedCurrentCwd = params.currentCwd?.trim() ?? "";
  if (trimmedCurrentCwd && !isPlaceholderBackendCwd(trimmedCurrentCwd)) {
    return trimmedCurrentCwd;
  }

  return preferredBackendCwd(trimmedCurrentCwd, await params.listThreads());
}

export async function resolveBackendWorkspace(
  client: AppServerClient | null | undefined,
  resolveBackendCwd: () => Promise<string>,
): Promise<BackendWorkspace | null> {
  const cwd = await resolveBackendCwd();
  return cwd && client ? { client, cwd } : null;
}

export async function withBackendWorkspace<TFallback>({
  client,
  fallback,
  resolveBackendCwd,
  run,
}: BackendWorkspaceParams<TFallback>): Promise<TFallback> {
  const workspace = await resolveBackendWorkspace(client, resolveBackendCwd);
  return workspace ? run(workspace) : fallback;
}

export async function requireBackendWorkspace(params: {
  client: AppServerClient | null | undefined;
  errorMessage: string;
  resolveBackendCwd: () => Promise<string>;
}): Promise<BackendWorkspace> {
  const workspace = await resolveBackendWorkspace(
    params.client,
    params.resolveBackendCwd,
  );
  if (!workspace) {
    throw new Error(params.errorMessage);
  }
  return workspace;
}

export async function startBackendDomainThread(params: {
  client: AppServerClient | null | undefined;
  missingWorkspaceMessage: string;
  resolveBackendCwd: () => Promise<string>;
  threadSource: BackendDomainThreadSource;
}): Promise<Thread | null> {
  const cwd = await params.resolveBackendCwd();
  if (!cwd) {
    throw new Error(params.missingWorkspaceMessage);
  }
  return (await params.client?.startThread(cwd, params.threadSource)) ?? null;
}

export function createBackendWorkspaceAccess(params: {
  getClient: () => AppServerClient | null | undefined;
  locale: Locale;
  resolveBackendCwd: () => Promise<string>;
}): {
  optionalWorkspace: () => Promise<BackendWorkspace | null>;
  requireWorkspace: (errorMessage: string) => Promise<BackendWorkspace>;
  startDomainThread: (
    threadSource: BackendDomainThreadSource,
  ) => Promise<Thread | null>;
} {
  return {
    optionalWorkspace: () =>
      withBackendWorkspace({
        client: params.getClient(),
        fallback: null,
        resolveBackendCwd: params.resolveBackendCwd,
        run: async (workspace) => workspace,
      }),
    requireWorkspace: (errorMessage) =>
      requireBackendWorkspace({
        client: params.getClient(),
        errorMessage,
        resolveBackendCwd: params.resolveBackendCwd,
      }),
    startDomainThread: (threadSource) =>
      startBackendDomainThread({
        client: params.getClient(),
        missingWorkspaceMessage: boundThreadWorkspaceUnavailableMessage(
          params.locale,
        ),
        resolveBackendCwd: params.resolveBackendCwd,
        threadSource,
      }),
  };
}
