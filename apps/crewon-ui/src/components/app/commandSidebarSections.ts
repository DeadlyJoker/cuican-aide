import type { CommandShellView } from "./commandWorkspaceState";

export type CommandSidebarSection =
  | "work"
  | "assist"
  | "schedule"
  | "resources";

export function commandSidebarSection(
  view: CommandShellView,
): CommandSidebarSection {
  switch (view) {
    case "command":
    case "projects":
      return "work";
    case "assist":
      return "assist";
    case "schedule":
      return "schedule";
    case "agents":
    case "team":
    case "knowledge":
      return "resources";
  }
}

export function commandSidebarHasContext(view: CommandShellView): boolean {
  const section = commandSidebarSection(view);
  return section === "work" || section === "resources";
}
