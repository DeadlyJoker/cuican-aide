import type { CapabilityPanelItemActionParams } from "../../capability/capabilityPanelItemActions";
import type { ConfirmHandler } from "../../shared/confirmHandler";
import { handleCapabilityPanelItemAction } from "../../capability/capabilityPanelItemActions";
import type { CapabilityPanelActionDispatcherParams } from "../../capability/capabilityPanelActionDispatcher";
import { handleCapabilityPanelActionDispatch } from "../../capability/capabilityPanelActionDispatcher";
import {
  openPluginPathFromPanelAction,
  updateCapabilityPanelFieldAction,
} from "../../capability/appCapabilityPanelActions";
import {
  backendThreadId,
  previewAwareBackendThreadId,
} from "../appUiState";
import { trimmedPanelFieldValue } from "../../shared/panelState";

type AppCapabilityPanelActionParams = Omit<
  CapabilityPanelActionDispatcherParams,
  | "actionId"
  | "confirm"
  | "fieldValue"
  | "openPluginPath"
  | "previewAwareThreadId"
  | "threadId"
>;

type AppCapabilityPanelItemParams = Pick<
  CapabilityPanelItemActionParams,
  | "setComposerFocusSignal"
  | "setComposerValue"
  | "setPendingComposerMentions"
  | "setPendingContextFile"
>;

type AppCapabilityPanelClient =
  NonNullable<AppCapabilityPanelActionParams["client"]> &
    NonNullable<CapabilityPanelItemActionParams["client"]>;

export type AppCapabilityPanelHandlers = {
  handleCapabilityPanelAction: (actionId: string) => void;
  handleCapabilityPanelFieldChange: (fieldId: string, value: string) => void;
  handleCapabilityPanelItem: (
    item: CapabilityPanelItemActionParams["item"],
  ) => Promise<void>;
};

export type AppCapabilityPanelHandlersParams = Omit<
  AppCapabilityPanelActionParams,
  "client"
> &
  AppCapabilityPanelItemParams & {
    client: AppCapabilityPanelClient | null | undefined;
    confirm: ConfirmHandler;
    setLibraryPanel: Parameters<
      typeof updateCapabilityPanelFieldAction
    >[0]["setLibraryPanel"];
  };

export function createAppCapabilityPanelHandlers(
  params: AppCapabilityPanelHandlersParams,
): AppCapabilityPanelHandlers {
  const handleCapabilityPanelItem = async (
    item: CapabilityPanelItemActionParams["item"],
  ) => {
    await handleCapabilityPanelItemAction({
      busyToolId: params.busyToolId,
      client: params.client,
      confirm: params.confirm,
      isConnected: params.isConnected,
      isDemo: params.isDemo,
      item,
      locale: params.locale,
      setBusyToolId: params.setBusyToolId,
      setCapabilityPanel: params.setCapabilityPanel,
      setComposerFocusSignal: params.setComposerFocusSignal,
      setComposerValue: params.setComposerValue,
      setNotice: params.setNotice,
      setPendingComposerMentions: params.setPendingComposerMentions,
      setPendingContextFile: params.setPendingContextFile,
    });
  };

  return {
    handleCapabilityPanelAction: (actionId) => {
      handleCapabilityPanelActionDispatch({
        ...params,
        actionId,
        confirm: params.confirm,
        fieldValue: (fieldId) =>
          trimmedPanelFieldValue(params.capabilityPanel, fieldId),
        openPluginPath: (path) => {
          openPluginPathFromPanelAction({
            openCapabilityPanelItem: handleCapabilityPanelItem,
            path,
          });
        },
        previewAwareThreadId: previewAwareBackendThreadId(
          params.selectedThreadId,
          params.isDemoPreview,
        ),
        threadId: backendThreadId(params.selectedThreadId),
      });
    },
    handleCapabilityPanelFieldChange: (fieldId, value) => {
      updateCapabilityPanelFieldAction({
        fieldId,
        setCapabilityPanel: params.setCapabilityPanel,
        setLibraryPanel: params.setLibraryPanel,
        value,
      });
    },
    handleCapabilityPanelItem,
  };
}
