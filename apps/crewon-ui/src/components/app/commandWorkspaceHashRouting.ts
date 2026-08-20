import type { CommandShellView } from "./commandWorkspaceState";

const shellViewIds: readonly CommandShellView[] = [
  "command",
  "assist",
  "projects",
  "agents",
  "knowledge",
  "schedule",
  "team",
];

type LibraryHashKind = "agents" | "automation" | "knowledge";
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
  if (view === "schedule") return "automation";
  return view === "agents" || view === "knowledge" ? view : null;
}

export function commandShellViewFromHash(hash: string): CommandShellView {
  return requestedShellView(hash);
}

export function openControlLibraryFromCommandShell(
  routeWindow: Pick<Window, "history" | "location">,
  setActiveView: (view: CommandShellView) => void,
  libraryKind: LibraryHashKind,
  onOpenLibrary?: LibraryOpenHandler,
): void {
  const shellView = libraryKind === "automation" ? "schedule" : libraryKind;
  setActiveView(shellView);
  routeWindow.history.replaceState(
    null,
    "",
    `${routeWindow.location.pathname}${routeWindow.location.search}#view-${shellView}`,
  );
  void onOpenLibrary?.(libraryKind);
}

/**
 * Keeps catalog destinations inside the command shell while loading their
 * authoritative Control Library panels. This preserves the persistent task
 * navigation and workbench that existed before the runtime migration.
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
