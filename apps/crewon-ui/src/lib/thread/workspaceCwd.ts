export type ThreadWorkspaceCwd = {
  cwd: string | null | undefined;
};

export function isPlaceholderBackendCwd(
  cwd: string | null | undefined,
): boolean {
  return Boolean(cwd?.includes("/Users/me/"));
}

export function preferredBackendCwd(
  currentCwd: string | null | undefined,
  backendThreads: ThreadWorkspaceCwd[],
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
