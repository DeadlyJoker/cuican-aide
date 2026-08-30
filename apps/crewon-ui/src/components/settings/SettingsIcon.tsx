import {
  AppWindow,
  Bot,
  Cable,
  GitBranch,
  Globe,
  Keyboard,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { SettingsIconKey } from "../../lib/settings/settingsCatalog";

const icons: Record<SettingsIconKey, LucideIcon> = {
  "app-window": AppWindow,
  "bot": Bot,
  "cable": Cable,
  "git-branch": GitBranch,
  "globe": Globe,
  "keyboard": Keyboard,
  "palette": Palette,
  "shield-check": ShieldCheck,
  "sliders-horizontal": SlidersHorizontal,
  "sparkles": Sparkles,
  "terminal-square": TerminalSquare,
};

export function SettingsIcon({
  icon,
  size = 16,
}: {
  icon: SettingsIconKey;
  size?: number;
}) {
  const Icon = icons[icon];
  return <Icon aria-hidden="true" size={size} />;
}
