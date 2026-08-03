const teamWorkspaceCwdSearchParam = "teamCwd";

/**
 * The team page used to track its own workspace, persisted as `?teamCwd=`.
 * The workspace now has a single source of truth (the sidebar), so this
 * parameter is read once from old links and then dropped.
 */
export function legacyCommandTeamWorkspaceCwdFromSearch(
  search: string,
): string {
  return (
    new URLSearchParams(search).get(teamWorkspaceCwdSearchParam)?.trim() || ""
  );
}

export function legacyCommandTeamWorkspaceCwd(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return legacyCommandTeamWorkspaceCwdFromSearch(window.location.search);
}

export function commandTeamWorkspaceUrlWithoutLegacyCwd(
  currentHref: string,
): string {
  const nextUrl = new URL(currentHref);
  nextUrl.searchParams.delete(teamWorkspaceCwdSearchParam);
  return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
}

export function clearLegacyCommandTeamWorkspaceCwd(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.history.replaceState(
    null,
    "",
    commandTeamWorkspaceUrlWithoutLegacyCwd(window.location.href),
  );
}
