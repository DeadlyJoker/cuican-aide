import type { ReactNode } from "react";
import type { PluginUiSurface } from "@crewon/contracts/plugins";
import type { CommandWorkspaceHostModule } from "../../components/app/CommandWorkspaceHostModule";
import type {
  ControlPluginUiCatalog,
  ControlPluginUiModule,
} from "../plugins/controlPluginUiCatalog";
import {
  pluginUiPageSourceKey,
  type PluginUiPage,
  type PluginUiPageSnapshot,
  PluginUiPageNavigation,
} from "../plugins/pluginUiPageNavigation";

export type InstalledPluginSurfaceRenderState = Readonly<{
  active: boolean;
  visible: boolean;
  surface: PluginUiSurface;
  page: PluginUiPage | null;
}>;
/** Declared contributions and actual local page instances use one renderer, never another chat or management service. */
export function installedPluginSurfaceModules(
  input: Readonly<{
    catalog: ControlPluginUiCatalog;
    pages: PluginUiPageSnapshot;
    navigation: PluginUiPageNavigation;
    conversationThreads?: ReadonlyMap<string, readonly string[]>;
    startProjectConversation?(
      module: ControlPluginUiModule,
      input: Readonly<{ content: string; modelId?: string }>,
    ): Promise<void>;
    projectCreationDraft?(
      module: ControlPluginUiModule,
    ): Readonly<{ content: string; modelId?: string }> | undefined;
    render(
      module: ControlPluginUiModule,
      state: InstalledPluginSurfaceRenderState,
    ): ReactNode;
  }>,
): readonly CommandWorkspaceHostModule[] {
  const groups = new Map<string, readonly ControlPluginUiModule[]>();
  for (const module of input.catalog.modules) {
    const key = module.plugin.descriptor.pluginId;
    groups.set(key, [...(groups.get(key) ?? []), module]);
  }
  const build = (
    module: ControlPluginUiModule,
    page: PluginUiPage | null,
  ): CommandWorkspaceHostModule => {
    const group = groups.get(module.plugin.descriptor.pluginId)!;
    const sidebar = group.find((item) => item.surfaces?.includes("sidebar"));
    const routeId = page?.routeId ?? module.key;
    const context = page?.context;
    const conversationProjectId =
      module.plugin.descriptor.requires.some(
        (requirement) => requirement.service === "crewon.project-conversations",
      ) &&
      context &&
      typeof context === "object" &&
      !Array.isArray(context) &&
      "projectId" in context &&
      typeof context.projectId === "string"
        ? context.projectId
        : undefined;
    return Object.freeze({
      id: routeId,
      label: page?.title ?? module.title,
      icon: module.icon,
      pluginId: module.plugin.descriptor.pluginId,
      conversationThreadIds:
        input.conversationThreads?.get(module.plugin.descriptor.pluginId) ?? [],
      navigationLabel: group[0]!.title,
      ...(conversationProjectId === undefined ? {} : { conversationProjectId }),
      ...(page
        ? {
            pageId: page.pageId,
            pageContext: page.context,
            closePage: () => input.navigation.closeFromHost(page.pageId),
            activatePage: () => input.navigation.activateFromHost(page.pageId),
          }
        : {}),
      ...(conversationProjectId === undefined &&
      input.startProjectConversation &&
      [
        "crewon.project-foundation",
        "crewon.project-conversations",
        "crewon.project-workspace-target",
      ].every((service) =>
        module.plugin.descriptor.requires.some(
          (r) => r.service === service && r.apiVersion === "1",
        ),
      )
        ? {
            projectCreationDraft: input.projectCreationDraft?.(module),
            startProjectConversation: (
              request: Readonly<{ content: string; modelId?: string }>,
            ) => input.startProjectConversation!(module, request),
          }
        : {}),
      createPage: () => input.navigation.openFromHost(module.key),
      ...(!page
        ? { activatePage: () => input.navigation.openHomeFromHost(module.key) }
        : {}),
      ...(sidebar
        ? {
            sidebarContent: ({ active }: Readonly<{ active: boolean }>) =>
              input.render(sidebar, {
                active,
                visible: active,
                surface: "sidebar",
                page,
              }),
          }
        : {}),
      content: ({ active }: Readonly<{ active: boolean }>) =>
        input.render(module, {
          active: page !== null || active,
          visible: active,
          surface: "workbench",
          page,
        }),
    });
  };
  const bases = input.catalog.modules.map((module) =>
    build(
      module,
      input.pages.pages.find(
        (page) =>
          page.home &&
          page.moduleKey === module.key &&
          page.sourceKey === pluginUiPageSourceKey(module),
      ) ?? null,
    ),
  );
  const instances = input.pages.pages.flatMap((page) => {
    if (page.home) return [];
    const module = input.catalog.modules.find(
      (item) =>
        item.key === page.moduleKey &&
        pluginUiPageSourceKey(item) === page.sourceKey,
    );
    return module ? [build(module, page)] : [];
  });
  return Object.freeze([...bases, ...instances]);
}
