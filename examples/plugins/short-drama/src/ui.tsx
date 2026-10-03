import {
  createPluginCreativeProjectClient,
  createPluginProjectGenerationReadClient,
  createPluginProjectGenerationClient,
  createPluginProjectGenerationContextClient,
  parseProjectGenerationHostContext,
  type ProjectGenerationHostContext,
  defineUiPlugin,
  type PluginUiProps,
} from "@crewon/plugin-sdk/ui";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ShortDramaWorkbenchPreview } from "./workbench/ShortDramaWorkbenchPreview";
import stylesheet from "./workbench/ShortDramaWorkbenchPreview.css";
import referenceImage from "./assets/crewon-krea2-reference.png";
import { CreativeProjectController } from "./workbench/creative-project-controller";
import { ShortDramaPersistentWorkbench } from "./workbench/ShortDramaPersistentWorkbench";

const contributionId = "workbench";

function assertContribution(props: PluginUiProps) {
  if (
    props.schemaVersion !== "crewon.plugin-ui-props.v1" ||
    props.contributionId !== contributionId
  )
    throw new Error("short_drama_ui_contribution_invalid");
}

function dataFlag(data: PluginUiProps["data"], name: string): boolean {
  return (
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Object.getOwnPropertyDescriptor(data, name)?.value === true
  );
}
function generationContext(
  data: PluginUiProps["data"],
): ProjectGenerationHostContext | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(
    data,
    "projectGenerationContext",
  );
  if (!descriptor || !("value" in descriptor)) return null;
  try {
    return parseProjectGenerationHostContext(descriptor.value);
  } catch {
    return null;
  }
}

/** Owns only this module's DOM. The shell, account and theme authority stay with CrewON. */
export default defineUiPlugin({
  apiVersion: "crewon.plugin-ui.v1",
  pluginId: "crewon.short-drama",
  mount(root, props, services) {
    assertContribution(props);
    const owner = root.ownerDocument.createElement("div");
    owner.dataset.shortDramaPlugin = "";
    const style = root.ownerDocument.createElement("style");
    style.textContent = stylesheet;
    const content = root.ownerDocument.createElement("div");
    for (const element of [owner, content])
      Object.assign(element.style, {
        width: "100%",
        height: "100%",
        minWidth: "0",
        minHeight: "0",
      });
    owner.append(style, content);
    root.append(owner);
    const reactRoot = createRoot(content);
    const preview = dataFlag(props.data, "shortDramaPreview");
    const controller = preview
      ? null
      : new CreativeProjectController({
          projects: createPluginCreativeProjectClient(services),
          generations: createPluginProjectGenerationReadClient(services),
          submissions: createPluginProjectGenerationClient(services),
          contexts: createPluginProjectGenerationContextClient(services),
        });
    let disposed = false;
    let appliedTokens: string[] = [];
    function update(next: PluginUiProps) {
      if (disposed) throw new Error("short_drama_ui_disposed");
      assertContribution(next);
      const tokens = Object.entries(next.theme.tokens);
      if (
        !["light", "dark"].includes(next.theme.mode) ||
        tokens.some(
          ([name, value]) =>
            !/^--[a-z][a-z0-9-]*$/u.test(name) || typeof value !== "string",
        )
      )
        throw new Error("short_drama_ui_theme_token_invalid");
      for (const name of appliedTokens) owner.style.removeProperty(name);
      appliedTokens = [];
      for (const [name, value] of tokens) {
        owner.style.setProperty(name, value);
        appliedTokens.push(name);
      }
      owner.dataset.theme = next.theme.mode;
      owner.style.colorScheme = next.theme.mode;
      controller?.setGenerationContext(generationContext(next.data));
      controller?.setReady(dataFlag(next.data, "pluginUiReady"));
      flushSync(() =>
        reactRoot.render(
          controller ? (
            <ShortDramaPersistentWorkbench controller={controller} />
          ) : (
            <ShortDramaWorkbenchPreview
              referenceImage={new URL(referenceImage, import.meta.url).href}
            />
          ),
        ),
      );
    }
    try {
      update(props);
    } catch (error) {
      controller?.dispose();
      try {
        flushSync(() => reactRoot.unmount());
      } finally {
        owner.remove();
      }
      throw error;
    }
    return {
      update,
      dispose() {
        if (disposed) return;
        disposed = true;
        controller?.dispose();
        try {
          flushSync(() => reactRoot.unmount());
        } finally {
          owner.remove();
        }
      },
    };
  },
});
