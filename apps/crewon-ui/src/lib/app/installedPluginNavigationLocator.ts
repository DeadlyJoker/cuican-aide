import type { CommandWorkspaceHostModule } from "../../components/app/CommandWorkspaceHostModule";

export const PLUGIN_PROJECT_NAVIGATION_STAGES = [
  "overview",
  "source",
  "outline",
  "script",
  "characters",
  "art",
  "concepts",
  "references",
] as const;
export type InstalledPluginNavigationLocator = Readonly<{
  pluginId: string;
  projectId?: string;
  stage?: (typeof PLUGIN_PROJECT_NAVIGATION_STAGES)[number];
}>;
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function stage(
  value: unknown,
): value is InstalledPluginNavigationLocator["stage"] {
  return (
    typeof value === "string" &&
    PLUGIN_PROJECT_NAVIGATION_STAGES.some((item) => item === value)
  );
}
export function installedPluginNavigationLocator(
  module: CommandWorkspaceHostModule,
): InstalledPluginNavigationLocator | null {
  if (!text(module.pluginId)) return null;
  const context = module.pageContext;
  const projectId = module.conversationProjectId;
  const preferred =
    context &&
    typeof context === "object" &&
    !Array.isArray(context) &&
    "stage" in context
      ? context.stage
      : undefined;
  return Object.freeze({
    pluginId: module.pluginId,
    ...(text(projectId)
      ? { projectId, ...(stage(preferred) ? { stage: preferred } : {}) }
      : {}),
  });
}
function key(accountId: string) {
  return `crewon.plugin-navigation.v1:${encodeURIComponent(accountId)}`;
}
export function hasInstalledPluginNavigationLocator(
  accountId: string,
): boolean {
  try {
    return window.sessionStorage.getItem(key(accountId)) !== null;
  } catch {
    return false;
  }
}
/** Account-scoped presentation only. No mount refs, package authority, history, token or credential is stored. */
export function readInstalledPluginNavigationLocator(
  accountId: string,
): InstalledPluginNavigationLocator | null {
  try {
    const raw = window.sessionStorage.getItem(key(accountId));
    if (!raw || raw.length > 2048) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const v = value as Record<string, unknown>;
    if (
      Object.keys(v).some(
        (field) => !["pluginId", "projectId", "stage"].includes(field),
      ) ||
      !text(v.pluginId) ||
      (v.projectId !== undefined && !text(v.projectId)) ||
      (v.stage !== undefined && (!text(v.projectId) || !stage(v.stage)))
    )
      return null;
    return Object.freeze({
      pluginId: v.pluginId,
      ...(text(v.projectId)
        ? {
            projectId: v.projectId,
            ...(stage(v.stage) ? { stage: v.stage } : {}),
          }
        : {}),
    });
  } catch {
    return null;
  }
}
export function persistInstalledPluginNavigationLocator(
  accountId: string,
  locator: InstalledPluginNavigationLocator | null,
): void {
  try {
    // Explicit ordinary navigation must survive refresh; absence is reserved for an older client with no saved choice.
    window.sessionStorage.setItem(key(accountId), JSON.stringify(locator));
  } catch {
    /* Navigation continues when browser storage is unavailable. */
  }
}
