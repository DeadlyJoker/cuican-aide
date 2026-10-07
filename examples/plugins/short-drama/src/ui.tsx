import { ProjectMediaOutputController } from "./workbench/ProjectMediaOutputController";
import {
  createPluginMediaResultClient,
  createPluginMediaResultActionClient,
} from "./project-media-results-service";
import { ProjectMediaResultController } from "./workbench/ProjectMediaResultController";
import { ProjectMediaGenerationController } from "./workbench/ProjectMediaGenerationController";
import { createMediaGenerationClient } from "./project-media-generations-service";
import { mediaGenerationCodec } from "./project-media-generations-codec.mjs";
import { createPluginMediaInputUiClient } from "./project-media-inputs-ui-client";
import { projectMediaInputsUiCodec } from "./project-media-inputs-ui-codec.mjs";
import { ProjectMediaInputController } from "./workbench/ProjectMediaInputController";
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
import { createPluginProjectTextRecoveryClient } from "./project-text-recovery-service";
import { projectTextRecoveryCodec } from "./project-text-recovery-codec.mjs";
import { createPluginProjectConversationsClient } from "./project-conversations-service";
import { projectConversationsCodec } from "./project-conversations-codec.mjs";
import {
  ProjectConversationController,
  type CreationWorkspace,
} from "./workbench/ProjectConversationController";
import { createPluginProjectTextPlansClient } from "./project-text-plans-service";
import { projectTextPlansCodec } from "./project-text-plans-codec.mjs";
import { ProjectTextPlanController } from "./workbench/ProjectTextPlanController";
import { parseProjectPlanningProposal } from "./project-planning-codec.mjs";
import type { ProjectPlanningProposal } from "./project-planning-service";
import { createAssociationClient } from "./project-conversation-association-service";
import * as associationCodec from "./project-conversation-association-codec.mjs";
import { ProjectConversationAssociationController } from "./workbench/ProjectConversationAssociationController";

import { createPluginProjectHistoricalQueryClient } from "./project-historical-query-ui-client";
import {
  projectHistoricalQueryCodec,
  parseProjectHistoricalQueryHostContext,
} from "./project-historical-query-codec.mjs";
import type { ProjectHistoricalQueryHostContext } from "./plugin-project-historical-queries-service";
import { createPluginProjectAssetUiClient } from "./project-assets-service";
import { projectAssetsUiCodec } from "./project-assets-codec.mjs";
import { ProjectAssetController } from "./workbench/ProjectAssetController";
import { createPluginProjectAssetRecoveryClient } from "./project-asset-recovery-service";
import { projectAssetRecoveryCodec } from "./project-asset-recovery-codec.mjs";

const contributionId = "workbench";
function historicalQueryContext(
  data: PluginUiProps["data"],
): ProjectHistoricalQueryHostContext | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const context = Object.getOwnPropertyDescriptor(
    data,
    "projectHistoricalQueryHostContext",
  )?.value;
  if (context === undefined) return null;
  try {
    return parseProjectHistoricalQueryHostContext(context);
  } catch {
    return null;
  }
}
function planningDraft(
  data: PluginUiProps["data"],
): ProjectPlanningProposal | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = Object.getOwnPropertyDescriptor(
    data,
    "projectPlanningDraft",
  )?.value;
  if (value === undefined) return null;
  try {
    return parseProjectPlanningProposal(value);
  } catch {
    return null;
  }
}

