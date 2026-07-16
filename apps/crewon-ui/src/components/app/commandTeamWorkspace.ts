const teamWorkspaceCwdSearchParam = "teamCwd";

export function commandTeamWorkspaceCwdFromSearch(
  search: string,
  fallbackCwd: string,
): string {
  const searchParams = new URLSearchParams(search);
  const teamCwd = searchParams.get(teamWorkspaceCwdSearchParam)?.trim();
  if (teamCwd) {
    return teamCwd;
  }
  if (searchParams.has("cwd")) {
    return searchParams.get("cwd")?.trim() || "";
  }
  return fallbackCwd.trim();
}

export function initialCommandTeamWorkspaceCwd(fallbackCwd: string): string {
  return commandTeamWorkspaceCwdFromSearch(
    typeof window === "undefined" ? "" : window.location.search,
    fallbackCwd,
  );
}

export function commandTeamWorkspaceUrl(
  currentHref: string,
  workspaceCwd: string,
): string {
  const nextUrl = new URL(currentHref);
  nextUrl.searchParams.set(teamWorkspaceCwdSearchParam, workspaceCwd.trim());
  return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
}

export function persistCommandTeamWorkspaceCwd(workspaceCwd: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.history.replaceState(
    null,
    "",
    commandTeamWorkspaceUrl(window.location.href, workspaceCwd),
  );
}
