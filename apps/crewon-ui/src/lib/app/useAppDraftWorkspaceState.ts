import { useEffect, useState } from "react";

export function draftWorkspaceCwdFromSearch(
  search: string,
): string | null | undefined {
  const searchParams = new URLSearchParams(search);
  if (!searchParams.has("cwd")) {
    return undefined;
  }
  return searchParams.get("cwd")?.trim() || null;
}

export function useAppDraftWorkspaceState(
  onRouteWorkspaceChange?: (cwd: string | null | undefined) => void,
) {
  const [draftWorkspaceCwd, setDraftWorkspaceCwd] = useState<
    string | null | undefined
  >(() =>
    typeof window === "undefined"
      ? undefined
      : draftWorkspaceCwdFromSearch(window.location.search),
  );

  useEffect(() => {
    const syncWorkspaceFromUrl = () => {
      const nextCwd = draftWorkspaceCwdFromSearch(window.location.search);
      if (nextCwd !== draftWorkspaceCwd) {
        onRouteWorkspaceChange?.(nextCwd);
        setDraftWorkspaceCwd(nextCwd);
      }
    };
    window.addEventListener("popstate", syncWorkspaceFromUrl);
    return () => window.removeEventListener("popstate", syncWorkspaceFromUrl);
  }, [draftWorkspaceCwd, onRouteWorkspaceChange]);

  return {
    draftWorkspaceCwd,
    setDraftWorkspaceCwd,
  };
}
