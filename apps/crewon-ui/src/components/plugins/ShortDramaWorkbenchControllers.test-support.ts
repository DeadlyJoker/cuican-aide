import { vi } from "vitest";
import {
  createPluginCreativeProjectClient,
  type PluginCreativeProjectClient,
  type PluginUiServices,
} from "@crewon/plugin-sdk/ui";

type AuxiliaryController = {
  setReady(ready: boolean): void;
  dispose(): void;
};
export type ShortDramaWorkbenchDependencies = {
  texts: AuxiliaryController;
  conversations: AuxiliaryController;
  plans: AuxiliaryController;
};
type PublicClientFactory = (
  services: PluginUiServices,
  codec: unknown,
) => unknown;
const pluginSourceDirectory = new URL(
  "../../../../../examples/plugins/short-drama/src/",
  import.meta.url,
).pathname;
const moduleUrl = (name: string) => `${pluginSourceDirectory}/${name}`;

// Load the independent plugin's actual controllers and portable protocols, as ui.tsx does.
// Its own TypeScript project checks these APIs; the host keeps source files out of its build.
const { ProjectTextController } = await vi.importActual<{
  ProjectTextController: new (ports: {
    client: unknown;
    projects: PluginCreativeProjectClient;
    recovery: unknown;
  }) => AuxiliaryController;
}>(moduleUrl("workbench/ProjectTextController.ts"));
const { ProjectConversationController } = await vi.importActual<{
  ProjectConversationController: new (ports: {
    client: unknown;
    physicalWritesPending(): boolean;
  }) => AuxiliaryController;
}>(moduleUrl("workbench/ProjectConversationController.ts"));
const { ProjectTextPlanController } = await vi.importActual<{
  ProjectTextPlanController: new (ports: {
    client: unknown;
    physicalWritesPending(): boolean;
  }) => AuxiliaryController;
}>(moduleUrl("workbench/ProjectTextPlanController.ts"));
const { createPluginProjectTextUiClient } = await vi.importActual<{
  createPluginProjectTextUiClient: PublicClientFactory;
}>(moduleUrl("project-texts-ui-service.ts"));
const { createPluginProjectTextRecoveryClient } = await vi.importActual<{
  createPluginProjectTextRecoveryClient: PublicClientFactory;
}>(moduleUrl("project-text-recovery-service.ts"));
const { createPluginProjectConversationsClient } = await vi.importActual<{
  createPluginProjectConversationsClient: PublicClientFactory;
}>(moduleUrl("project-conversations-service.ts"));
const { createPluginProjectTextPlansClient } = await vi.importActual<{
  createPluginProjectTextPlansClient: PublicClientFactory;
}>(moduleUrl("project-text-plans-service.ts"));
const { projectTextsUiCodec } = await vi.importActual<{
  projectTextsUiCodec: unknown;
}>(moduleUrl("project-texts-ui-codec.mjs"));
const { projectTextRecoveryCodec } = await vi.importActual<{
  projectTextRecoveryCodec: unknown;
}>(moduleUrl("project-text-recovery-codec.mjs"));
const { projectConversationsCodec } = await vi.importActual<{
  projectConversationsCodec: unknown;
}>(moduleUrl("project-conversations-codec.mjs"));
const { projectTextPlansCodec } = await vi.importActual<{
  projectTextPlansCodec: unknown;
}>(moduleUrl("project-text-plans-codec.mjs"));

/** Empty ancillary public records come from the existing metadata dispatcher fixture. */
export function shortDramaWorkbenchDependencies(services: PluginUiServices) {
  const controllers: ShortDramaWorkbenchDependencies = {
    texts: new ProjectTextController({
      client: createPluginProjectTextUiClient(services, projectTextsUiCodec),
      projects: createPluginCreativeProjectClient(services),
      recovery: createPluginProjectTextRecoveryClient(
        services,
        projectTextRecoveryCodec,
      ),
    }),
    conversations: new ProjectConversationController({
      client: createPluginProjectConversationsClient(
        services,
        projectConversationsCodec,
      ),
      physicalWritesPending: () => false,
    }),
    plans: new ProjectTextPlanController({
      client: createPluginProjectTextPlansClient(
        services,
        projectTextPlansCodec,
      ),
      physicalWritesPending: () => false,
    }),
  };
  return {
    ...controllers,
    setReady(ready: boolean) {
      for (const controller of Object.values(controllers))
        controller.setReady(ready);
    },
    dispose() {
      for (const controller of Object.values(controllers)) controller.dispose();
    },
  };
}
