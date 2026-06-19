import type { Thread } from "@crewon-protocol/v2/Thread";

import type { AppView } from "./appRouting";
import { appViewFromSearch, settingsSectionFromSearch } from "./appRouting";
import { getDemoThreads } from "../demo/demoData";
import type { Locale } from "../i18n";
import type { SettingsSection } from "../settings/settingsCatalog";
export {
  backendThreadId,
  isDemoThreadId,
  previewAwareBackendThreadId,
} from "../thread/threadIds";

export function getInitialSidebarOpen(): boolean {
  return window.innerWidth > 860;
}

export function shouldAutoCloseSidebar(): boolean {
  return window.innerWidth <= 860;
}

export function shouldAutoCloseInspector(
  sidebarOpen: boolean,
  rightSidebarOpen: boolean,
): boolean {
  const sidebarWidth = sidebarOpen ? 240 : 0;
  const rightSidebarWidth = rightSidebarOpen
    ? Math.max(320, window.innerWidth * 0.38)
    : 0;
  return window.innerWidth - sidebarWidth - rightSidebarWidth < 760;
}

export function shouldUseDemoPreview(): boolean {
  return new URLSearchParams(window.location.search).get("demoItems") === "1";
}

export function getInitialAppView(): AppView {
  return appViewFromSearch(window.location.search);
}

export function getInitialSettingsSection(): SettingsSection {
  return settingsSectionFromSearch(window.location.search);
}

export function localizeSeedDemoThreads(
  currentThreads: Thread[],
  locale: Locale,
): Thread[] {
  const seedThreads = getDemoThreads(locale);
  const seedThreadById = new Map(
    seedThreads.map((thread) => [thread.id, thread]),
  );
  return currentThreads.map(
    (thread) => seedThreadById.get(thread.id) ?? thread,
  );
}
