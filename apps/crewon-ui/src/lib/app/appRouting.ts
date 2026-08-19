import type { LibraryKind } from "../domain/crewonDomain";
import type { AppView } from "../shared/appView";
import type { SettingsSection } from "../settings/settingsCatalog";

export type { AppView } from "../shared/appView";

const commandShellViews = new Set([
  "command",
  "assist",
  "projects",
  "agents",
  "knowledge",
  "schedule",
  "team",
]);

export function isCommandShellHash(hash: string): boolean {
  const view = hash.replace(/^#view-/, "");
  return view !== hash && commandShellViews.has(view);
}

export function shouldRenderCommandShellView(appView: AppView): boolean {
  return appView === "chat";
}

export function libraryViewFromSearch(search: string): LibraryKind | null {
  const view = new URLSearchParams(search).get("view");

  switch (view) {
    case "tools":
      return "tools";
    case "agents":
      return "agents";
    case "automation":
      return "automation";
    case "knowledge":
      return "knowledge";
    default:
      return null;
  }
}

export function appViewFromSearch(search: string): AppView {
  const view = new URLSearchParams(search).get("view");
  if (view === "settings") {
    return "settings";
  }
  if (libraryViewFromSearch(search)) {
    return "library";
  }
  return "chat";
}

export function settingsSectionFromSearch(search: string): SettingsSection {
  const section = new URLSearchParams(search).get("section");
  switch (section) {
    case "account":
    case "appearance":
    case "app-snapshots":
    case "browser":
    case "computer-control":
    case "config":
    case "connections":
    case "environment":
    case "git":
    case "hooks":
    case "keyboard":
    case "mcp-servers":
    case "model-providers":
    case "personalization":
    case "worktrees":
      return section;
    default:
      return "appearance";
  }
}