function creationWorkspace(
  data: PluginUiProps["data"],
): CreationWorkspace | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const context = Object.getOwnPropertyDescriptor(
    data,
    "projectConversationContext",
  )?.value;
  if (!context || typeof context !== "object" || Array.isArray(context))
    return null;
  const id = Object.getOwnPropertyDescriptor(
    context,
    "creationWorkspaceId",
  )?.value;
  if (
    id !== null &&
    (typeof id !== "string" ||
      !id ||
      id.length > 256 ||
      /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(id))
  )
    return null;
  const label = Object.getOwnPropertyDescriptor(
    context,
    "creationWorkspaceName",
  )?.value;
  return {
    workspaceId: id,
    name: typeof label === "string" && label.length <= 160 ? label : null,
  };
}

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
    let conversations: ProjectConversationController | null = null;
    let association: ProjectConversationAssociationController | null = null;
    let plans: ProjectTextPlanController | null = null;
    let assets: ProjectAssetController | null = null;
    let mediaOutputs: ProjectMediaOutputController | null = null;
    let mediaResults: ProjectMediaResultController | null = null;
    let mediaInputs: ProjectMediaInputController | null = null;
    let mediaGenerations: ProjectMediaGenerationController | null = null;
    const writes = new PluginWriteActivity(services, () => {
      controller?.refreshWriteActivity();
      texts?.refreshWriteActivity();
      conversations?.refreshWriteActivity();
      association?.refreshWriteActivity();
      plans?.refreshWriteActivity();
      assets?.refreshWriteActivity();
      mediaInputs?.refreshWriteActivity();
      mediaGenerations?.refreshWriteActivity();
      mediaOutputs?.refreshWriteActivity();
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
          historicalQueries: createPluginProjectHistoricalQueryClient(
            clients,
            projectHistoricalQueryCodec,
          ),
          sourcePluginId: "crewon.short-drama",
          selections: createPluginProjectGenerationSelectionClient(clients),
          physicalWritesPending: () => writes.pending,
        });
    texts = preview
      ? null
      : new ProjectTextController({
          client: createPluginProjectTextUiClient(clients, projectTextsUiCodec),
          projects: createPluginCreativeProjectClient(clients),
          physicalWritesPending: () => writes.pending,
          recovery: createPluginProjectTextRecoveryClient(
            clients,
            projectTextRecoveryCodec,
          ),
        });
    conversations = preview
      ? null
      : new ProjectConversationController({
          client: createPluginProjectConversationsClient(
            clients,
            projectConversationsCodec,
          ),
          physicalWritesPending: () => writes.pending,
        });
    plans = preview
      ? null
      : new ProjectTextPlanController({
          client: createPluginProjectTextPlansClient(
            clients,
            projectTextPlansCodec,
          ),
          physicalWritesPending: () => writes.pending,
        });
    association = preview
      ? null
      : new ProjectConversationAssociationController({
          client: createAssociationClient(clients, associationCodec),
          getBinding: createPluginProjectConversationsClient(
            clients,
            projectConversationsCodec,
          ).getBinding,
          physicalWritesPending: () => writes.pending,
        });
    /* Existing plan and asset controllers retain their own execution authority. */
    assets = preview
      ? null
      : new ProjectAssetController({
          client: createPluginProjectAssetUiClient(
            clients,
            projectAssetsUiCodec,
          ),
          texts: createPluginProjectTextUiClient(clients, projectTextsUiCodec),
          recovery: createPluginProjectAssetRecoveryClient(
            clients,
            projectAssetRecoveryCodec,
          ),
          physicalWritesPending: () => writes.pending,
        });
    mediaGenerations = preview
      ? null
      : new ProjectMediaGenerationController({
          client: createMediaGenerationClient(clients, mediaGenerationCodec),
          conversations: createPluginProjectConversationsClient(
            clients,
            projectConversationsCodec,
          ),
          physicalWritesPending: () => writes.pending,
        });
    mediaOutputs = preview
      ? null
      : new ProjectMediaOutputController(
          createPluginMediaResultActionClient(clients),
          () => writes.pending,
        );
    mediaResults = preview
      ? null
      : new ProjectMediaResultController(
          createPluginMediaResultClient(clients),
        );
    mediaInputs = preview
      ? null
      : new ProjectMediaInputController({
          client: createPluginMediaInputUiClient(
            clients,
            projectMediaInputsUiCodec,
          ),
          assets: createPluginProjectAssetUiClient(
            clients,
            projectAssetsUiCodec,
          ),
          texts: createPluginProjectTextUiClient(clients, projectTextsUiCodec),
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
      const associationThread =
        next.data && typeof next.data === "object" && !Array.isArray(next.data)
          ? Object.getOwnPropertyDescriptor(
              next.data,
              "projectConversationAssociationThreadId",
            )?.value
          : null;
      conversations?.setWorkspace(creationWorkspace(next.data));
      conversations?.setReady(ready);
      texts?.setReady(ready);
      plans?.setReady(ready);
      assets?.setReady(ready);
      mediaResults?.setReady(ready);
      mediaOutputs?.setReady(ready);
      mediaInputs?.setReady(ready);
      mediaGenerations?.setThread(generationContext(next.data)?.thread ?? null);
      mediaGenerations?.setReady(ready);
      if (!ready) controller?.setReady(false);
      controller?.setRecoveryContexts({
        selection: selectionContext(next.data),
        generation: generationContext(next.data),
        query: queryContext(next.data),
        historicalQuery: historicalQueryContext(next.data),
      });
      if (ready) controller?.setReady(true);
      flushSync(() =>
        reactRoot.render(
          controller && texts && conversations && plans ? (
            <ShortDramaPersistentWorkbench
              controller={controller}
              texts={texts}
              conversations={conversations}
              plans={plans}
              assets={assets ?? undefined}
              mediaResults={mediaResults ?? undefined}
              mediaOutputs={mediaOutputs ?? undefined}
              mediaInputs={mediaInputs ?? undefined}
              mediaGenerations={mediaGenerations ?? undefined}
              planningDraft={planningDraft(next.data)}
              association={association ?? undefined}
              associationReady={ready}
              associationThreadId={
                typeof associationThread === "string" &&
                associationThread.length <= 256
                  ? associationThread
                  : null
              }
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
      conversations?.dispose();
      association?.dispose();
      plans?.dispose();
      assets?.dispose();
      mediaResults?.dispose();
      mediaOutputs?.dispose();
      mediaInputs?.dispose();
      mediaGenerations?.dispose();
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
        conversations?.dispose();
        association?.dispose();
        plans?.dispose();
        assets?.dispose();
        mediaResults?.dispose();
        mediaOutputs?.dispose();
        mediaInputs?.dispose();
        mediaGenerations?.dispose();
        try {
          flushSync(() => reactRoot.unmount());
        } finally {
          owner.remove();
        }
      },
    };
  },
});
