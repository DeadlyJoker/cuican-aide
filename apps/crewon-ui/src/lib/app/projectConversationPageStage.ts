import type { PublicProjectConversationBinding } from "@crewon/contracts/project-conversations";

export type PluginConversationPage = Readonly<{
  pluginId: string;
  context: unknown;
}>;
/** Navigation is a preference. Only the actual selected conversation binding identifies the project. */
export function projectConversationPageStage(
  page: PluginConversationPage | null | undefined,
  binding: PublicProjectConversationBinding | null,
) {
  if (
    !page ||
    !binding ||
    page.pluginId !== "crewon.short-drama" ||
    binding.source.pluginId !== page.pluginId
  )
    return null;
  const context = page.context;
  if (!context || typeof context !== "object" || Array.isArray(context))
    return null;
  const value = context as Record<string, unknown>;
  if (value.projectId !== binding.projectId || typeof value.stage !== "string")
    return null;
  switch (value.stage) {
    case "overview":
      return { kind: "discussion" as const, label: "创作方案" };
    case "source":
      return { kind: "discussion" as const, label: "小说原文" };
    case "concepts":
      return { kind: "discussion" as const, label: "概念图" };
    case "outline":
      return { kind: "outline" as const, label: "改编大纲" };
    case "script":
      return { kind: "script" as const, label: "分集剧本" };
    case "characters":
      return {
        kind: "assets" as const,
        label: "角色",
        assetKind: "character" as const,
      };
    case "art":
      return {
        kind: "assets" as const,
        label: "美术",
        assetKind: "scene" as const,
      };
    case "references":
      return { kind: "media-input" as const, label: "画面探索" };
    default:
      return null;
  }
}
