import {
  createPluginCreativeProjectClient,
  createPluginProjectGenerationClient,
  createPluginProjectGenerationQueryClient,
  createPluginProjectGenerationSelectionClient,
  parseProjectGenerationSelectionHostContext,
  type ProjectGenerationSelectionHostContext,
  parseProjectGenerationQueryHostContext,
  type ProjectGenerationQueryHostContext,
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
import { PluginWriteActivity } from "./workbench/PluginWriteActivity";
import { createGenerationRecordReadClient } from "./workbench/GenerationRecordReadClient";
import { createPluginProjectTextUiClient } from "./project-texts-ui-service";
import { projectTextsUiCodec } from "./project-texts-ui-codec.mjs";
import { ProjectTextController } from "./workbench/ProjectTextController";

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

function queryContext(
  data: PluginUiProps["data"],
): ProjectGenerationQueryHostContext | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(
    data,
    "projectGenerationQueryContext",
  );
  if (!descriptor || !("value" in descriptor)) return null;
  try {
    return parseProjectGenerationQueryHostContext(descriptor.value);
  } catch {
    return null;
  }
}

function selectionContext(
  data: PluginUiProps["data"],
): ProjectGenerationSelectionHostContext | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(
    data,
    "projectGenerationSelectionContext",
  );
  if (!descriptor || !("value" in descriptor)) return null;
  try {
    return parseProjectGenerationSelectionHostContext(descriptor.value);
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
    let controller: CreativeProjectController | null = null;
    let texts: ProjectTextController | null = null;
    const writes = new PluginWriteActivity(services, () => {
      controller?.refreshWriteActivity();
      texts?.refreshWriteActivity();
    });
    const clients = writes.services;
    controller = preview
      ? null
      : new CreativeProjectController({
          projects: createPluginCreativeProjectClient(clients),
          generations: createGenerationRecordReadClient(clients),
          submissions: createPluginProjectGenerationClient(clients),
          contexts: createPluginProjectGenerationContextClient(clients),
          queries: createPluginProjectGenerationQueryClient(clients),
          selections: createPluginProjectGenerationSelectionClient(clients),
          physicalWritesPending: () => writes.pending,
        });
    texts = preview
      ? null
      : new ProjectTextController({
          client: createPluginProjectTextUiClient(clients, projectTextsUiCodec),
          projects: createPluginCreativeProjectClient(clients),
          physicalWritesPending: () => writes.pending,
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
      const ready = dataFlag(next.data, "pluginUiReady");
      texts?.setReady(ready);
      if (!ready) controller?.setReady(false);
      controller?.setRecoveryContexts({
        selection: selectionContext(next.data),
        generation: generationContext(next.data),
        query: queryContext(next.data),
      });
      if (ready) controller?.setReady(true);
      flushSync(() =>
        reactRoot.render(
          controller && texts ? (
            <ShortDramaPersistentWorkbench
              controller={controller}
              texts={texts}
            />
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
      writes.dispose();
      controller?.dispose();
      texts?.dispose();
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
        writes.dispose();
        controller?.dispose();
        texts?.dispose();
        try {
          flushSync(() => reactRoot.unmount());
        } finally {
          owner.remove();
        }
      },
    };
  },
});
