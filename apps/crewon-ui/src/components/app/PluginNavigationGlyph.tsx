import {
  BookOpen,
  Film,
  Folder,
  Image,
  LayoutGrid,
  Puzzle,
} from "lucide-react";
import type { PluginNavigationIcon } from "@crewon/contracts/plugins";

/** Installed metadata selects a host-owned glyph; it cannot inject markup or remote content. */
export function PluginNavigationGlyph({
  icon = "book-open",
}: Readonly<{ icon?: PluginNavigationIcon }>) {
  const icons = {
    "book-open": BookOpen,
    "film": Film,
    "image": Image,
    "folder": Folder,
    "layout": LayoutGrid,
    "puzzle": Puzzle,
  } satisfies Record<PluginNavigationIcon, typeof BookOpen>;
  const Icon = icons[icon];
  return <Icon aria-hidden="true" />;
}
