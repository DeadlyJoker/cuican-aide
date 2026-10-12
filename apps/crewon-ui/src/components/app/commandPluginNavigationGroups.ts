import type { PluginNavigationIcon } from "@crewon/contracts/plugins";
import type { ReactNode } from "react";
export type CommandPluginNavigationItem = Readonly<{
  id: string;
  label: string;
  icon?: PluginNavigationIcon;
  pluginId?: string;
  navigationLabel?: string;
  sidebarContent?: ReactNode;
  active: boolean;
  onOpen(): void;
}>;
/** Page instances stay in the workbench; a package gets one global navigation entry. */
export function commandPluginNavigationGroups(
  items: readonly CommandPluginNavigationItem[],
): readonly CommandPluginNavigationItem[] {
  const groups = new Map<string, CommandPluginNavigationItem[]>();
  for (const item of items) {
    const key = item.pluginId ?? item.id;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].map((group) => {
    const active = group.find((item) => item.active);
    const item = active ?? group[0]!;
    return {
      ...item,
      label: group[0]!.navigationLabel ?? group[0]!.label,
      active: !!active,
    };
  });
}
