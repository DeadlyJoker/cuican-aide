import type { CommandShellView } from "./commandWorkspaceState";

const shellViewIds: readonly CommandShellView[] = [
  "command",
  "assist",
  "agents",
  "knowledge",
  "team",
];

type LibraryHashKind = "agents" | "knowledge";
type LibraryOpenHandler = (kind: LibraryHashKind) => void | Promise<void>;
type RouteWindow = Pick<
  Window,
  "addEventListener" | "history" | "location" | "removeEventListener"
>;

function requestedShellView(hash: string): CommandShellView {
  const value = hash.replace(/^#view-/, "");
  return shellViewIds.includes(value as CommandShellView)
    ? (value as CommandShellView)
    : "command";
}

export function commandLibraryKindForView(
  view: CommandShellView,
): LibraryHashKind | null {
  return view === "agents" || view === "knowledge" ? view : null;
}

export function commandShellViewFromHash(hash: string): CommandShellView {
  const requestedView = requestedShellView(hash);
  return commandLibraryKindForView(requestedView) === null
    ? requestedView
    : "command";
}

export function openControlLibraryFromCommandShell(
  routeWindow: Pick<Window, "history" | "location">,
  setActiveView: (view: CommandShellView) => void,
  libraryKind: LibraryHashKind,
  onOpenLibrary?: LibraryOpenHandler,
): void {
  setActiveView("command");
  routeWindow.history.replaceState(
    null,
    "",
    `${routeWindow.location.pathname}${routeWindow.location.search}#view-command`,
  );
  void onOpenLibrary?.(libraryKind);
}

/**
 * Redirects legacy command-shell catalog hashes into the real Control Library.
 * The hash is replaced before opening so returning from the Library cannot
 * remount the removed placeholder route and reopen it in a loop.
 */
export function installCommandShellHashRouting(
  routeWindow: RouteWindow,
  setActiveView: (view: CommandShellView) => void,
  onOpenLibrary?: LibraryOpenHandler,
): () => void {
  const syncRoute = () => {
    const requestedView = requestedShellView(routeWindow.location.hash);
    const libraryKind = commandLibraryKindForView(requestedView);
    if (libraryKind !== null) {
      openControlLibraryFromCommandShell(
        routeWindow,
        setActiveView,
        libraryKind,
        onOpenLibrary,
      );
      return;
    }
    setActiveView(requestedView);
  };

  syncRoute();
  routeWindow.addEventListener("hashchange", syncRoute);
  routeWindow.addEventListener("popstate", syncRoute);
  return () => {
    routeWindow.removeEventListener("hashchange", syncRoute);
    routeWindow.removeEventListener("popstate", syncRoute);
  };
}
